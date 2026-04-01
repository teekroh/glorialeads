import { getBookingLink, getBookingLinkForDisplay } from "@/config/bookingCopy";
import { db } from "@/lib/db";
import { uid } from "@/lib/utils";
import { notifyOwnerMeetingBooked } from "@/services/ownerNotifyService";

export type MarkBookedResult = { ok: true; duplicate?: boolean } | { ok: false; error: string };

export const markBooked = async (
  leadId: string,
  extras?: {
    externalBookingId?: string;
    meetingStart?: string;
    meetingEnd?: string;
    campaignId?: string;
    /** Bypass idempotency (tests only). */
    force?: boolean;
  }
): Promise<MarkBookedResult> => {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "Lead not found" };

  if (!extras?.force) {
    const existing = await db.booking.findFirst({
      where: { leadId, status: "booked", meetingStatus: "confirmed" }
    });
    if (existing) {
      const start = extras?.meetingStart ? new Date(extras.meetingStart) : null;
      const end = extras?.meetingEnd ? new Date(extras.meetingEnd) : null;
      if (start && !Number.isNaN(start.getTime()) && !existing.meetingStart) {
        await db.booking.update({
          where: { id: existing.id },
          data: {
            meetingStart: start,
            meetingEnd: end && !Number.isNaN(end.getTime()) ? end : existing.meetingEnd,
            externalBookingId: extras?.externalBookingId?.trim() || existing.externalBookingId
          }
        });
      }
      return { ok: true, duplicate: true };
    }
  }

  const now = new Date();
  const link = getBookingLink() || getBookingLinkForDisplay();
  await db.booking.create({
    data: {
      id: uid(),
      leadId,
      campaignId: extras?.campaignId ?? null,
      status: "booked",
      note: "Booking confirmed",
      bookingLink: link,
      externalBookingId: extras?.externalBookingId ?? null,
      bookedAt: now,
      meetingStart: extras?.meetingStart ? new Date(extras.meetingStart) : null,
      meetingEnd: extras?.meetingEnd ? new Date(extras.meetingEnd) : null,
      meetingStatus: "confirmed",
      createdAt: now
    }
  });
  await db.message.create({
    data: {
      id: uid(),
      leadId,
      campaignId: extras?.campaignId ?? null,
      direction: "outbound",
      kind: "system_auto",
      body: "[Auto] Booking confirmed",
      sentAt: now,
      status: "sent"
    }
  });
  await db.lead.update({
    where: { id: leadId },
    data: { status: "Booked", updatedAt: now }
  });
  void notifyOwnerMeetingBooked({
    leadName: lead.fullName,
    leadEmail: lead.email,
    meetingStartIso: extras?.meetingStart ?? null
  });
  return { ok: true };
};
