import { appConfig } from "@/config/appConfig";
import { Lead, LeadSource, LeadType, PriorityTier, ProjectTier } from "@/types/lead";

/**
 * Pipeline score (0–100): email → lead type → drive-time distance → source → spend.
 * Does **not** use CSV address-confidence %; that field is for outreach/copy QA only.
 * Distance is estimated minutes (e.g. from ZIP), not “how good the street address looks,”
 * so pros who used a home address are not over-penalized on fit score for that reason.
 */
export interface ScoreBreakdown {
  emailPresentScore: number;
  leadTypeScore: number;
  distanceScore: number;
  sourceScore: number;
  spendScore: number;
}

const LEAD_TYPE_ORDER: LeadType[] = [
  "designer",
  "builder",
  "architect",
  "commercial builder",
  "cabinet shop",
  "homeowner"
];

const LEAD_TYPE_POINTS: Record<LeadType, number> = {
  designer: 30,
  builder: 26,
  architect: 22,
  "commercial builder": 19,
  "cabinet shop": 15,
  homeowner: 5
};

const SOURCE_POINTS: Record<LeadSource, number> = {
  "Scraped / External": 15,
  "Online Enriched": 11,
  Manual: 7,
  "CSV Import": 3
};

/** CSV rows that completed online enrich behave like Online Enriched for scoring (not the raw sheet %). */
export function resolvedSourceForScore(
  source: LeadSource,
  enrichmentStatus: Lead["enrichmentStatus"] | undefined
): LeadSource {
  if (source === "Scraped / External") return "Scraped / External";
  if (source === "Online Enriched") return "Online Enriched";
  if (source === "CSV Import" && enrichmentStatus === "enriched") return "Online Enriched";
  return source;
}

function hasActionableEmail(email: string): boolean {
  const t = email.trim().toLowerCase();
  if (t.length < 5) return false;
  if (!t.includes("@")) return false;
  const [local, domain] = t.split("@");
  if (!local || !domain || !domain.includes(".")) return false;
  return true;
}

function distancePoints(distanceMinutes: number): number {
  const max = appConfig.maxDistanceMinutes;
  const d = Number.isFinite(distanceMinutes) ? Math.max(0, distanceMinutes) : max;
  if (d >= max) return 0;
  return Math.round(20 * (1 - d / max));
}

function spendPoints(amountSpent: number): number {
  const tier = estimateProjectTier(amountSpent);
  switch (tier) {
    case "$20k-$40k":
      return 10;
    case "Sub-$20k":
      return 7;
    case "$40k-$100k":
      return 8;
    case "$100k-$300k":
      return 5;
    case "$300k+":
      return 3;
    default:
      return 4;
  }
}

/** Higher = earlier in pipeline when scores tie (designer > builder > … > homeowner). */
export function leadTypePriorityRank(leadType: LeadType): number {
  const i = LEAD_TYPE_ORDER.indexOf(leadType);
  if (i === -1) return -1;
  return LEAD_TYPE_ORDER.length - 1 - i;
}

/** Sort: score desc, then lead-type priority, then name. */
export function compareLeadsByPipelinePriority(
  a: Pick<Lead, "id" | "score" | "fullName" | "leadType">,
  b: Pick<Lead, "id" | "score" | "fullName" | "leadType">
): number {
  if (b.score !== a.score) return b.score - a.score;
  const ra = leadTypePriorityRank(a.leadType);
  const rb = leadTypePriorityRank(b.leadType);
  if (rb !== ra) return rb - ra;
  const na = (a.fullName || "").toLowerCase();
  const nb = (b.fullName || "").toLowerCase();
  if (na !== nb) return na.localeCompare(nb);
  return a.id.localeCompare(b.id);
}

/** Verify queue: newest leads first (e.g. daily Places batch), then score / type / name. */
export function compareVerifyQueue(
  a: Pick<Lead, "id" | "score" | "fullName" | "leadType" | "createdAt">,
  b: Pick<Lead, "id" | "score" | "fullName" | "leadType" | "createdAt">
): number {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (tb !== ta) return tb - ta;
  return compareLeadsByPipelinePriority(a, b);
}

export function estimateProjectTier(amountSpent: number): ProjectTier {
  if (amountSpent <= 20000) return "Sub-$20k";
  if (amountSpent <= 40000) return "$20k-$40k";
  if (amountSpent <= 100000) return "$40k-$100k";
  if (amountSpent <= 300000) return "$100k-$300k";
  return "$300k+";
}

export type ScoreLeadBaseInput = Pick<Lead, "email" | "distanceMinutes" | "amountSpent" | "leadType"> & {
  source: LeadSource;
  enrichmentStatus?: Lead["enrichmentStatus"];
};

export function scoreLeadBase(input: ScoreLeadBaseInput) {
  const tier = estimateProjectTier(input.amountSpent);
  const emailPresentScore = hasActionableEmail(input.email) ? 25 : 0;
  const leadTypeScore = LEAD_TYPE_POINTS[input.leadType] ?? LEAD_TYPE_POINTS.homeowner;
  const distanceScore = distancePoints(input.distanceMinutes);
  const src = resolvedSourceForScore(input.source, input.enrichmentStatus);
  const sourceScore = SOURCE_POINTS[src] ?? SOURCE_POINTS["CSV Import"];
  const spendScore = spendPoints(input.amountSpent);

  const breakdown: ScoreBreakdown = {
    emailPresentScore,
    leadTypeScore,
    distanceScore,
    sourceScore,
    spendScore
  };

  const score = Math.max(
    0,
    Math.min(100, Math.round(emailPresentScore + leadTypeScore + distanceScore + sourceScore + spendScore))
  );

  const projectFitScore = Math.min(100, Math.round(leadTypeScore + spendScore * 1.2));
  const conversionScore = Math.min(
    100,
    Math.round(emailPresentScore * 1.2 + sourceScore + distanceScore * 0.85 + spendScore * 0.5)
  );

  const priorityTier: PriorityTier = score >= 78 ? "Tier A" : score >= 60 ? "Tier B" : score >= 42 ? "Tier C" : "Tier D";

  return { score, conversionScore, projectFitScore, priorityTier, estimatedProjectTier: tier, breakdown };
}

/**
 * Pre-outreach pipeline status from fit tier. Matches dashboard "Qualified" metric (Tier A / B).
 * "In Campaign" and later stages are set only when messaging runs; see `launchCampaign`.
 */
export function pipelineStatusForTier(priorityTier: PriorityTier): "New" | "Qualified" {
  return priorityTier === "Tier A" || priorityTier === "Tier B" ? "Qualified" : "New";
}
