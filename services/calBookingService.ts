import { db } from "@/lib/db";
import { markBooked } from "@/services/markBookedService";
import { getBookingLink } from "@/config/bookingCopy";

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

/** Normalize Cal.com / Zapier-style emails */
function normEmail(s: string): string {
  return s.trim().toLowerCase();
}

/** Cal.com `responses.email` is often `{ label, value, isHidden }`, not a raw string. */
function emailFromCalResponses(responses: Json | undefined): string | null {
  if (!responses || typeof responses !== "object") return null;
  const e = responses.email;
  if (typeof e === "string" && e.trim()) return normEmail(e);
  if (e && typeof e === "object" && "value" in e) {
    const v = (e as { value?: unknown }).value;
    if (typeof v === "string" && v.trim()) return normEmail(v);
  }
  return null;
}

/** Cal usually sends ISO strings; some integrations send epoch ms or seconds. */
function coerceCalDateTime(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return undefined;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/**
 * Process Cal.com (or mock) booking webhook payload.
 * Resolves lead by explicit leadId, then attendee email.
 * @see config/calcomSetup.ts for event + URL guidance
 */
export async function processCalBookingPayload(body: unknown): Promise<{
  ok: boolean;
  duplicate?: boolean;
  error?: string;
  leadId?: string;
}> {
  const root = asObj(body) ?? {};
  const isMock = root.mock === true;
  const triggerRaw = typeof root.triggerEvent === "string" ? root.triggerEvent.trim() : "";

  const eventType = detectCalBookingEventType(body) ?? (isMock ? "booking.created" : undefined);

  let leadId: string | null = root.leadId ? String(root.leadId) : null;
  let externalBookingId: string | undefined;
  let meetingStart: string | undefined;
  let meetingEnd: string | undefined;
  let campaignId: string | undefined =
    root.campaignId !== undefined && root.campaignId !== null ? String(root.campaignId) : undefined;
  let attendeeEmail: string | null = null;

  const rootHasLegacyFields =
    isMock ||
    Boolean(root.bookingUid) ||
    Boolean(leadId && (root.startTime || root.start || root.bookingId || root.uid || root.id));

  if (rootHasLegacyFields) {
    externalBookingId =
      (root.bookingUid as string) ||
      (root.bookingId as string) ||
      (root.uid as string) ||
      (root.id as string | undefined)?.toString() ||
      `mock-${Date.now()}`;
    meetingStart = (root.startTime as string) || (root.start as string);
    meetingEnd = (root.endTime as string) || (root.end as string);
    if (!meetingStart) {
      const s = new Date();
      s.setDate(s.getDate() + 1);
      s.setHours(10, 0, 0, 0);
      meetingStart = s.toISOString();
      meetingEnd = new Date(s.getTime() + 15 * 60 * 1000).toISOString();
    }
    if (!meetingEnd && meetingStart) {
      meetingEnd = new Date(new Date(meetingStart).getTime() + 15 * 60 * 1000).toISOString();
    }
  }

  const payload = asObj(root.payload);
  const bookingFromPayload = asObj(payload?.booking) ?? asObj(payload) ?? asObj(root.booking);

  if (bookingFromPayload && !isMock) {
    externalBookingId =
      (bookingFromPayload.id as string)?.toString() ||
      (bookingFromPayload.uid as string) ||
      (bookingFromPayload.bookingId as string)?.toString() ||
      externalBookingId;
    meetingStart =
      coerceCalDateTime(bookingFromPayload.startTime) ||
      coerceCalDateTime(bookingFromPayload.start) ||
      coerceCalDateTime(bookingFromPayload.startTimeUtc) ||
      meetingStart;
    meetingEnd =
      coerceCalDateTime(bookingFromPayload.endTime) ||
      coerceCalDateTime(bookingFromPayload.end) ||
      coerceCalDateTime(bookingFromPayload.endTimeUtc) ||
      meetingEnd;

    const responses = bookingFromPayload.responses as Json | undefined;
    const attendees = bookingFromPayload.attendees as unknown;
    let organizerEmail: string | null = null;
    const org = bookingFromPayload.organizer;
    if (org && typeof org === "object") {
      const oe = (org as Json).email;
      if (typeof oe === "string" && oe.trim()) organizerEmail = normEmail(oe);
    }
    if (Array.isArray(attendees)) {
      for (const row of attendees) {
        if (row && typeof row === "object") {
          const a = row as Json;
          const em = (a.email as string) || null;
          if (!em?.trim()) continue;
          const guest = normEmail(em);
          if (organizerEmail && guest === organizerEmail) continue;
          attendeeEmail = guest;
          break;
        }
      }
    }
    if (!attendeeEmail) attendeeEmail = emailFromCalResponses(responses);
  }

  if (!leadId && attendeeEmail) {
    const lead = await db.lead.findFirst({
      where: { email: normEmail(attendeeEmail) }
    });
    leadId = lead?.id ?? null;
  }

  if (!leadId) {
    console.warn("[Cal Booking] could not resolve lead for event", {
      eventType,
      hasAttendeeEmail: Boolean(attendeeEmail),
      externalBookingId: externalBookingId ?? null
    });
    return { ok: false, error: "Could not resolve lead (need leadId or attendee email matching a lead)." };
  }

  if (!campaignId) {
    const cl = await db.campaignLead.findFirst({
      where: { leadId },
      orderBy: { assignedAt: "desc" }
    });
    campaignId = cl?.campaignId ?? undefined;
  }

  // Event handlers. Modern Cal payloads always set `triggerEvent`; do not treat unknown triggers as "created"
  // (would mis-handle BOOKING_CANCELLED etc. if detection failed).
  if (eventType === "booking.created" || (!eventType && !triggerRaw && (isMock || rootHasLegacyFields))) {
    const result = await markBooked(leadId, {
      externalBookingId,
      meetingStart,
      meetingEnd,
      campaignId: campaignId ?? undefined
    });
    if (!result.ok) return { ok: false, error: result.error ?? "markBooked failed" };
    return { ok: true, duplicate: result.duplicate, leadId };
  }

  if (eventType === "booking.rescheduled") {
    const now = new Date();
    const link = getBookingLink() || null;
    const where =
      externalBookingId && externalBookingId.trim()
        ? { leadId, externalBookingId }
        : { leadId };

    // Prefer updating the existing confirmed booking when possible.
    const existing = await db.booking.findFirst({
      where: where as any,
      orderBy: { createdAt: "desc" }
    });

    if (existing) {
      await db.booking.update({
        where: { id: existing.id },
        data: {
          status: "booked",
          note: "Booking rescheduled",
          bookingLink: link ?? existing.bookingLink ?? null,
          externalBookingId: existing.externalBookingId ?? externalBookingId ?? null,
          bookedAt: now,
          meetingStart: meetingStart ? new Date(meetingStart) : null,
          meetingEnd: meetingEnd ? new Date(meetingEnd) : null,
          meetingStatus: "confirmed"
        }
      });
      await db.message.create({
        data: {
          id: String(`msg-${Date.now()}-${Math.random()}`),
          leadId,
          campaignId: campaignId ?? null,
          direction: "outbound",
          kind: "system_auto",
          body: "[Auto] Booking rescheduled",
          sentAt: now,
          status: "sent"
        }
      });
    } else {
      // No matching booking: create a booking row so the event isn't lost.
      const result = await markBooked(leadId, {
        externalBookingId,
        meetingStart,
        meetingEnd,
        campaignId: campaignId ?? undefined
      });
      if (!result.ok) return { ok: false, error: result.error ?? "markBooked failed" };
    }

    await db.lead.update({
      where: { id: leadId },
      data: { status: "Booked", updatedAt: new Date() }
    });

    return { ok: true, leadId };
  }

  if (eventType === "booking.cancelled") {
    const now = new Date();
    const where =
      externalBookingId && externalBookingId.trim()
        ? { leadId, externalBookingId }
        : { leadId };

    const existing = await db.booking.findFirst({
      where: where as any,
      orderBy: { createdAt: "desc" }
    });

    if (existing) {
      await db.booking.update({
        where: { id: existing.id },
        data: {
          status: "cancelled",
          note: "Booking cancelled",
          meetingStart: existing.meetingStart,
          meetingEnd: existing.meetingEnd,
          meetingStatus: "cancelled",
          bookedAt: now
        }
      });

      await db.message.create({
        data: {
          id: String(`msg-${Date.now()}-${Math.random()}`),
          leadId,
          campaignId: campaignId ?? null,
          direction: "outbound",
          kind: "system_auto",
          body: "[Auto] Booking cancelled",
          sentAt: now,
          status: "sent"
        }
      });

      // If they were previously marked as Booked, return them to Interested so automation can resume.
      const lead = await db.lead.findUnique({ where: { id: leadId }, select: { status: true } });
      if (lead?.status === "Booked") {
        await db.lead.update({
          where: { id: leadId },
          data: { status: "Interested", updatedAt: new Date() }
        });
      }
    }

    return { ok: true, leadId };
  }

  // Unknown event type: still ok, but we don't change booking state.
  return { ok: true, leadId };
}

/**
 * Extract Cal.com event type string like `booking.created`.
 * Cal payload shapes vary by integration; we try the common locations.
 */
export function detectCalBookingEventType(body: unknown): string | undefined {
  const root = asObj(body) ?? {};
  const te =
    typeof root.triggerEvent === "string" ? root.triggerEvent.trim().toUpperCase().replace(/\./g, "_") : "";
  if (te === "BOOKING_CREATED") return "booking.created";
  if (te === "BOOKING_RESCHEDULED") return "booking.rescheduled";
  if (te === "BOOKING_CANCELLED") return "booking.cancelled";

  const direct =
    root.event && typeof root.event === "string"
      ? root.event
      : (root.type && typeof root.type === "string" ? root.type : undefined);

  if (direct && direct.includes("booking.")) return direct;

  const eventObj = root.event && typeof root.event === "object" ? (root.event as Record<string, unknown>) : null;
  const fromEventObj =
    eventObj?.type && typeof eventObj.type === "string"
      ? eventObj.type
      : eventObj?.eventType && typeof eventObj.eventType === "string"
        ? eventObj.eventType
        : undefined;
  if (fromEventObj && fromEventObj.includes("booking.")) return fromEventObj;

  const payload = asObj(root.payload);
  const payloadType =
    (payload?.eventType && typeof payload.eventType === "string" ? payload.eventType : undefined) ||
    (payload?.type && typeof payload.type === "string" ? payload.type : undefined);
  if (payloadType && payloadType.includes("booking.")) return payloadType;

  return undefined;
}
