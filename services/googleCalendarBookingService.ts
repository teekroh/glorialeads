import { parse as chronoParse } from "chrono-node";
import { formatInTimeZone } from "date-fns-tz";
import { google } from "googleapis";
import { JWT } from "google-auth-library";
import { googleCalendarConfig, isGoogleCalendarConfigured } from "@/config/googleCalendarConfig";
import { getEffectiveOutreachDryRun } from "@/services/outreachDryRunService";
import type { Lead as DbLead } from "@prisma/client";

export type SuggestedTimeAutoResult =
  | { handled: false; reason: string }
  | {
      handled: true;
      mode: "google_calendar";
      meetingStart: Date;
      meetingEnd: Date;
      eventId: string;
      replyText: string;
    }
  | { handled: true; mode: "fallback_cal_link"; replyText: string };

function weekdayNameInTz(d: Date, tz: string): string {
  return formatInTimeZone(d, tz, "EEEE");
}

function hourInTz(d: Date, tz: string): number {
  return Number(formatInTimeZone(d, tz, "H"));
}

/** Mon–Fri, 09:00–16:59 local (last 15m block starts 16:45). */
function isBusinessSlotStart(d: Date, tz: string, slotMinutes: number): boolean {
  const wd = weekdayNameInTz(d, tz);
  if (wd === "Saturday" || wd === "Sunday") return false;
  const h = hourInTz(d, tz);
  const m = Number(formatInTimeZone(d, tz, "m"));
  if (h < 9) return false;
  if (h > 16) return false;
  if (h === 16 && m + slotMinutes > 60) return false;
  return true;
}

function overlapsBusy(start: Date, end: Date, busy: { start?: string | null; end?: string | null }[]): boolean {
  for (const b of busy) {
    if (!b.start || !b.end) continue;
    const bs = new Date(b.start);
    const be = new Date(b.end);
    if (bs < end && be > start) return true;
  }
  return false;
}

function parseCredentialJson(): { client_email: string; private_key: string } | null {
  try {
    const j = JSON.parse(googleCalendarConfig.credentialsJson) as { client_email?: string; private_key?: string };
    if (!j.client_email || !j.private_key) return null;
    return { client_email: j.client_email, private_key: j.private_key };
  } catch {
    return null;
  }
}

export async function getGoogleCalendarApiClient() {
  const creds = parseCredentialJson();
  if (!creds) throw new Error("Invalid GOOGLE_CALENDAR_CREDENTIALS_JSON");

  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events"
    ],
    subject: googleCalendarConfig.impersonateUser || undefined
  });

  return google.calendar({ version: "v3", auth: jwt });
}

/**
 * Candidate start times from natural language (e.g. "Thursday 2:30 or 3:00").
 */
export function extractSuggestedSlotStarts(bodyText: string, referenceDate: Date, tz: string, maxCandidates: number): Date[] {
  const results = chronoParse(bodyText, referenceDate, { forwardDate: true });
  const seen = new Set<number>();
  const out: Date[] = [];
  for (const r of results) {
    const d = r.start?.date();
    if (!d) continue;
    const t = d.getTime();
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(d);
    if (out.length >= maxCandidates) break;
  }
  const now = Date.now();
  return out.filter((d) => d.getTime() > now - 60_000);
}

export async function tryAutoBookSuggestedTime(params: {
  lead: DbLead;
  bodyText: string;
  receivedAt: Date;
  firstNameFallback: string;
}): Promise<SuggestedTimeAutoResult> {
  const { lead, bodyText, receivedAt, firstNameFallback } = params;
  const tz = googleCalendarConfig.businessTimezone;
  const slotMin = googleCalendarConfig.slotMinutes;
  const name = firstNameFallback || "there";

  const dryRun = await getEffectiveOutreachDryRun();
  const googleReady = isGoogleCalendarConfigured() && !dryRun;

  if (!googleReady) {
    return { handled: false, reason: "google_calendar_not_configured_or_dry_run" };
  }

  const candidates = extractSuggestedSlotStarts(bodyText, receivedAt, tz, 8).filter((d) => isBusinessSlotStart(d, tz, slotMin));

  if (!candidates.length) {
    return { handled: false, reason: "no_parseable_business_slots" };
  }

  let calendar;
  try {
    calendar = await getGoogleCalendarApiClient();
  } catch (e) {
    return { handled: false, reason: `calendar_auth_failed:${e instanceof Error ? e.message : String(e)}` };
  }

  const calId = googleCalendarConfig.calendarId;

  for (const start of candidates) {
    const end = new Date(start.getTime() + slotMin * 60_000);

    try {
      const fb = await calendar.freebusy.query({
        requestBody: {
          timeMin: new Date(start.getTime() - 60_000).toISOString(),
          timeMax: new Date(end.getTime() + 60_000).toISOString(),
          items: [{ id: calId }]
        }
      });

      const busy = fb.data.calendars?.[calId]?.busy ?? [];
      if (overlapsBusy(start, end, busy)) continue;

      const startWall = formatInTimeZone(start, tz, "yyyy-MM-dd'T'HH:mm:ss");
      const endWall = formatInTimeZone(end, tz, "yyyy-MM-dd'T'HH:mm:ss");

      const insert = await calendar.events.insert({
        calendarId: calId,
        sendUpdates: "all",
        requestBody: {
          summary: `Intro · ${lead.fullName}`,
          description: `Gloria outreach — ${lead.email}\nLead ID: ${lead.id}`,
          start: { dateTime: startWall, timeZone: tz },
          end: { dateTime: endWall, timeZone: tz },
          attendees: [{ email: lead.email, displayName: lead.fullName }],
          reminders: { useDefault: true }
        }
      });

      const eventId = insert.data.id ?? `gcal-${Date.now()}`;
      const whenPretty = formatInTimeZone(start, tz, "EEEE, MMMM d 'at' h:mm a zzz");
      const replyText = `Hi ${name} — perfect. I’ve sent a calendar invite for ${whenPretty}. If that time stops working, just reply here and we’ll adjust.`;

      return {
        handled: true,
        mode: "google_calendar",
        meetingStart: start,
        meetingEnd: end,
        eventId,
        replyText
      };
    } catch (e) {
      console.warn("[suggested_time auto-book] slot failed", e);
      continue;
    }
  }

  return { handled: false, reason: "all_candidate_slots_busy_or_failed" };
}
