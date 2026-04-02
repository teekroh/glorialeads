import type { Message } from "@prisma/client";

/** Outbound kinds that represent copy the lead actually received (not classifier/system rails). */
const INBOX_PREVIEW_OUTBOUND_KINDS = new Set([
  "first_touch",
  "follow_up_1",
  "follow_up_2",
  "manual_reply",
  "booking_invite",
  "claude_auto_reply",
  "scheduled_follow_up"
]);

export function stripOutboundPreviewNoise(body: string): string {
  let s = body.trim();
  if (s.startsWith("[Auto-sent pricing]")) s = s.slice("[Auto-sent pricing]".length).trim();
  else if (s.startsWith("[Auto-sent]")) s = s.slice("[Auto-sent]".length).trim();
  if (s.startsWith("[Manual-sent]")) s = s.slice("[Manual-sent]".length).trim();
  s = s.replace(/^\[Claude auto [\d.]+\]\s*/i, "").trim();
  return s;
}

/**
 * Prefer outbound(s) sent at/after this inbound so we don’t show an older campaign line
 * when the latest real reply was the booking link / manual email.
 */
export function pickLastOutboundBodyForInbox(messages: Message[], leadId: string, inboundReceivedAt: Date): string {
  const t0 = inboundReceivedAt.getTime();
  const outs = messages.filter(
    (m) =>
      m.leadId === leadId &&
      m.direction === "outbound" &&
      m.kind !== "system_auto" &&
      INBOX_PREVIEW_OUTBOUND_KINDS.has(m.kind) &&
      (m.status === "sent" || m.status === "dry_run")
  );
  const afterInbox = outs.filter((m) => m.sentAt.getTime() >= t0);
  const pool = afterInbox.length ? afterInbox : outs;
  const last = pool.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
  if (!last?.body?.trim()) return "—";
  return stripOutboundPreviewNoise(last.body);
}
