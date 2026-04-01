import Anthropic from "@anthropic-ai/sdk";
import { getBookingLink } from "@/config/bookingCopy";
import { appConfig } from "@/config/appConfig";
import { claudeModelId, isClaudeCopyConfigured } from "@/config/claudeConfig";
import type { MessageLeadInput } from "@/services/firstTouchMessageGenerator";
import { firstNameFromLead } from "@/services/firstTouchMessageGenerator";
import { formatFullLeadContextForClaude } from "@/services/leadContextFormatting";
import { resolveClaudeSystemPrompt } from "@/services/claudeSystemPrompt";
import type { Lead, ReplyCategory } from "@/types/lead";

export { formatFullLeadContextForClaude } from "@/services/leadContextFormatting";

const BOOKING_TOKEN = "{{BOOKING_LINK}}";

const SYSTEM_WRITING = `You write plain-text email body copy for ${appConfig.companyName} (${appConfig.address}).
Rules:
- Output ONLY the email body: no subject line, no greeting labels like "Subject:", no markdown, no bullet markdown.
- Warm, concise, professional US English.
- Do not fabricate discounts, guarantees, or certifications.
- When a scheduling URL is required, output the exact token ${BOOKING_TOKEN} on its own line or after "Book here:" — never invent a URL.`;

export function expandClaudeBookingPlaceholders(text: string): string {
  const link = getBookingLink() || "[configure BOOKING_LINK]";
  return text.split(BOOKING_TOKEN).join(link);
}

function expandBookingToken(text: string): string {
  return expandClaudeBookingPlaceholders(text);
}

function summarizeLeadContext(lead: MessageLeadInput): string {
  return [
    `Name: ${lead.fullName}`,
    `First name (greeting): ${firstNameFromLead(lead)}`,
    `Company: ${lead.company || "—"}`,
    `Lead type: ${lead.leadType}`,
    `City / state: ${lead.city || "—"}, ${lead.state || "—"}`,
    `Source: ${lead.source}`
  ].join("\n");
}

async function completeUserPrompt(user: string): Promise<string | null> {
  if (!isClaudeCopyConfigured()) return null;
  try {
    const system = await resolveClaudeSystemPrompt(SYSTEM_WRITING);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: claudeModelId(),
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: user }]
    });
    const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!block?.text?.trim()) return null;
    return block.text.trim();
  } catch (e) {
    console.warn("[Gloria] Claude copy request failed:", e);
    return null;
  }
}

/**
 * First cold outreach from full CRM context + template baseline.
 * No booking URLs in body (product rule for first touch).
 */
export async function composeFirstTouchFromFullLeadWithClaude(
  lead: Lead,
  baselineDraft: string
): Promise<string | null> {
  const user = `${formatFullLeadContextForClaude(lead)}

You are writing the first outbound email for this lead (cold intro from Gloria).

Here is a template-assembled baseline (use for structure/tone; you may rewrite freely but do not invent facts not implied above):
---
${baselineDraft}
---

Requirements: plain text only, under ~220 words, warm and professional. Reference lead context naturally where it helps specificity.

CRITICAL: Do NOT include http(s) links, cal.com URLs, or scheduling links — soft CTA only (e.g. invite them to reply).`;
  const out = await completeUserPrompt(user);
  if (!out) return null;
  if (/https?:\/\//i.test(out)) {
    console.warn("[Gloria] Claude first-touch (full) included a URL; discarding.");
    return null;
  }
  return out;
}

/** First cold outreach: improve baseline while keeping "no raw URL in first touch" policy. */
export async function enhanceFirstTouchWithClaude(lead: MessageLeadInput, baselineDraft: string): Promise<string | null> {
  const user = `${summarizeLeadContext(lead)}

Here is a baseline first-touch email (template-assembled). Rewrite or polish it so it feels natural and specific to this lead, without adding untrue details. Keep similar length (under ~200 words).

IMPORTANT: Do NOT include http(s) links, cal.com URLs, or booking links in this first email. Soft CTA only (e.g. offer to find a time by reply).

Baseline:
---
${baselineDraft}
---
`;
  const out = await completeUserPrompt(user);
  if (!out) return null;
  if (/https?:\/\//i.test(out)) {
    console.warn("[Gloria] Claude first-touch included a URL; falling back to baseline.");
    return null;
  }
  return out;
}

export async function enhanceFollowUp1WithClaude(
  lead: MessageLeadInput,
  firstTouchBody: string,
  baselineDraft: string
): Promise<string | null> {
  const user = `${summarizeLeadContext(lead)}

Prior first-touch email we sent:
---
${firstTouchBody.slice(0, 1200)}
---

Baseline follow-up #1 (bump):
---
${baselineDraft}
---

Polish follow-up #1 so it reads human and consistent with the first touch. Plain text only. Still no pressure. Under ~120 words. Do not add a booking URL unless you use the token ${BOOKING_TOKEN} once at the end.`;
  const out = await completeUserPrompt(user);
  return out ? expandBookingToken(out) : null;
}

export async function enhanceFollowUp2WithClaude(lead: MessageLeadInput, baselineDraft: string): Promise<string | null> {
  const user = `${summarizeLeadContext(lead)}

Baseline final follow-up (breakup-style):
---
${baselineDraft}
---

Polish this last-touch email: respectful, brief, plain text. Under ~130 words. Optional single ${BOOKING_TOKEN} at the end if it fits; otherwise no link.`;
  const out = await completeUserPrompt(user);
  return out ? expandBookingToken(out) : null;
}

/**
 * Regenerates a scheduled follow-up using the live message thread (called from dispatch cron).
 */
export async function composeFollowUpFromThreadWithClaude(
  lead: Lead,
  sequence: 1 | 2,
  conversationTranscript: string,
  firstTouchExcerpt: string,
  storedBaseline: string
): Promise<string | null> {
  const label = sequence === 1 ? "first follow-up (gentle bump)" : "final follow-up (respectful last touch)";
  const user = `${formatFullLeadContextForClaude(lead)}

Recent conversation ("Us" = we emailed, "Them" = they replied):
---
${conversationTranscript.slice(0, 6000)}
---

Original first-touch excerpt:
---
${firstTouchExcerpt.slice(0, 1000)}
---

Previously drafted ${label} (revise if the thread has moved on; if they replied, acknowledge it):
---
${storedBaseline.slice(0, 1400)}
---

Write the ${label} as plain text only, under ~150 words. Must reflect the real thread — do not ignore a substantive reply. Use ${BOOKING_TOKEN} once at the end only if a scheduling invite still makes sense; otherwise no raw URLs.`;

  const out = await completeUserPrompt(user);
  return out ? expandBookingToken(out) : null;
}

export async function draftInboundReplyWithClaude(
  lead: Lead,
  classification: ReplyCategory,
  inboundText: string,
  baselineDraft: string | null
): Promise<string | null> {
  const baseHint = baselineDraft ? `\n\nInternal baseline (you may replace entirely):\n---\n${baselineDraft}\n---\n` : "";
  const user = `${summarizeLeadContext(lead)}

Classifier label: ${classification}
Their email (quote reasonably if short):
---
${inboundText.slice(0, 4000)}
---
${baseHint}

Write a helpful reply as ${appConfig.companyName}. Plain text. If inviting them to schedule, include ${BOOKING_TOKEN} exactly once where the Cal link should go. Under ~220 words.`;
  const out = await completeUserPrompt(user);
  return out ? expandBookingToken(out) : null;
}

export async function draftBookingInviteWithClaude(lead: Lead, inboundText: string): Promise<string | null> {
  const user = `${summarizeLeadContext(lead)}

They wrote:
---
${inboundText.slice(0, 3000)}
---

They are interested or asking to schedule. Write a short, warm email that shares the scheduling link using the token ${BOOKING_TOKEN} exactly once (we replace it with our Cal URL). Plain text, under ~150 words.`;
  const out = await completeUserPrompt(user);
  return out ? expandBookingToken(out) : null;
}

export async function draftUnclearReplyWithClaude(lead: Lead, inboundText: string): Promise<string | null> {
  const user = `${summarizeLeadContext(lead)}

Their message was vague:
---
${inboundText.slice(0, 3000)}
---

Ask one or two friendly clarifying questions. Offer optional next step with ${BOOKING_TOKEN} once. Plain text, under ~180 words.`;
  const out = await completeUserPrompt(user);
  return out ? expandBookingToken(out) : null;
}
