import type { FirstTouchClassification, Lead, LeadType } from "@/types/lead";

function classificationForLeadType(leadType: LeadType): FirstTouchClassification {
  switch (leadType) {
    case "designer":
    case "architect":
      return "designer_architect";
    case "builder":
    case "commercial builder":
      return "builder_contractor";
    case "cabinet shop":
      return "cabinet_shop_partner";
    case "homeowner":
    default:
      return "homeowner";
  }
}

/** Historical outreach floor used for dashboards/readiness messaging. */
export const OUTREACH_ADDRESS_MIN_DEFAULT = 71;

/** Historical "very poor" cutoff used for dashboards/readiness messaging. */
export const OUTREACH_ADDRESS_VERY_POOR_MAX = 10;

/** Historical low-risk cutoff used for dashboards/readiness messaging. */
export const OUTREACH_ADDRESS_LOW_RISK_MAX = 50;

export type AddressConfidenceBand = "strong" | "good" | "caution" | "weak" | "poor" | "unknown";

export function addressConfidenceBand(score: number | null | undefined): AddressConfidenceBand {
  if (score === null || score === undefined || Number.isNaN(score)) return "unknown";
  const s = Math.min(100, Math.max(0, score));
  if (s >= 86) return "strong";
  if (s >= 71) return "good";
  if (s >= 51) return "caution";
  if (s >= 31) return "weak";
  return "poor";
}

export function addressBandLabel(band: AddressConfidenceBand): string {
  switch (band) {
    case "strong":
      return "Strong / verified";
    case "good":
      return "Good";
    case "caution":
      return "Caution";
    case "weak":
      return "Weak";
    case "poor":
      return "Poor";
    default:
      return "Unknown";
  }
}

export function addressScoreForPolicy(lead: Pick<Lead, "addressConfidence">): number {
  const v = lead.addressConfidence;
  if (v === null || v === undefined || Number.isNaN(v)) return -1;
  return Math.min(100, Math.max(0, Math.round(v)));
}

export type LaunchCampaignOptions = {
  /** Skip Verify-tab approval for all leads on campaign launch (use with extreme care). */
  includeUnverifiedHighScore?: boolean;
};

export type EligibilityResult = {
  eligible: boolean;
  reason?: string;
};

/** Campaign address policy is disabled; only DNC can block here. */
export function campaignSendEligibility(
  lead: Pick<Lead, "doNotContact" | "addressConfidence">,
  _opts: LaunchCampaignOptions
): EligibilityResult {
  if (lead.doNotContact) return { eligible: false, reason: "do_not_contact" };
  return { eligible: true };
}

/** Address risk confirm is disabled. */
export function leadNeedsLowAddressConfirm(lead: Pick<Lead, "addressConfidence">): boolean {
  void lead;
  return false;
}

export function needsLowAddressConfirmInBatch(leads: Lead[], opts: LaunchCampaignOptions): boolean {
  void leads;
  void opts;
  return false;
}

/** Readable outreach readiness (does not replace business score). */
export type OutreachReadiness = {
  tier: "ready" | "caution" | "blocked";
  label: string;
  leadScore: number;
  addressConfidence: number | null;
  factors: string[];
};

export function outreachReadiness(lead: Lead): OutreachReadiness {
  const factors: string[] = [];
  const ac = lead.addressConfidence;
  const hasAddr = ac !== null && ac !== undefined && !Number.isNaN(ac);
  const addr = hasAddr ? Math.min(100, Math.max(0, Math.round(ac!))) : null;

  if (lead.doNotContact) {
    factors.push("Do not contact");
    return { tier: "blocked", label: "Suppressed", leadScore: lead.score, addressConfidence: addr, factors };
  }
  if (lead.status === "Not Interested") {
    factors.push("Not interested");
    return { tier: "blocked", label: "Retired", leadScore: lead.score, addressConfidence: addr, factors };
  }
  if (lead.deployVerifyVerdict === "rejected") {
    factors.push("Verify rejected");
    return { tier: "blocked", label: "Verify rejected", leadScore: lead.score, addressConfidence: addr, factors };
  }
  if (!hasAddr) {
    factors.push("Address confidence not set");
  } else if (addr !== null && addr < OUTREACH_ADDRESS_MIN_DEFAULT) {
    factors.push(`Address below default outreach floor (${OUTREACH_ADDRESS_MIN_DEFAULT})`);
  } else if (addr !== null) {
    factors.push(`Address ${addr} (${addressBandLabel(addressConfidenceBand(addr))})`);
  }
  factors.push(`Lead score ${lead.score}`);
  if (lead.deployVerifyVerdict !== "approved") {
    factors.push("Verify tab: not approved yet");
  }

  if (!hasAddr || (addr !== null && addr < OUTREACH_ADDRESS_MIN_DEFAULT)) {
    return { tier: "caution", label: "Needs review / override", leadScore: lead.score, addressConfidence: addr, factors };
  }
  if (addr !== null && addr < 86) {
    return {
      tier: "caution",
      label: lead.deployVerifyVerdict === "approved" ? "Outreach OK — verify copy" : "Address OK — needs Verify ✓",
      leadScore: lead.score,
      addressConfidence: addr,
      factors
    };
  }
  if (lead.deployVerifyVerdict !== "approved") {
    return {
      tier: "caution",
      label: "Strong address — needs Verify ✓",
      leadScore: lead.score,
      addressConfidence: addr,
      factors
    };
  }
  return { tier: "ready", label: "Outreach-ready", leadScore: lead.score, addressConfidence: addr, factors };
}

export function countByAddressBand(leads: Lead[]): Record<AddressConfidenceBand, number> {
  const init: Record<AddressConfidenceBand, number> = {
    strong: 0,
    good: 0,
    caution: 0,
    weak: 0,
    poor: 0,
    unknown: 0
  };
  for (const l of leads) {
    init[addressConfidenceBand(l.addressConfidence)] += 1;
  }
  return init;
}

export function countOutreachReadyByClassification(leads: Lead[]): Record<FirstTouchClassification, number> {
  const empty: Record<FirstTouchClassification, number> = {
    designer_architect: 0,
    builder_contractor: 0,
    cabinet_shop_partner: 0,
    homeowner: 0
  };
  for (const l of leads) {
    const s = addressScoreForPolicy(l);
    if (s < OUTREACH_ADDRESS_MIN_DEFAULT || l.doNotContact) continue;
    const c = classificationForLeadType(l.leadType);
    empty[c] += 1;
  }
  return empty;
}
