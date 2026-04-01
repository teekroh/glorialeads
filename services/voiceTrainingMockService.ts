import Anthropic from "@anthropic-ai/sdk";
import { claudeModelId, isClaudeCopyConfigured } from "@/config/claudeConfig";
import type { VoiceTrainScenarioKind } from "@/config/voiceTrainScenarios";
import { VOICE_TRAIN_SCENARIOS } from "@/config/voiceTrainScenarios";
import { resolveClaudeSystemPrompt } from "@/services/claudeSystemPrompt";
import { formatFullLeadContextForClaude } from "@/services/leadContextFormatting";
import type { Lead } from "@/types/lead";

export { VOICE_TRAIN_SCENARIOS, type VoiceTrainScenarioKind } from "@/config/voiceTrainScenarios";

const MOCK_LEAD: Lead = {
  id: "voice-train-mock",
  firstName: "Alex",
  lastName: "Rivera",
  fullName: "Alex Rivera",
  company: "Rivera Design",
  email: "alex.rivera@example.com",
  phone: "",
  city: "Doylestown",
  state: "PA",
  zip: "18901",
  leadType: "designer",
  source: "CSV Import",
  sourceDetail: "Houzz scrape · kitchen remodel interest",
  amountSpent: 0,
  notes: "Renovation timeline 6–9 months; prefers email first.",
  distanceMinutes: 25,
  score: 72,
  conversionScore: 65,
  projectFitScore: 70,
  estimatedProjectTier: "$40k-$100k",
  priorityTier: "Tier B",
  status: "In Campaign",
  doNotContact: false,
  deployVerifyVerdict: "approved",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  enrichmentStatus: "enriched",
  locationConfidence: "high",
  addressConfidence: 86,
  confidenceNotes: "",
  importedFromCsv: true,
  outreachHistory: [],
  replyHistory: [],
  bookingHistory: [],
  tags: []
};

const FIRST_TOUCH_STUB = `Hi Alex — [example first touch about custom millwork; soft CTA, no link]`;

function userPromptForScenario(kind: VoiceTrainScenarioKind): string {
  const ctx = formatFullLeadContextForClaude(MOCK_LEAD);
  switch (kind) {
    case "first_touch":
      return `${ctx}\n\nWrite a cold first-touch email body for this lead. No booking URL or http links — soft CTA only. Under ~200 words.`;
    case "follow_up_1":
      return `${ctx}\n\nWe already sent this first touch:\n---\n${FIRST_TOUCH_STUB}\n---\n\nWrite follow-up #1 (gentle bump). May use {{BOOKING_LINK}} once at end if appropriate. Under ~140 words.`;
    case "follow_up_2":
      return `${ctx}\n\nWrite the final "breakup" follow-up — respectful last touch. Optional {{BOOKING_LINK}} once. Under ~130 words.`;
    case "reply_pricing":
      return `${ctx}\n\nThey replied: "What does a typical kitchen like this run ballpark?"\n\nWrite our reply body. Use {{BOOKING_LINK}} for scheduling. Under ~200 words.`;
    case "reply_info":
      return `${ctx}\n\nThey replied: "Can you share more about your process and lead times?"\n\nWrite our factual reply body. Under ~200 words. Optional {{BOOKING_LINK}} once.`;
    case "reply_unclear":
      return `${ctx}\n\nThey replied: "Thanks, will look at this next week."\n\nWrite a short clarifying reply — warm, not pushy. Under ~160 words. Optional {{BOOKING_LINK}}.`;
    case "booking_invite":
      return `${ctx}\n\nThey replied: "Yes let's find a time to talk."\n\nWrite a short email with scheduling intent. Must include {{BOOKING_LINK}} once. Under ~120 words.`;
    default:
      return `${ctx}\n\nWrite a professional outreach email snippet.`;
  }
}

const TASK_RULES = `You write plain-text email body copy only (no subject line, no markdown).
When a scheduling URL is needed, use the token {{BOOKING_LINK}} once — never invent URLs.`;

export async function generateVoiceTrainingMock(kind: VoiceTrainScenarioKind): Promise<string | null> {
  if (!isClaudeCopyConfigured()) return null;
  if (!(VOICE_TRAIN_SCENARIOS as readonly string[]).includes(kind)) return null;

  try {
    const system = await resolveClaudeSystemPrompt(TASK_RULES);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: claudeModelId(),
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: userPromptForScenario(kind) }]
    });
    const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return block?.text?.trim() ?? null;
  } catch (e) {
    console.warn("[Gloria] Voice training mock generation failed:", e);
    return null;
  }
}
