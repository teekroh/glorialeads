import { isClaudeCopyConfigured } from "@/config/claudeConfig";
import { draftInboundReplyWithClaude } from "@/services/claudeCopyService";
import { draftInfoReply, draftPricingReply, draftSuggestedTimeReply } from "@/services/replyDraftTemplates";
import { Lead, ReplyCategory } from "@/types/lead";

export { draftSuggestedTimeReply, draftPricingReply, draftInfoReply } from "@/services/replyDraftTemplates";

function templateAutomatedDraft(lead: Lead, classification: ReplyCategory, inboundText: string): string | null {
  switch (classification) {
    case "suggested_time":
      return draftSuggestedTimeReply(lead, inboundText);
    case "pricing_question":
      return draftPricingReply();
    case "info_request":
      return draftInfoReply(lead);
    default:
      return null;
  }
}

/**
 * Automated reply draft: Claude (if configured), otherwise built-in templates.
 */
export async function buildAutomatedReplyDraft(
  lead: Lead,
  classification: ReplyCategory,
  inboundText: string
): Promise<string | null> {
  const baseline = templateAutomatedDraft(lead, classification, inboundText);
  if (isClaudeCopyConfigured()) {
    const ai = await draftInboundReplyWithClaude(lead, classification, inboundText, baseline);
    if (ai) return ai;
  }
  return baseline;
}
