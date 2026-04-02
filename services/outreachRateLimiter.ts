import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { googleCalendarConfig } from "@/config/googleCalendarConfig";
import { outreachConfig } from "@/config/outreachConfig";
import { db } from "@/lib/db";

/** Kinds that correspond to a real (or dry-run) lead-facing email via `sendOutreachEmail`. Excludes internal rows like `system_auto`. */
const LEAD_FACING_OUTBOUND_KINDS = [
  "first_touch",
  "follow_up_1",
  "follow_up_2",
  "manual_reply",
  "booking_invite",
  "claude_auto_reply"
] as const;

/** Start of the calendar day in `BUSINESS_TIMEZONE`, as a UTC `Date` (for DB `sentAt` comparisons). */
export function getOutreachCountingDayStart(reference: Date = new Date()): Date {
  const tz = googleCalendarConfig.businessTimezone;
  const ymd = formatInTimeZone(reference, tz, "yyyy-MM-dd");
  return fromZonedTime(`${ymd}T00:00:00`, tz);
}

/** Outbound messages actually delivered via the provider (excludes dry_run / failed). */
export async function countRealOutboundSendsSince(since: Date): Promise<number> {
  return db.message.count({
    where: {
      direction: "outbound",
      kind: { in: [...LEAD_FACING_OUTBOUND_KINDS] },
      status: "sent",
      sentAt: { gte: since }
    }
  });
}

export async function getRemainingRealOutboundQuota(reference: Date = new Date()): Promise<number> {
  const limit = outreachConfig.dailyOutboundTotalLimit;
  const since = getOutreachCountingDayStart(reference);
  const used = await countRealOutboundSendsSince(since);
  return Math.max(0, limit - used);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
