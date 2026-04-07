import type { Lead } from "@/types/lead";
import type { EligibilityResult, LaunchCampaignOptions } from "@/services/addressConfidencePolicy";
import { campaignSendEligibility } from "@/services/addressConfidencePolicy";

/**
 * Historical threshold — Verify queue UI still sorts by score; **every** lead must be Verify-approved
 * before campaign send (unless `includeUnverifiedHighScore` override).
 */
export const DEPLOY_VERIFY_MIN_SCORE = 75;

export type DeployVerifyVerdict = "approved" | "rejected";

/** All leads require a Verify-tab decision before campaign launch (approve or reject). */
export function leadNeedsDeployVerify(_lead: Pick<Lead, "score">): boolean {
  return true;
}

/**
 * Blocks campaign sends when Verify is not approved (all leads).
 * `includeUnverifiedHighScore` skips this gate (dangerous).
 */
export function deployVerifySendGate(
  lead: Pick<Lead, "score" | "deployVerifyVerdict">,
  opts: { includeUnverifiedHighScore?: boolean }
): EligibilityResult | null {
  if (lead.deployVerifyVerdict === "rejected") {
    return { eligible: false, reason: "verify_rejected" };
  }
  if (opts.includeUnverifiedHighScore) return null;
  if (lead.deployVerifyVerdict !== "approved") {
    return { eligible: false, reason: "verify_pending" };
  }
  return null;
}

/** Verify gate + DNC check (address gating removed) — use for campaign preview and launch. */
export function isEligibleForCampaignSend(lead: Lead, opts: LaunchCampaignOptions): boolean {
  const g = deployVerifySendGate(lead, opts);
  if (g && !g.eligible) return false;
  return campaignSendEligibility(lead, opts).eligible;
}
