import type { calendar_v3 } from "googleapis";
import { googleCalendarConfig, isGoogleCalendarConfigured } from "@/config/googleCalendarConfig";
import { db } from "@/lib/db";
import { markBooked } from "@/services/markBookedService";
import { getGoogleCalendarApiClient } from "@/services/googleCalendarBookingService";

function normEmail(s: string) {
  return s.trim().toLowerCase();
}

function parseEventBounds(ev: {
  start?: { dateTime?: string | null; date?: string | null };
  end?: { dateTime?: string | null; date?: string | null };
}): { start: Date; end: Date } | null {
  const s = ev.start?.dateTime || ev.start?.date;
  const e = ev.end?.dateTime || ev.end?.date;
  if (!s || !e) return null;
  const start = new Date(s);
  const end = new Date(e);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end };
}

/** Only leads in an active booking flow or Booked without a stored meeting time. */
async function leadEligibleForGoogleSync(leadId: string): Promise<boolean> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { status: true } });
  if (!lead) return false;
  const st = lead.status;
  if (st === "Booking Sent") return true;
  if (st === "Interested" || st === "In Campaign" || st === "Needs Review") {
    const pending = await db.booking.findFirst({ where: { leadId, status: "booking_sent" } });
    return Boolean(pending);
  }
  if (st === "Booked") {
    const withTime = await db.booking.findFirst({
      where: { leadId, status: "booked", meetingStatus: "confirmed", meetingStart: { not: null } }
    });
    return !withTime;
  }
  return false;
}

export type SyncGoogleCalendarBookingsResult =
  | {
      ok: true;
      eventsScanned: number;
      markedBooked: number;
      updatedExisting: number;
      skipped: string[];
    }
  | { ok: false; error: string };

/**
 * Reads events on the configured workspace calendar and marks matching leads as Booked when the
 * guest email matches a CRM lead in a booking-eligible state (invite sent / booking_sent / Booked but no time).
 */
export async function syncBookingsFromGoogleCalendar(): Promise<SyncGoogleCalendarBookingsResult> {
  if (!isGoogleCalendarConfigured()) {
    return {
      ok: false,
      error: "Google Calendar is not configured (GOOGLE_CALENDAR_CREDENTIALS_JSON)."
    };
  }

  let calendar;
  try {
    calendar = await getGoogleCalendarApiClient();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const calendarId = googleCalendarConfig.calendarId;
  const teamMailbox = googleCalendarConfig.impersonateUser ? normEmail(googleCalendarConfig.impersonateUser) : "";

  const timeMin = new Date(Date.now() - 14 * 86400000).toISOString();
  const timeMax = new Date(Date.now() + 180 * 86400000).toISOString();

  const skipped: string[] = [];
  const eventItems: calendar_v3.Schema$Event[] = [];

  let pageToken: string | undefined;
  try {
    do {
      const res = await calendar.events.list({
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 500,
        pageToken
      });
      if (res.data.items?.length) eventItems.push(...res.data.items);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let eventsScanned = 0;
  let markedBooked = 0;
  let updatedExisting = 0;

  for (const ev of eventItems) {
    eventsScanned++;
    if (!ev.id || ev.status === "cancelled") continue;

    const bounds = parseEventBounds(ev);
    if (!bounds) continue;

    const alreadyByGcalId = await db.booking.findFirst({
      where: { externalBookingId: ev.id },
      select: { id: true }
    });
    if (alreadyByGcalId) continue;

    const guestLeadIds = new Set<string>();
    for (const a of ev.attendees ?? []) {
      if (a.resource) continue;
      const raw = a.email?.trim();
      if (!raw) continue;
      const em = normEmail(raw);
      if (teamMailbox && em === teamMailbox) continue;
      const lead = await db.lead.findFirst({
        where: { email: { equals: raw, mode: "insensitive" } },
        select: { id: true }
      });
      if (lead) guestLeadIds.add(lead.id);
    }

    const startIso = bounds.start.toISOString();
    const endIso = bounds.end.toISOString();

    for (const leadId of guestLeadIds) {
      const eligible = await leadEligibleForGoogleSync(leadId);
      if (!eligible) continue;

      const result = await markBooked(leadId, {
        externalBookingId: ev.id,
        meetingStart: startIso,
        meetingEnd: endIso
      });

      if (!result.ok) {
        skipped.push(`${leadId}:${result.error}`);
        continue;
      }
      if (result.duplicate) updatedExisting += 1;
      else markedBooked += 1;
    }
  }

  return { ok: true, eventsScanned, markedBooked, updatedExisting, skipped };
}
