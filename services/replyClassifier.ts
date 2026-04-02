import { replyAutomationConfig } from "@/config/replyAutomationConfig";
import { ReplyCategory } from "@/types/lead";

export interface ReplyClassificationResult {
  classification: ReplyCategory;
  confidence: number;
  recommendedAction: string;
  /** Short reason for storage and UI summary. */
  reason: string;
  /** Precedence, signals matched, and mixed-intent notes (audit / debug). */
  explanation: string;
  mixedIntent: boolean;
}

const PRICING_RE =
  /\b(cost|price|pricing|budget|range|ballpark|estimate|how much|what does it run|what does a typical|typical\b.{0,24}\brun\b|sanity-check|run with you)/i;

const INFO_RE =
  /\b(info|details|more about|more details|portfolio|examples|who are you|lead times|service area|take projects|buck(s)? county)\b/i;

/** Concrete time proposals — not hedging like “before we schedule anything”. */
const TIME_RE =
  /\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.{0,40}\b(works|good|free|available|open)\b|\b\d{1,2}:\d{2}\s*(am|pm)\b|\b\d{1,2}\s*(am|pm)\b|\b(monday|tuesday|wednesday|thursday|friday)\s+(morning|afternoon)\b.*\b(works|free|good)\b|\b(i'?m|i am)\s+free\b.{0,30}\b(morning|afternoon)\b|\bafter\s+\d\b.*\bnext week\b/i;

/** Explicit readiness to book — must not match casual “schedule” hedging alone. */
const LINK_EXPLICIT_RE =
  /send (me )?(the )?link|send your (calendar|cal\.com|scheduling link)|let['’]?s book|let['’]?s schedule|when can we talk|what['’]?s your availability|what is your availability|can you send (a )?booking link|cal\.com\/[\w-]+|grab a time here|pick a time here|book a (quick |short )?(call|slot)|\b15[- ]?minute (intro |call )?slot\b/i;

const POSITIVE_RE =
  /\b(interested|sounds good|that works|yes\b|yeah|yep|let['’]?s connect|best way to connect|great to hear|happy to (talk|connect)|looking forward|we're interested|we are interested)\b/i;

/** Broader “wants to meet / get time” phrasing beyond day-of-week TIME_RE / LINK_EXPLICIT_RE. */
const SCHEDULE_FOCUS_RE =
  /\b(schedule|scheduling|book)\s+(a\s+)?(time|call|meeting|slot|intro)\b|\b(find|pick|grab|set up)\s+(a\s+)?(time|call|meeting|slot)\b|\bavailable\s+times?\b|\bwhat\s+times?\s+(work|are good)\b|\bwhen\s+(can|could)\s+we\s+(talk|meet|chat|connect|schedule)\b|\btime\s+to\s+(meet|talk|connect)\b/i;

function shouldBoostScheduleConfidence(classification: ReplyCategory, rawText: string): boolean {
  if (classification === "suggested_time" || classification === "asks_for_link") return true;
  const lower = rawText.trim().toLowerCase();
  if (classification === "positive") {
    return detectSuggestedTime(lower) || detectAsksForLink(lower) || SCHEDULE_FOCUS_RE.test(lower);
  }
  return false;
}

/** Raise confidence for clear scheduling intents so automation gates (e.g. auto-send) match product intent. */
export function applyScheduleIntentConfidenceFloor(
  confidence: number,
  classification: ReplyCategory,
  inboundText: string,
  mixedIntent = false
): number {
  if (mixedIntent) return confidence;
  if (!shouldBoostScheduleConfidence(classification, inboundText)) return confidence;
  return Math.max(confidence, replyAutomationConfig.scheduleIntentConfidenceFloor);
}

function detectPricing(t: string): boolean {
  return PRICING_RE.test(t) || /\bkitchen\b.{0,80}\brun\b/i.test(t);
}

function detectInfo(t: string): boolean {
  return INFO_RE.test(t);
}

function detectSuggestedTime(t: string): boolean {
  if (/\bbefore we schedule\b/i.test(t) && !TIME_RE.test(t)) return false;
  return TIME_RE.test(t);
}

function detectAsksForLink(t: string): boolean {
  return LINK_EXPLICIT_RE.test(t);
}

function detectPositive(t: string): boolean {
  return POSITIVE_RE.test(t);
}

export const classifyReply = (text: string): ReplyClassificationResult => {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (/unsubscribe|remove me|stop (emailing|sending)|opt out|mailing list/i.test(lower)) {
    return {
      classification: "unsubscribe",
      confidence: 0.98,
      recommendedAction: "Set doNotContact; suppress all future sends.",
      reason: "Explicit opt-out language.",
      explanation: "Matched unsubscribe / opt-out patterns first (highest safety precedence).",
      mixedIntent: false
    };
  }

  if (/no thanks|not interested|already have|going with someone else|go with another|another shop|decided to go with|going another direction|\bpass\b/i.test(lower)) {
    return {
      classification: "objection",
      confidence: 0.86,
      recommendedAction: "Mark Not Interested; stop campaign follow-ups.",
      reason: "Decline or chose another vendor.",
      explanation: "Matched objection patterns before deferral / qualification intents.",
      mixedIntent: false
    };
  }

  if (/not now|later|next (month|quarter|year)|too busy|circle back|pick this up next/i.test(lower)) {
    return {
      classification: "not_now",
      confidence: 0.87,
      recommendedAction: "Mark Not Now; optional reactivation date.",
      reason: "Defers without opting out.",
      explanation: "Matched timing deferral (not_now) before qualification intents.",
      mixedIntent: false
    };
  }

  const pricingHit = detectPricing(lower);
  const infoSignal = detectInfo(lower);
  const infoHit = infoSignal && !pricingHit;
  const timeHit = detectSuggestedTime(lower);
  const linkHit = detectAsksForLink(lower);
  const positiveHit = detectPositive(lower);

  const qualificationSignals = [pricingHit, infoSignal, timeHit, linkHit].filter(Boolean).length;
  /**
   * Mixed intent = multiple qualification tracks, or positive layered with pricing/info.
   * Gold path: soft positive ("might be interested") + a single clear schedule ask (time OR link only)
   * is *not* mixed — that is exactly the reply we want to auto-book.
   */
  const scheduleOnlyWithSoftPositive =
    positiveHit &&
    !pricingHit &&
    !infoSignal &&
    qualificationSignals === 1 &&
    (timeHit || linkHit);
  const mixedIntent = scheduleOnlyWithSoftPositive
    ? false
    : qualificationSignals >= 2 || (positiveHit && qualificationSignals >= 1);

  let classification: ReplyCategory = "unclear";
  if (pricingHit) classification = "pricing_question";
  else if (infoHit) classification = "info_request";
  else if (timeHit) classification = "suggested_time";
  else if (linkHit) classification = "asks_for_link";
  else if (positiveHit) classification = "positive";
  else {
    return {
      classification: "unclear",
      confidence: 0.48,
      recommendedAction: "Needs Review — ambiguous message.",
      reason: "No strong intent pattern.",
      explanation:
        "No pricing, info, time, link, or positive signal matched strongly enough. Routing to human review.",
      mixedIntent: false
    };
  }

  const signals = `signals: pricing=${pricingHit} info=${infoSignal} time=${timeHit} link=${linkHit} positive=${positiveHit}`;
  const precedence = "Intent precedence applied: pricing_question > info_request > suggested_time > asks_for_link; positive only if none of those matched.";
  const explanation = [precedence, signals, mixedIntent ? "Mixed or layered intent — automation should be conservative." : "Single primary intent."].join(
    " "
  );

  let confidence = 0.88;
  if (classification === "pricing_question") confidence = pricingHit && !mixedIntent ? 0.93 : 0.81;
  else if (classification === "info_request") confidence = 0.84;
  else if (classification === "suggested_time") confidence = 0.82;
  else if (classification === "asks_for_link") confidence = linkHit && !mixedIntent ? 0.92 : 0.78;
  else if (classification === "positive") confidence = positiveHit && !mixedIntent ? 0.91 : 0.76;

  if (mixedIntent) confidence = Math.min(confidence, 0.82);

  confidence = applyScheduleIntentConfidenceFloor(confidence, classification, t, mixedIntent);

  const recommendedBy: Record<ReplyCategory, string> = {
    pricing_question: "Needs Review with call-first pricing draft (no auto-send unless explicitly enabled).",
    info_request: "Needs Review; factual reply draft.",
    suggested_time: "Needs Review; confirm time or offer booking link.",
    asks_for_link: "Eligible for auto booking invite if confidence ≥ threshold and no mixed intent.",
    positive: "Eligible for auto booking invite if confidence ≥ threshold and no mixed intent.",
    objection: "",
    not_now: "",
    unsubscribe: "",
    unclear: ""
  };

  return {
    classification,
    confidence,
    recommendedAction: recommendedBy[classification],
    reason: `Primary label: ${classification.replace(/_/g, " ")} (${signals}).`,
    explanation,
    mixedIntent
  };
};
