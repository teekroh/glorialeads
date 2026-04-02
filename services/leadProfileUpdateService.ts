import { db } from "@/lib/db";
import { LEAD_PROFILE_TYPES } from "@/lib/leadProfileDraft";
import { normalizeWebsiteHost } from "@/services/placesLeadDiscoveryService";
import { scoreLeadBase } from "@/services/scoringService";
import type { LeadSource, LeadType, PriorityTier } from "@/types/lead";

/** Rejected in Verify: force last place in score-based sorts (trade types otherwise stay Tier B/C from floors). */
const VERIFY_REJECTED_SCORE = 0;
const VERIFY_REJECTED_TIER: PriorityTier = "Tier D";

function normalizeEmailInput(value: string): string | null {
  const t = value.trim().toLowerCase();
  if (!t) return null;
  if (!t.includes("@")) return null;
  return t;
}

function splitFullName(raw: string): { firstName: string; lastName: string; fullName: string } {
  const fn = raw.trim().replace(/\s+/g, " ");
  if (!fn) return { firstName: "", lastName: "", fullName: "" };
  const idx = fn.indexOf(" ");
  if (idx === -1) return { firstName: fn, lastName: "", fullName: fn };
  const firstName = fn.slice(0, idx).trim();
  const lastName = fn.slice(idx + 1).trim();
  return { firstName, lastName, fullName: fn };
}

export type ApplyLeadProfileOptions = {
  /** When set (Verify approve/reject), updates verdict; when omitted (library PATCH), verdict is unchanged. */
  deployVerifyVerdict?: "approved" | "rejected";
};

export type ApplyLeadProfileResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Validates profile payload, recomputes score from type/email/source, updates lead.
 * Used by Verify (with verdict) and lead library PATCH (without).
 */
export async function applyLeadProfileUpdate(
  id: string,
  profile: unknown,
  options?: ApplyLeadProfileOptions
): Promise<ApplyLeadProfileResult> {
  const existing = await db.lead.findUnique({ where: { id } });
  if (!existing) return { ok: false, status: 404, error: "not_found" };

  if (!profile || typeof profile !== "object") {
    return { ok: false, status: 400, error: "profile_required" };
  }

  const p = profile as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? String(p[k]).trim() : "");

  const names = splitFullName(str("fullName"));
  if (!names.firstName) {
    return { ok: false, status: 400, error: "full_name_required" };
  }

  const emailRaw = str("email");
  const emailNorm = normalizeEmailInput(emailRaw);
  if (emailRaw && !emailNorm) {
    return { ok: false, status: 400, error: "invalid_email" };
  }
  const emailOut = emailNorm ?? "";

  if (emailOut) {
    const duplicate = await db.lead.findFirst({
      where: { email: { equals: emailOut, mode: "insensitive" }, NOT: { id } }
    });
    if (duplicate) {
      return { ok: false, status: 409, error: "duplicate_email" };
    }
  }

  const leadTypeRaw = str("leadType") as LeadType;
  if (!LEAD_PROFILE_TYPES.includes(leadTypeRaw)) {
    return { ok: false, status: 400, error: "invalid_lead_type" };
  }

  const company = str("company");
  const phone = str("phone");
  const city = str("city");
  const state = str("state");
  const zip = str("zip");
  const notes = typeof p.notes === "string" ? p.notes : "";

  const w = str("websiteUri");
  let websiteUriOut: string | null = null;
  let websiteHostOut: string | null = null;
  if (w) {
    const normalized = w.startsWith("http") ? w : `https://${w}`;
    websiteUriOut = normalized;
    websiteHostOut = normalizeWebsiteHost(normalized);
  }

  const enrichmentStatus = existing.enrichmentStatus === "enriched" ? "enriched" : "none";

  const scored = scoreLeadBase({
    email: emailOut,
    source: existing.source as LeadSource,
    enrichmentStatus,
    distanceMinutes: existing.distanceMinutes,
    amountSpent: existing.amountSpent,
    leadType: leadTypeRaw
  });

  const rejectedVerify = options?.deployVerifyVerdict === "rejected";
  const score = rejectedVerify ? VERIFY_REJECTED_SCORE : scored.score;
  const conversionScore = rejectedVerify ? VERIFY_REJECTED_SCORE : scored.conversionScore;
  const projectFitScore = rejectedVerify ? VERIFY_REJECTED_SCORE : scored.projectFitScore;
  const priorityTier = rejectedVerify ? VERIFY_REJECTED_TIER : scored.priorityTier;
  const isoDate = new Date().toISOString().slice(0, 10);
  const rejectNote = `[Verify ${isoDate}] Rejected — demoted to ${VERIFY_REJECTED_TIER} (sorted to back of list).`;
  const confidenceNotesOut = rejectedVerify
    ? [existing.confidenceNotes?.trim(), rejectNote].filter(Boolean).join(" \n")
    : existing.confidenceNotes ?? "";

  const fullNameOut = names.fullName || `${names.firstName} ${names.lastName}`.trim();

  await db.lead.update({
    where: { id },
    data: {
      firstName: names.firstName,
      lastName: names.lastName,
      fullName: fullNameOut,
      company,
      email: emailOut,
      phone,
      city,
      state,
      zip,
      notes,
      leadType: leadTypeRaw,
      websiteUri: websiteUriOut,
      websiteHost: websiteHostOut,
      score,
      conversionScore,
      projectFitScore,
      estimatedProjectTier: scored.estimatedProjectTier,
      priorityTier,
      scoreBreakdownJson: JSON.stringify(scored.breakdown),
      confidenceNotes: confidenceNotesOut,
      ...(options?.deployVerifyVerdict !== undefined
        ? { deployVerifyVerdict: options.deployVerifyVerdict }
        : {}),
      updatedAt: new Date()
    }
  });

  return { ok: true };
}
