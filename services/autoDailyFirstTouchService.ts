import { formatInTimeZone } from "date-fns-tz";
import { googleCalendarConfig } from "@/config/googleCalendarConfig";
import { db } from "@/lib/db";
import { mapDbLeadToLead } from "@/lib/mappers";
import type { LaunchCampaignOptions } from "@/services/addressConfidencePolicy";
import { launchCampaign, type LaunchCampaignResult } from "@/services/persistenceService";
import { isEligibleForCampaignSend } from "@/services/deployVerifyPolicy";
import { leadNeedsLowAddressConfirm } from "@/services/addressConfidencePolicy";
import { compareLeadsForLibrary } from "@/services/scoringService";
import type { Lead } from "@/types/lead";

const RUNTIME_ID = "default";

/** Conservative: default outreach floor, no very poor, no unverified, no low-address batch without UI confirm. */
export const AUTO_DAILY_LAUNCH_OPTS: LaunchCampaignOptions = {
  includeBelowOutreachMin: false,
  includeVeryPoorAddress: false,
  confirmLowAddressRisk: false,
  includeUnverifiedHighScore: false
};

/** Business-local 08:00–09:59 (see BUSINESS_TIMEZONE). */
export function isWithinAutoDailyMorningWindow(reference: Date = new Date()): boolean {
  const tz = googleCalendarConfig.businessTimezone;
  const hour = Number(formatInTimeZone(reference, tz, "H"));
  return hour >= 8 && hour < 10;
}

export async function findEligibleAutoDailyLeadIds(): Promise<string[]> {
  const touchedRows = await db.message.findMany({
    where: {
      kind: "first_touch",
      status: { in: ["sent", "dry_run"] }
    },
    select: { leadId: true },
    distinct: ["leadId"]
  });
  const touched = new Set(touchedRows.map((r) => r.leadId));

  const rows = await db.lead.findMany({
    where: {
      deployVerifyVerdict: "approved",
      doNotContact: false
    }
  });

  const dtos: Lead[] = rows
    .filter((r) => !touched.has(r.id))
    .map((r) => mapDbLeadToLead(r))
    .filter((lead) => {
      if (!isEligibleForCampaignSend(lead, AUTO_DAILY_LAUNCH_OPTS)) return false;
      if (leadNeedsLowAddressConfirm(lead)) return false;
      return true;
    });

  dtos.sort(compareLeadsForLibrary);
  return dtos.map((l) => l.id);
}

export async function runAutoDailyFirstTouchJob(): Promise<{
  ok: boolean;
  skippedReason?: string;
  result?: LaunchCampaignResult;
}> {
  const row = await db.dashboardRuntimeConfig.findUnique({ where: { id: RUNTIME_ID } });
  if (!row?.autoDailyFirstTouchEnabled) {
    return { ok: true, skippedReason: "disabled" };
  }
  if (!isWithinAutoDailyMorningWindow()) {
    return { ok: true, skippedReason: "outside_window" };
  }

  const leadIds = await findEligibleAutoDailyLeadIds();
  if (leadIds.length === 0) {
    return { ok: true, skippedReason: "no_eligible_leads" };
  }

  const tz = googleCalendarConfig.businessTimezone;
  const name = `Auto first touch · ${formatInTimeZone(new Date(), tz, "MMM d, yyyy · h:mm a")}`;
  const result = await launchCampaign(name, leadIds, AUTO_DAILY_LAUNCH_OPTS);
  return { ok: result.ok, result };
}
