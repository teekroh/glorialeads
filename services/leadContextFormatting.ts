import type { Lead } from "@/types/lead";

/** Rich CRM snapshot for Claude (campaign + safety + voice training mocks). */
export function formatFullLeadContextForClaude(lead: Lead): string {
  const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);
  return [
    "=== Lead record (database) ===",
    `id: ${lead.id}`,
    `fullName: ${lead.fullName}`,
    `firstName: ${lead.firstName}`,
    `lastName: ${lead.lastName}`,
    `company: ${lead.company || "—"}`,
    `email: ${lead.email}`,
    `phone: ${lead.phone || "—"}`,
    `city: ${lead.city || "—"}`,
    `state: ${lead.state || "—"}`,
    `zip: ${lead.zip || "—"}`,
    `leadType: ${lead.leadType}`,
    `source: ${lead.source}`,
    `sourceDetail: ${clip(lead.sourceDetail || "", 400)}`,
    `amountSpent: ${lead.amountSpent}`,
    `notes: ${clip(lead.notes || "", 600)}`,
    `distanceMinutes: ${lead.distanceMinutes}`,
    `score / conversion / projectFit: ${lead.score} / ${lead.conversionScore} / ${lead.projectFitScore}`,
    `estimatedProjectTier: ${lead.estimatedProjectTier}`,
    `priorityTier: ${lead.priorityTier}`,
    `status: ${lead.status}`,
    `doNotContact: ${lead.doNotContact}`,
    `deployVerifyVerdict: ${lead.deployVerifyVerdict ?? "—"}`,
    `enrichmentStatus: ${lead.enrichmentStatus ?? "—"}`,
    `locationConfidence: ${lead.locationConfidence ?? "—"}`,
    `addressConfidence: ${lead.addressConfidence ?? "—"}`,
    `confidenceNotes: ${clip(lead.confidenceNotes || "", 300)}`,
    `importedFromCsv: ${lead.importedFromCsv}`,
    `lastContactedAt: ${lead.lastContactedAt ?? "—"}`,
    `nextFollowUpAt: ${lead.nextFollowUpAt ?? "—"}`,
    `createdAt: ${lead.createdAt}`,
    `tags: ${(lead.tags ?? []).join(", ") || "—"}`
  ].join("\n");
}
