import { appConfig } from "./appConfig";

/**
 * BOOKING_LINK usage (single funnel URL for Gloria intro calls):
 * - config/bookingCopy.ts: getBookingLink(), humanBookingMessage(), warnBookingLinkMissing()
 * - services/replyDrafts.ts: draftPricingReply, draftSuggestedTimeReply (via getBookingLink)
 * - services/persistenceService.ts: markBooked, getDashboardData path
 * - services/inboundProcessingService.ts: auto booking invite + unclear fallback
 * - services/messagingService.ts: getBookingReplyTemplate() → getBookingLink; first-touch via generateFirstTouchMessage
 * - services/calBookingService.ts: persisted booking rows
 * Client UI: prefer prop bookingLinkDisplay from server (getBookingLink on SSR) or NEXT_PUBLIC_BOOKING_LINK.
 */

/** Resolves BOOKING_LINK env, then NEXT_PUBLIC_BOOKING_LINK, then appConfig placeholder. */
export const getBookingLink = (): string => {
  const fromEnv = process.env.BOOKING_LINK?.trim();
  if (fromEnv) return fromEnv;
  const fromPublic = process.env.NEXT_PUBLIC_BOOKING_LINK?.trim();
  if (fromPublic) return fromPublic;
  return appConfig.bookingLink?.trim() ?? "";
};

export const isBookingLinkConfigured = (): boolean => {
  const v = getBookingLink();
  if (!v) return false;
  if (v.includes("your-team") || v.includes("cal.com/your") || v.includes("example.com")) return false;
  return true;
};

/** Template library / client-safe: NEXT_PUBLIC first, then appConfig (BOOKING_LINK is server-only at runtime on client). */
export const getBookingLinkForDisplay = (): string => {
  const pub = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_BOOKING_LINK?.trim() : "";
  if (pub) return pub;
  return appConfig.bookingLink?.trim() ?? "";
};

export function getBookingReplyTemplate(): string {
  const link = getBookingLink() || getBookingLinkForDisplay() || "[configure BOOKING_LINK]";
  return formatPositiveBookingBody(link);
}

let warnedMissing = false;

export function warnBookingLinkMissing(context: string): void {
  if (isBookingLinkConfigured()) return;
  if (warnedMissing) return;
  warnedMissing = true;
  console.warn(
    `[Gloria] BOOKING_LINK is missing or still set to a placeholder (${context}). Set BOOKING_LINK in .env.local for production booking invites.`
  );
}

const POSITIVE_BOOKING_TEMPLATE = `Great — happy to connect.

This link is just to lock in a specific time for a quick 15-minute intro (it may default to a short video meet). If you’d rather do a phone call, reply with your number and we’ll call you.

{{BOOKING_LINK}}

Looking forward to it.`;

/** Body for automated / approved booking invites (uses configured link only). */
export function humanBookingMessage(): string {
  warnBookingLinkMissing("humanBookingMessage");
  const link = getBookingLink() || "[configure BOOKING_LINK]";
  return POSITIVE_BOOKING_TEMPLATE.replace(/\{\{BOOKING_LINK\}\}/g, link);
}

export function formatPositiveBookingBody(link: string): string {
  return POSITIVE_BOOKING_TEMPLATE.replace(/\{\{BOOKING_LINK\}\}/g, link.trim() || "[configure BOOKING_LINK]");
}
