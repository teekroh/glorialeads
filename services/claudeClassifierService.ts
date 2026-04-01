import Anthropic from "@anthropic-ai/sdk";
import { appConfig } from "@/config/appConfig";
import { claudeModelId, isClaudeCopyConfigured } from "@/config/claudeConfig";
import type { ReplyClassificationResult } from "@/services/replyClassifier";
import { ReplyCategory } from "@/types/lead";

const VALID: ReplyCategory[] = [
  "positive",
  "asks_for_link",
  "suggested_time",
  "pricing_question",
  "info_request",
  "objection",
  "not_now",
  "unsubscribe",
  "unclear"
];

const SYSTEM = `You classify inbound sales emails for ${appConfig.companyName}.

Respond with a single JSON object only (no markdown). Keys:
- "classification": one of: positive, asks_for_link, suggested_time, pricing_question, info_request, objection, not_now, unsubscribe, unclear
- "confidence": number 0-1
- "mixed_intent": boolean — true if two+ conflicting intents (e.g. pricing + unsubscribe)
- "reason": short human-readable summary
- "recommended_action": one line for operators
- "explanation": optional brief note on signals you used

Prefer safety: use unclear when ambiguous; use objection for clear decline; unsubscribe only for legal/opt-out language.`;

function stripFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return t.trim();
}

function floorRefine(): number {
  const n = Number(process.env.CLAUDE_REFINE_RULE_CONFIDENCE_BELOW);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.84;
}

/** When true, a second Claude pass may override rule-based classifyReply. */
export function shouldRefineClassificationWithClaude(rule: ReplyClassificationResult): boolean {
  if (!isClaudeCopyConfigured()) return false;
  if (String(process.env.CLAUDE_CLASSIFIER_REFINE_DISABLED ?? "").toLowerCase() === "true") return false;
  if (rule.classification === "unclear") return true;
  if (rule.mixedIntent) return true;
  if (rule.confidence < floorRefine()) return true;
  return false;
}

export async function refineReplyClassificationWithClaude(
  inboundText: string,
  ruleBased: ReplyClassificationResult
): Promise<ReplyClassificationResult | null> {
  if (!isClaudeCopyConfigured()) return null;

  const user = `Rule-based draft (may be imperfect):
classification=${ruleBased.classification}
confidence=${ruleBased.confidence}
mixed_intent=${ruleBased.mixedIntent}
reason=${ruleBased.reason}
explanation=${ruleBased.explanation}

Inbound email:
---
${inboundText.slice(0, 5000)}
---

Return JSON only. Improve classification if the rules misread nuance; otherwise stay close to the draft but fix confidence.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: claudeModelId(),
      max_tokens: 600,
      system: SYSTEM,
      messages: [{ role: "user", content: user }]
    });
    const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const raw = block?.text?.trim();
    if (!raw) return null;
    const p = JSON.parse(stripFence(raw)) as Record<string, unknown>;
    const c = String(p.classification ?? "").trim() as ReplyCategory;
    if (!VALID.includes(c)) return null;
    const confidence = Number(p.confidence);
    if (!Number.isFinite(confidence)) return null;
    const mixedIntent = Boolean(p.mixed_intent);
    const reason = String(p.reason ?? ruleBased.reason).trim() || ruleBased.reason;
    const recommendedAction = String(p.recommended_action ?? ruleBased.recommendedAction).trim() || ruleBased.recommendedAction;
    const explanation = String(p.explanation ?? ruleBased.explanation).trim() || ruleBased.explanation;

    return {
      classification: c,
      confidence: Math.min(1, Math.max(0, confidence)),
      recommendedAction,
      reason: `[Claude] ${reason}`,
      explanation: `claude_classifier refine. ${explanation}`,
      mixedIntent
    };
  } catch (e) {
    console.warn("[Gloria] Claude classification refine failed:", e);
    return null;
  }
}
