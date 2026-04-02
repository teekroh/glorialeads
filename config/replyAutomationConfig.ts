const toFloat = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * AUTO_BOOKING_MIN_CONFIDENCE: only positive / asks_for_link auto-send booking when confidence >= this AND no mixed intent.
 * AUTO_REPLY_MIN_CONFIDENCE: threshold for any future auto outbound reply (non-booking); pricing stays manual unless explicitly enabled below.
 *
 * Claude gate: after drafts are built, an optional second Claude pass outputs JSON { confidence, rationale, reply_body }.
 * Email sends automatically only if confidence >= CLAUDE_AUTO_SEND_MIN_CONFIDENCE (default strict).
 */
export const replyAutomationConfig = {
  autoBookingMinConfidence: toFloat(process.env.AUTO_BOOKING_MIN_CONFIDENCE, 0.9),
  autoReplyMinConfidence: toFloat(process.env.AUTO_REPLY_MIN_CONFIDENCE, 0.9),
  /** When true (default) and ANTHROPIC_API_KEY is set, Claude may auto-send replies that pass the confidence gate. */
  claudeAutoSendEnabled: (process.env.CLAUDE_AUTO_SEND ?? "true").toLowerCase() !== "false",
  /** Minimum model-reported confidence (0-1) to auto-send; keep high for safety. */
  claudeAutoSendMinConfidence: toFloat(process.env.CLAUDE_AUTO_SEND_MIN_CONFIDENCE, 0.92),
  /** When true and confidence >= autoSendPricingMinConfidence, pricing draft could auto-send (default off). */
  allowAutoSendPricingReply: (process.env.AUTO_SEND_PRICING_REPLY ?? "").toLowerCase() === "true",
  autoSendPricingMinConfidence: toFloat(process.env.AUTO_SEND_PRICING_MIN_CONFIDENCE, 0.97),
  /**
   * suggested_time: if confidence >= this and not mixed intent, try Google Calendar auto-hold;
   * if that fails or Google isn’t configured, optionally auto-send Cal link (see below).
   */
  autoSuggestedTimeMinConfidence: toFloat(process.env.AUTO_SUGGESTED_TIME_MIN_CONFIDENCE, 0.75),
  /** When Google Calendar isn’t set up or no free slot, still auto-send the draft with Cal link (default on). */
  autoSuggestedTimeFallbackCalLink:
    (process.env.AUTO_SUGGESTED_TIME_FALLBACK_CAL_LINK ?? "true").toLowerCase() !== "false",
  /**
   * Floor for classifier / Claude auto-send when the inbound is clearly scheduling-focused
   * (suggested_time, asks_for_link, or positive + scheduling language). Default slightly above
   * CLAUDE_AUTO_SEND_MIN_CONFIDENCE so those replies pass the send gate without human review.
   */
  scheduleIntentConfidenceFloor: toFloat(process.env.SCHEDULE_INTENT_CONFIDENCE_FLOOR, 0.93)
};
