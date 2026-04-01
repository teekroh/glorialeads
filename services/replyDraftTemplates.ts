import { getBookingLink } from "@/config/bookingCopy";
import type { Lead } from "@/types/lead";

const PRICING_DRAFT_TEMPLATE = `Totally fair — most projects vary quite a bit depending on layout and finishes.

We can usually give a pretty accurate range after a quick 10–15 minute call.

If you're open to it:
{{BOOKING_LINK}}`;

export const draftSuggestedTimeReply = (_lead: Lead, _inboundSnippet: string) => {
  const link = getBookingLink() || "[configure BOOKING_LINK]";
  const name = _lead.firstName?.trim() || "there";
  return `Hi ${name} — thanks for proposing a time. I’ll confirm or suggest a nearby slot shortly.\n\nYou can also book a 15-minute opening here: ${link}`;
};

export const draftPricingReply = () => {
  const link = getBookingLink() || "[configure BOOKING_LINK]";
  return PRICING_DRAFT_TEMPLATE.replace(/\{\{BOOKING_LINK\}\}/g, link);
};

export const draftInfoReply = (lead: Lead) => {
  const name = lead.firstName?.trim() || "there";
  return `Hi ${name} — we design, build, and install custom kitchens and millwork from Hatfield, PA, with an emphasis on fast, reliable execution. Typical lead times depend on scope; I can share a concise timeline and relevant photos on a short call when convenient.`;
};
