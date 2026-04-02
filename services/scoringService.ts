import { appConfig } from "@/config/appConfig";
import { Lead, LeadType, PriorityTier, ProjectTier } from "@/types/lead";

export interface ScoreBreakdown {
  locationScore: number;
  financialCapacityScore: number;
  leadTypeScore: number;
  intentSignalScore: number;
  projectFitScore: number;
  relationshipScore: number;
  conversionProbabilityScore: number;
  largeProjectPenalty: number;
}

/** Trade types (designer / builder / etc.) are weighted far above homeowner so pipeline sorts surface pros first. */
const leadTypeWeights: Record<LeadType, number> = {
  homeowner: 6,
  designer: 26,
  builder: 26,
  architect: 25,
  "cabinet shop": 20,
  "commercial builder": 24
};

/** When scores tie, higher rank sorts first (trade before homeowner). */
function tradePipelineRank(leadType: LeadType): number {
  switch (leadType) {
    case "designer":
    case "architect":
    case "builder":
    case "commercial builder":
      return 4;
    case "cabinet shop":
      return 3;
    case "homeowner":
      return 0;
    default:
      return 0;
  }
}

/** Sort key for lead tables and Verify: best score first, then trade over homeowner, then name. */
export function compareLeadsByPipelinePriority(
  a: Pick<Lead, "id" | "score" | "fullName" | "leadType">,
  b: Pick<Lead, "id" | "score" | "fullName" | "leadType">
): number {
  if (b.score !== a.score) return b.score - a.score;
  const ra = tradePipelineRank(a.leadType);
  const rb = tradePipelineRank(b.leadType);
  if (rb !== ra) return rb - ra;
  const na = (a.fullName || "").toLowerCase();
  const nb = (b.fullName || "").toLowerCase();
  if (na !== nb) return na.localeCompare(nb);
  return a.id.localeCompare(b.id);
}

export function estimateProjectTier(amountSpent: number): ProjectTier {
  if (amountSpent <= 20000) return "Sub-$20k";
  if (amountSpent <= 40000) return "$20k-$40k";
  if (amountSpent <= 100000) return "$40k-$100k";
  if (amountSpent <= 300000) return "$100k-$300k";
  return "$300k+";
}

/** Business / fit score only (distance, spend tier, lead type). Addr % is manual pre-deploy QA, not scored here. */
export function scoreLeadBase(lead: Pick<Lead, "distanceMinutes" | "amountSpent" | "leadType">) {
  if (lead.distanceMinutes > appConfig.maxDistanceMinutes) {
    return {
      score: 0,
      conversionScore: 0,
      projectFitScore: 0,
      priorityTier: "Tier D" as PriorityTier,
      estimatedProjectTier: estimateProjectTier(lead.amountSpent),
      breakdown: {
        locationScore: 0,
        financialCapacityScore: 0,
        leadTypeScore: 0,
        intentSignalScore: 0,
        projectFitScore: 0,
        relationshipScore: 0,
        conversionProbabilityScore: 0,
        largeProjectPenalty: 0
      }
    };
  }

  const tier = estimateProjectTier(lead.amountSpent);
  const locationScore = lead.distanceMinutes <= appConfig.maxDistanceMinutes ? 20 : 0;
  const financialCapacityScore = tier === "$20k-$40k" ? 24 : tier === "Sub-$20k" ? 14 : tier === "$40k-$100k" ? 12 : 6;
  const leadTypeScore = leadTypeWeights[lead.leadType];
  const intentSignalScore = lead.distanceMinutes <= 35 ? 10 : 6;
  const projectFitScore = tier === "$20k-$40k" ? 20 : tier === "Sub-$20k" ? 12 : 8;
  const relationshipScore =
    lead.leadType === "homeowner" ? 3 : lead.leadType === "cabinet shop" ? 9 : 10;
  const conversionProbabilityScore = Math.min(18, Math.max(5, 30 - lead.distanceMinutes / 3));
  const largeProjectPenalty = tier === "$300k+" ? 35 : 0;

  const breakdown: ScoreBreakdown = {
    locationScore,
    financialCapacityScore,
    leadTypeScore,
    intentSignalScore,
    projectFitScore,
    relationshipScore,
    conversionProbabilityScore,
    largeProjectPenalty
  };
  const score = Math.max(
    0,
    Math.round(
      locationScore +
        financialCapacityScore +
        leadTypeScore +
        intentSignalScore +
        projectFitScore +
        relationshipScore +
        conversionProbabilityScore -
        largeProjectPenalty
    )
  );
  const conversionScore = Math.round((conversionProbabilityScore + relationshipScore + intentSignalScore) * 2.2);
  const priorityTier: PriorityTier = score >= 75 ? "Tier A" : score >= 55 ? "Tier B" : score >= 38 ? "Tier C" : "Tier D";
  return { score, conversionScore, projectFitScore, priorityTier, estimatedProjectTier: tier, breakdown };
}

/**
 * Pre-outreach pipeline status from fit tier. Matches dashboard "Qualified" metric (Tier A / B).
 * "In Campaign" and later stages are set only when messaging runs; see `launchCampaign`.
 */
export function pipelineStatusForTier(priorityTier: PriorityTier): "New" | "Qualified" {
  return priorityTier === "Tier A" || priorityTier === "Tier B" ? "Qualified" : "New";
}
