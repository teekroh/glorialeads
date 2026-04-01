import { getBookingLink, getBookingReplyTemplate } from "@/config/bookingCopy";
import {
  generateFirstTouchMessage,
  generateFirstTouchPreviewRowsForClassification,
  generateFirstTouchSamplesForLeadType,
  generateFirstTouchSamplesForSegment,
  FIRST_TOUCH_CLASSIFICATIONS,
  mapLeadTypeToFirstTouchClassification,
  mapLeadTypeToSegment,
  renderFirstTouchForLead,
  stableVariantIndex,
  type FirstTouchPreviewRow,
  type FirstTouchSegment,
  type MessageLeadInput,
  type RenderedFirstTouch
} from "@/services/firstTouchMessageGenerator";
import { generateFollowUp1Message, generateFollowUp2Message } from "@/services/followUpMessageGenerator";
import { draftPricingReply } from "@/services/replyDraftTemplates";
import type { FirstTouchClassification, Lead } from "@/types/lead";

const INFO_REPLY_TEMPLATE = `Hi Alex — we design, build, and install custom kitchens and millwork from Hatfield, PA, with an emphasis on fast, reliable execution. Typical lead times depend on scope; I can share a concise timeline and relevant photos on a short call when convenient.`;

export {
  generateFirstTouchMessage,
  generateFirstTouchPreviewRowsForClassification,
  generateFirstTouchSamplesForLeadType,
  generateFirstTouchSamplesForSegment,
  FIRST_TOUCH_CLASSIFICATIONS,
  mapLeadTypeToFirstTouchClassification,
  mapLeadTypeToSegment,
  renderFirstTouchForLead,
  stableVariantIndex,
  type FirstTouchClassification,
  type FirstTouchPreviewRow,
  type FirstTouchSegment,
  type MessageLeadInput,
  type RenderedFirstTouch
};

/** First-touch body for campaign send — classification + location rules only; stable per lead.id. */
export const renderFirstTouchMessage = (lead: Lead) => generateFirstTouchMessage(lead, getBookingLink()).body;

const SEQUENCE_PREVIEW_LEAD: MessageLeadInput = {
  id: "campaign-tree-preview",
  firstName: "Alex",
  fullName: "Alex Rivera",
  company: "Rivera Design",
  city: "Doylestown",
  state: "PA",
  leadType: "designer",
  source: "CSV Import",
  enrichmentStatus: "enriched",
  locationConfidence: "high",
  score: 72,
  priorityTier: "Tier B",
  status: "New",
  replyHistory: []
};

/** Default copy for Campaign sequence tree (client + server). */
export function getCampaignSequencePreview(bookingLinkForDisplay: string) {
  const link = getBookingLink() || bookingLinkForDisplay || "";
  const firstTouchBody = generateFirstTouchMessage(SEQUENCE_PREVIEW_LEAD, link).body;
  return {
    firstTouchBody,
    followUp1: generateFollowUp1Message(SEQUENCE_PREVIEW_LEAD, firstTouchBody),
    followUp2: generateFollowUp2Message(SEQUENCE_PREVIEW_LEAD),
    bookingReply: getBookingReplyTemplate(),
    pricingReply: draftPricingReply(),
    infoReply: INFO_REPLY_TEMPLATE
  };
}

export { generateFollowUp1Message, generateFollowUp2Message };

export const followUp1Template = generateFollowUp1Message(
  SEQUENCE_PREVIEW_LEAD,
  generateFirstTouchMessage(SEQUENCE_PREVIEW_LEAD, "").body
);
export const followUp2Template = generateFollowUp2Message(SEQUENCE_PREVIEW_LEAD);

export const pricingReplyTemplate = draftPricingReply();
export const infoReplyTemplate = INFO_REPLY_TEMPLATE;

export { getBookingReplyTemplate };
