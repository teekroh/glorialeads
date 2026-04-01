import Anthropic from "@anthropic-ai/sdk";
import { appConfig } from "@/config/appConfig";
import { claudeModelId, isClaudeCopyConfigured } from "@/config/claudeConfig";
import { resolveClaudeSystemPrompt } from "@/services/claudeSystemPrompt";
import { formatFullLeadContextForClaude } from "@/services/leadContextFormatting";
import type { Lead, ReplyCategory } from "@/types/lead";

const SYSTEM_GATE = `You are a conservative reviewer for ${appConfig.companyName} outbound email automation.

You MUST respond with a single JSON object only (no markdown fences, no prose before or after). Keys:
- "confidence": number from 0 to 1 — how sure you are that sending reply_body is logically correct, safe, and appropriate given the thread (use below 0.88 if unsure).
- "rationale": short string explaining the confidence level.
- "reply_body": plain-text email body to send (US English, warm, professional, no markdown). If a Cal scheduling link is needed, use the literal token {{BOOKING_LINK}} once — never invent a URL.

Be extremely strict: prefer routing to human review (low confidence) over risking a mistaken or tone-deaf send.`;

function stripJsonFence(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  return s.trim();
}

export type ClaudeAutoSendEvaluation = {
  confidence: number;
  rationale: string;
  replyBody: string;
};

export async function evaluateClaudeAutoSend(input: {
  lead: Lead;
  classification: ReplyCategory;
  classifierConfidence: number;
  classifierReason: string;
  mixedIntent: boolean;
  inboundText: string;
  proposedDraft: string;
}): Promise<ClaudeAutoSendEvaluation | null> {
  if (!isClaudeCopyConfigured()) return null;
  const user = `${formatFullLeadContextForClaude(input.lead)}

Automated classifier (rules-based):
- classification: ${input.classification}
- confidence: ${input.classifierConfidence}
- reason: ${input.classifierReason}
- mixed_intent: ${input.mixedIntent}

Their latest inbound:
---
${input.inboundText.slice(0, 4500)}
---

Proposed reply draft (you may revise reply_body):
---
${input.proposedDraft.slice(0, 4000)}
---

Return JSON only with confidence, rationale, reply_body.`;

  try {
    const system = await resolveClaudeSystemPrompt(SYSTEM_GATE);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: claudeModelId(),
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: user }]
    });
    const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const raw = block?.text?.trim();
    if (!raw) return null;
    const parsed = JSON.parse(stripJsonFence(raw)) as {
      confidence?: unknown;
      rationale?: unknown;
      reply_body?: unknown;
    };
    const confidence = Number(parsed.confidence);
    const rationale = String(parsed.rationale ?? "").trim();
    const replyBody = String(parsed.reply_body ?? "").trim();
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !replyBody) return null;
    return { confidence, rationale, replyBody };
  } catch (e) {
    console.warn("[Gloria] Claude auto-send evaluation failed:", e);
    return null;
  }
}

export function autoReplySubjectForClassification(c: ReplyCategory): string {
  switch (c) {
    case "pricing_question":
      return "Re: Pricing — Gloria Custom Cabinetry";
    case "info_request":
      return "Re: Your question — Gloria Custom Cabinetry";
    case "suggested_time":
      return "Re: Scheduling — Gloria Custom Cabinetry";
    case "unclear":
      return "Re: Your note — Gloria Custom Cabinetry";
    case "positive":
    case "asks_for_link":
      return "Re: Intro call — Gloria Custom Cabinetry";
    default:
      return "Re: Gloria Custom Cabinetry";
  }
}
