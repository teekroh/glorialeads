import { db } from "@/lib/db";
import { mapDbLeadToLead } from "@/lib/mappers";
import { importCsvLeads } from "@/data/importLeads";
import { mockDiscoveredLeads } from "@/services/externalDiscoveryService";
import { outreachConfig } from "@/config/outreachConfig";
import { isClaudeCopyConfigured } from "@/config/claudeConfig";
import {
  composeFirstTouchFromFullLeadWithClaude,
  enhanceFollowUp1WithClaude,
  enhanceFollowUp2WithClaude
} from "@/services/claudeCopyService";
import { generateFirstTouchMessage } from "@/services/firstTouchMessageGenerator";
import { generateFollowUp1Message, generateFollowUp2Message } from "@/services/followUpMessageGenerator";
import { addBusinessDays, uid } from "@/lib/utils";
import { getBookingLink, getBookingLinkForDisplay, getBookingReplyTemplate, isBookingLinkConfigured } from "@/config/bookingCopy";
import { aggregateDashboard, LeadWithCampaigns } from "@/services/dashboardAggregation";
import { listDashboardNotifications } from "@/services/dashboardNotificationService";
import { processInboundEmail } from "@/services/inboundProcessingService";
import { sendOutreachEmail } from "@/services/outreachSendService";
import { geocodeCityStateZip } from "@/services/nominatimGeocode";
import { pipelineStatusForTier, scoreLeadBase } from "@/services/scoringService";
import type { CreateManualLeadPayload, Lead, LeadStatus } from "@/types/lead";
import {
  campaignSendEligibility,
  needsLowAddressConfirmInBatch,
  type LaunchCampaignOptions
} from "@/services/addressConfidencePolicy";
import { deployVerifySendGate, isEligibleForCampaignSend } from "@/services/deployVerifyPolicy";
import { listVoiceTrainingNotes } from "@/services/voiceTrainingStorage";
import { getEffectiveOutreachDryRun, getOutreachDryRunDashboardState } from "@/services/outreachDryRunService";

const OWNER_LEAD_ID = "lead-owner-tim-kroh";

/** Persists a Manual lead for Tim so you can launch campaigns to your own inbox. */
export const ensureOwnerTestLead = async () => {
  const now = new Date();
  const scored = scoreLeadBase({
    distanceMinutes: 10,
    amountSpent: 30000,
    leadType: "homeowner"
  });
  await db.lead.upsert({
    where: { id: OWNER_LEAD_ID },
    create: {
      id: OWNER_LEAD_ID,
      firstName: "Tim",
      lastName: "Kroh",
      fullName: "Tim Kroh",
      company: "Gloria Custom Cabinetry",
      email: "timothyjkroh@gmail.com",
      phone: "",
      city: "Hatfield",
      state: "PA",
      zip: "19440",
      leadType: "homeowner",
      source: "Manual",
      sourceDetail: "Owner test lead — use for live Resend verification (not from CSV).",
      enrichmentStatus: "none",
      locationConfidence: "high",
      addressConfidence: 95,
      confidenceNotes: "Manual owner test lead — verified address.",
      importedFromCsv: false,
      amountSpent: 30000,
      notes: "Select only this lead when testing real sends.",
      distanceMinutes: 10,
      score: scored.score,
      conversionScore: scored.conversionScore,
      projectFitScore: scored.projectFitScore,
      estimatedProjectTier: scored.estimatedProjectTier,
      priorityTier: scored.priorityTier,
      status: "New",
      doNotContact: false,
      deployVerifyVerdict: "approved",
      scoreBreakdownJson: JSON.stringify(scored.breakdown),
      createdAt: now,
      updatedAt: now
    },
    update: {
      firstName: "Tim",
      lastName: "Kroh",
      fullName: "Tim Kroh",
      email: "timothyjkroh@gmail.com",
      source: "Manual",
      locationConfidence: "high",
      addressConfidence: 95,
      confidenceNotes: "Manual owner test lead — verified address.",
      importedFromCsv: false,
      deployVerifyVerdict: "approved",
      score: scored.score,
      conversionScore: scored.conversionScore,
      projectFitScore: scored.projectFitScore,
      priorityTier: scored.priorityTier,
      estimatedProjectTier: scored.estimatedProjectTier,
      scoreBreakdownJson: JSON.stringify(scored.breakdown),
      updatedAt: now
    }
  });
};

/** Creates a single lead with source Manual, recompute score from distance / spend / type. */
export const createManualLead = async (
  input: CreateManualLeadPayload
): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
  const email = input.email.trim().toLowerCase();
  if (!email) return { ok: false, error: "email_required" };

  const existing = await db.lead.findFirst({
    where: { email: { equals: email, mode: "insensitive" } }
  });
  if (existing) return { ok: false, error: "duplicate_email" };

  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName || !lastName) return { ok: false, error: "name_required" };

  const fullName = `${firstName} ${lastName}`.trim();
  const now = new Date();
  const amountSpent = Number.isFinite(input.amountSpent) ? Number(input.amountSpent) : 0;
  const distanceMinutes =
    Number.isFinite(input.distanceMinutes) ? Math.max(0, Math.round(Number(input.distanceMinutes))) : 30;

  const scored = scoreLeadBase({
    distanceMinutes,
    amountSpent,
    leadType: input.leadType
  });

  const id = uid();
  const addr =
    input.addressConfidence !== null && input.addressConfidence !== undefined && Number.isFinite(input.addressConfidence)
      ? Math.min(100, Math.max(0, Math.round(Number(input.addressConfidence))))
      : null;

  await db.lead.create({
    data: {
      id,
      firstName,
      lastName,
      fullName,
      company: (input.company ?? "").trim(),
      email,
      phone: (input.phone ?? "").trim(),
      city: (input.city ?? "").trim(),
      state: (input.state ?? "").trim(),
      zip: (input.zip ?? "").trim(),
      leadType: input.leadType,
      source: "Manual",
      sourceDetail: (input.sourceDetail ?? "").trim() || "Added from lead library",
      enrichmentStatus: "none",
      locationConfidence: null,
      addressConfidence: addr,
      confidenceNotes: "",
      importedFromCsv: false,
      amountSpent,
      notes: (input.notes ?? "").trim(),
      distanceMinutes,
      score: scored.score,
      conversionScore: scored.conversionScore,
      projectFitScore: scored.projectFitScore,
      estimatedProjectTier: scored.estimatedProjectTier,
      priorityTier: scored.priorityTier,
      status: pipelineStatusForTier(scored.priorityTier),
      doNotContact: false,
      deployVerifyVerdict: null,
      scoreBreakdownJson: JSON.stringify(scored.breakdown),
      createdAt: now,
      updatedAt: now
    }
  });

  return { ok: true, id };
};

export const ensureSeeded = async () => {
  const count = await db.lead.count();
  if (count > 0) return;
  const now = new Date();
  const { leads: csvLeads } = importCsvLeads();
  const discovered = mockDiscoveredLeads();
  const all = [...csvLeads, ...discovered];

  await db.lead.createMany({
    data: all.map((lead) => ({
      id: lead.id,
      firstName: lead.firstName,
      lastName: lead.lastName,
      fullName: lead.fullName,
      company: lead.company,
      email: lead.email,
      phone: lead.phone,
      city: lead.city,
      state: lead.state,
      zip: lead.zip,
      leadType: lead.leadType,
      source: lead.source,
      sourceDetail: lead.sourceDetail,
      enrichmentStatus: lead.enrichmentStatus ?? "none",
      addressConfidence: lead.addressConfidence ?? null,
      confidenceNotes: lead.confidenceNotes ?? "",
      importedFromCsv: lead.importedFromCsv,
      amountSpent: lead.amountSpent,
      notes: lead.notes,
      distanceMinutes: lead.distanceMinutes,
      score: lead.score,
      conversionScore: lead.conversionScore,
      projectFitScore: lead.projectFitScore,
      estimatedProjectTier: lead.estimatedProjectTier,
      priorityTier: lead.priorityTier,
      status: lead.status,
      doNotContact: lead.doNotContact,
      scoreBreakdownJson: JSON.stringify(lead.scoreBreakdown ?? {}),
      lastContactedAt: lead.lastContactedAt ? new Date(lead.lastContactedAt) : null,
      nextFollowUpAt: lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt) : null,
      createdAt: lead.createdAt ? new Date(lead.createdAt) : now,
      updatedAt: lead.updatedAt ? new Date(lead.updatedAt) : now
    }))
  });
  await ensureOwnerTestLead();
};

export const getDashboardData = async () => {
  await ensureSeeded();
  await ensureOwnerTestLead();
  const [leadsRaw, campaigns, messages, followUps, bookings, inboundReplies] = await Promise.all([
    db.lead.findMany({
      orderBy: { score: "desc" },
      include: { campaignLinks: { include: { campaign: true }, orderBy: { assignedAt: "asc" } } }
    }),
    db.campaign.findMany({
      orderBy: { launchedAt: "desc" },
      include: {
        leads: { include: { lead: { select: { fullName: true } } } }
      }
    }),
    db.message.findMany(),
    db.followUp.findMany(),
    db.booking.findMany(),
    db.inboundReply.findMany({ orderBy: { receivedAt: "desc" } })
  ]);

  const campaignsForAggregate = campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    launchedAt: c.launchedAt,
    sentCount: c.sentCount,
    createdAt: c.createdAt
  }));

  const campaignsForUi = campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    launchedAt: c.launchedAt.toISOString(),
    sentCount: c.sentCount,
    recipientNames: c.leads.map((cl) => cl.lead.fullName)
  }));

  const { leads: leadsMapped, inboxThreads, phase3Metrics } = aggregateDashboard(
    leadsRaw as unknown as LeadWithCampaigns[],
    messages,
    followUps,
    bookings,
    inboundReplies,
    campaignsForAggregate
  );

  const bookingLinkDisplay = getBookingLink() || getBookingLinkForDisplay();
  const notifications = await listDashboardNotifications(80);
  const voiceTrainingNotes = await listVoiceTrainingNotes(80);
  const dryRunState = await getOutreachDryRunDashboardState();

  return {
    leads: leadsMapped,
    campaigns: campaignsForUi,
    notifications,
    voiceTrainingNotes,
    messageCount: messages.length,
    followUps,
    bookings,
    inboundReplies,
    inboxThreads,
    phase3Metrics,
    bookingLinkConfigured: isBookingLinkConfigured(),
    bookingLinkDisplay,
    bookingReplyPreview: getBookingReplyTemplate(),
    outreachDryRun: dryRunState.effective,
    outreachDryRunEnvDefault: dryRunState.envDefault,
    outreachDryRunOverride: dryRunState.override
  };
};

export type LaunchCampaignResult = {
  ok: boolean;
  campaignId: string;
  sentCount: number;
  skippedByLimit: number;
  skippedByAddressPolicy: number;
  skippedVeryPoor: number;
  skippedDoNotContact: number;
  skippedByDeployVerify: number;
  dryRun: boolean;
  error?: string;
  errorCode?: "CONFIRM_LOW_ADDRESS_REQUIRED" | "NO_LEADS_SELECTED";
};

export const launchCampaign = async (
  name: string,
  leadIds: string[],
  options: LaunchCampaignOptions = {}
): Promise<LaunchCampaignResult> => {
  await ensureSeeded();
  await ensureOwnerTestLead();
  const dryRunEffective = await getEffectiveOutreachDryRun();

  const opts: LaunchCampaignOptions = {
    includeBelowOutreachMin: Boolean(options.includeBelowOutreachMin),
    includeVeryPoorAddress: Boolean(options.includeVeryPoorAddress),
    confirmLowAddressRisk: Boolean(options.confirmLowAddressRisk),
    includeUnverifiedHighScore: Boolean(options.includeUnverifiedHighScore)
  };

  const uniqueIds = [...new Set(leadIds)];
  if (uniqueIds.length === 0) {
    return {
      ok: false,
      error: "Select at least one lead before launching a campaign.",
      errorCode: "NO_LEADS_SELECTED",
      campaignId: "",
      sentCount: 0,
      skippedByLimit: 0,
      skippedByAddressPolicy: 0,
      skippedVeryPoor: 0,
      skippedDoNotContact: 0,
      skippedByDeployVerify: 0,
      dryRun: dryRunEffective
    };
  }

  const leadRows = await db.lead.findMany({ where: { id: { in: uniqueIds } } });
  const byId = new Map(leadRows.map((r) => [r.id, r]));
  const selectedDtos = uniqueIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [mapDbLeadToLead(row)] : [];
  });

  const eligibleForConfirmCheck = selectedDtos.filter((l) => isEligibleForCampaignSend(l, opts));
  if (needsLowAddressConfirmInBatch(eligibleForConfirmCheck, opts) && !opts.confirmLowAddressRisk) {
    return {
      ok: false,
      errorCode: "CONFIRM_LOW_ADDRESS_REQUIRED",
      error:
        "One or more leads have address confidence ≤ 50 (or unknown). Enable the low-address confirmation to proceed.",
      campaignId: "",
      sentCount: 0,
      skippedByLimit: 0,
      skippedByAddressPolicy: 0,
      skippedVeryPoor: 0,
      skippedDoNotContact: 0,
      skippedByDeployVerify: 0,
      dryRun: dryRunEffective
    };
  }

  const now = new Date();
  const campaignId = uid();
  await db.campaign.create({
    data: {
      id: campaignId,
      name,
      launchedAt: now,
      sentCount: 0
    }
  });

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const sentToday = await db.message.count({
    where: {
      direction: "outbound",
      kind: "first_touch",
      status: { in: ["sent", "dry_run"] },
      sentAt: { gte: startOfDay }
    }
  });
  const availableDaily = Math.max(0, outreachConfig.dailySendLimit - sentToday);
  const availableCampaign = Math.max(0, outreachConfig.campaignSendLimit);
  let sentNow = 0;
  let skippedByLimit = 0;
  let skippedByAddressPolicy = 0;
  let skippedVeryPoor = 0;
  let skippedDoNotContact = 0;
  let skippedByDeployVerify = 0;

  for (const leadId of uniqueIds) {
    if (sentNow >= availableCampaign || sentNow >= availableDaily) {
      skippedByLimit += 1;
      continue;
    }
    const lead = byId.get(leadId);
    if (!lead) continue;
    if (lead.doNotContact) {
      skippedDoNotContact += 1;
      continue;
    }
    const leadDto = mapDbLeadToLead(lead);
    const dv = deployVerifySendGate(leadDto, opts);
    if (dv && !dv.eligible) {
      skippedByDeployVerify += 1;
      continue;
    }
    const elig = campaignSendEligibility(leadDto, opts);
    if (!elig.eligible) {
      if (elig.reason === "very_poor_address") skippedVeryPoor += 1;
      else skippedByAddressPolicy += 1;
      continue;
    }
    /** First-touch: template baseline; with Claude, rewrite using full lead record from DB. */
    const firstTouchRendered = generateFirstTouchMessage(leadDto);
    const firstTouch = isClaudeCopyConfigured()
      ? (await composeFirstTouchFromFullLeadWithClaude(leadDto, firstTouchRendered.body)) ?? firstTouchRendered.body
      : firstTouchRendered.body;
    const subject = `Gloria Custom Cabinetry — kitchens & built-ins`;
    const sendResult = await sendOutreachEmail({
      to: lead.email,
      subject,
      text: firstTouch,
      intendedTo: lead.email
    });
    if (sendResult.status === "failed") {
      await db.message.create({
        data: {
          id: uid(),
          leadId,
          campaignId,
          direction: "outbound",
          kind: "first_touch",
          body: `${sendResult.finalText}\n\n[send_error] ${sendResult.error ?? "unknown"}`,
          sentAt: now,
          status: "failed"
        }
      });
      continue;
    }

    sentNow += 1;
    const follow1At = new Date(addBusinessDays(now.toISOString(), 2));
    const follow2At = new Date(addBusinessDays(now.toISOString(), 5));
    const follow1Baseline = generateFollowUp1Message(leadDto, firstTouch);
    const follow1Body = (await enhanceFollowUp1WithClaude(leadDto, firstTouch, follow1Baseline)) ?? follow1Baseline;
    const follow2Baseline = generateFollowUp2Message(leadDto);
    const follow2Body = (await enhanceFollowUp2WithClaude(leadDto, follow2Baseline)) ?? follow2Baseline;
    await db.campaignLead.create({
      data: { id: uid(), campaignId, leadId, assignedAt: now }
    });
    await db.message.createMany({
      data: [
        {
          id: uid(),
          leadId,
          campaignId,
          direction: "outbound",
          kind: "first_touch",
          body: sendResult.finalText,
          sentAt: now,
          status: sendResult.status
        },
        {
          id: uid(),
          leadId,
          campaignId,
          direction: "outbound",
          kind: "follow_up_1",
          body: follow1Body,
          sentAt: follow1At,
          status: "scheduled"
        },
        {
          id: uid(),
          leadId,
          campaignId,
          direction: "outbound",
          kind: "follow_up_2",
          body: follow2Body,
          sentAt: follow2At,
          status: "scheduled"
        }
      ]
    });
    await db.followUp.createMany({
      data: [
        { id: uid(), leadId, campaignId, sequence: 1, scheduledFor: follow1At, status: "scheduled" },
        { id: uid(), leadId, campaignId, sequence: 2, scheduledFor: follow2At, status: "scheduled" }
      ]
    });
    await db.lead.update({
      where: { id: leadId },
      data: {
        status: "In Campaign",
        lastContactedAt: now,
        nextFollowUpAt: follow1At,
        updatedAt: now
      }
    });
  }
  await db.campaign.update({
    where: { id: campaignId },
    data: { sentCount: sentNow }
  });
  return {
    ok: true,
    campaignId,
    sentCount: sentNow,
    skippedByLimit,
    skippedByAddressPolicy,
    skippedVeryPoor,
    skippedDoNotContact,
    skippedByDeployVerify,
    dryRun: dryRunEffective
  };
};

export const enrichLead = async (leadId: string) => {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false as const, error: "not_found" };

  const geo = await geocodeCityStateZip(lead.city, lead.state, lead.zip);
  const prevNotes = (lead.confidenceNotes ?? "").trim();
  const geoSnippet = geo.ok
    ? `Geocoded (OpenStreetMap): ${geo.displayName.slice(0, 160)}${geo.displayName.length > 160 ? "…" : ""}`
    : `Geocode skipped/failed (${geo.reason}) — location not upgraded.`;

  const mergedNotes =
    prevNotes && !prevNotes.includes("Geocoded (OpenStreetMap)")
      ? `${prevNotes} | ${geoSnippet}`
      : prevNotes.includes("Geocoded (OpenStreetMap)")
        ? prevNotes
        : geoSnippet;

  const bumpedAddr = geo.ok
    ? Math.min(100, Math.max(lead.addressConfidence ?? 0, 71))
    : lead.addressConfidence;

  const scored = scoreLeadBase({
    distanceMinutes: lead.distanceMinutes,
    amountSpent: lead.amountSpent,
    leadType: lead.leadType as Lead["leadType"]
  });

  const st = lead.status as LeadStatus;
  const nextPipeline =
    st === "New" || st === "Qualified" ? pipelineStatusForTier(scored.priorityTier) : undefined;

  await db.lead.update({
    where: { id: leadId },
    data: {
      enrichmentStatus: geo.ok ? "enriched" : lead.enrichmentStatus,
      source: lead.source,
      sourceDetail: `${lead.sourceDetail}; online enrich (${geo.ok ? "OSM geocode hit" : "no OSM hit"})`,
      locationConfidence: geo.ok ? "high" : lead.locationConfidence,
      addressConfidence: bumpedAddr,
      confidenceNotes: mergedNotes,
      score: scored.score,
      conversionScore: scored.conversionScore,
      projectFitScore: scored.projectFitScore,
      priorityTier: scored.priorityTier,
      estimatedProjectTier: scored.estimatedProjectTier,
      scoreBreakdownJson: JSON.stringify(scored.breakdown),
      ...(nextPipeline ? { status: nextPipeline } : {}),
      updatedAt: new Date()
    }
  });

  return { ok: true as const, geocoded: geo.ok };
};

/** Recompute score / tier / breakdown for every lead (e.g. after scoring formula change). */
export const recalculateAllLeadScores = async (): Promise<number> => {
  const rows = await db.lead.findMany({
    select: {
      id: true,
      distanceMinutes: true,
      amountSpent: true,
      leadType: true,
      status: true
    }
  });
  const now = new Date();
  for (const row of rows) {
    const scored = scoreLeadBase({
      distanceMinutes: row.distanceMinutes,
      amountSpent: row.amountSpent,
      leadType: row.leadType as Lead["leadType"]
    });
    const st = row.status as LeadStatus;
    const nextPipeline =
      st === "New" || st === "Qualified" ? pipelineStatusForTier(scored.priorityTier) : undefined;
    await db.lead.update({
      where: { id: row.id },
      data: {
        score: scored.score,
        conversionScore: scored.conversionScore,
        projectFitScore: scored.projectFitScore,
        priorityTier: scored.priorityTier,
        estimatedProjectTier: scored.estimatedProjectTier,
        scoreBreakdownJson: JSON.stringify(scored.breakdown),
        ...(nextPipeline ? { status: nextPipeline } : {}),
        updatedAt: now
      }
    });
  }
  return rows.length;
};

export const applyReply = async (leadId: string, text: string) => {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) return null;
  return processInboundEmail(
    {
      fromEmail: lead.email,
      toEmail: "",
      subject: "(simulator)",
      bodyText: text,
      receivedAt: new Date()
    },
    { leadIdHint: leadId }
  );
};

export const sendManualReviewReply = async (leadId: string, text: string, inboundReplyId?: string) => {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false as const, error: "Lead not found" };
  const send = await sendOutreachEmail({
    to: lead.email,
    subject: "Re: Gloria Custom Cabinetry",
    text,
    intendedTo: lead.email
  });
  await db.message.create({
    data: {
      id: uid(),
      leadId,
      direction: "outbound",
      kind: "manual_reply",
      body: `[Manual-sent] ${send.finalText}`,
      sentAt: new Date(),
      status: send.status === "failed" ? "failed" : send.status === "dry_run" ? "dry_run" : "sent"
    }
  });
  if (inboundReplyId) {
    await db.inboundReply.updateMany({
      where: { id: inboundReplyId, leadId },
      data: {
        needsReview: false,
        autoActionTaken: JSON.stringify(["manual_reply_approved"])
      }
    });
  }
  await db.lead.update({
    where: { id: leadId },
    data: { status: "In Campaign", updatedAt: new Date() }
  });
  return { ok: true as const };
};

export const snoozeLead = async (leadId: string, followUpAtIso: string) => {
  const d = new Date(followUpAtIso);
  await db.lead.update({
    where: { id: leadId },
    data: { status: "Not Now", nextFollowUpAt: d, updatedAt: new Date() }
  });
};

export const markLeadNotInterested = async (leadId: string) => {
  await db.lead.update({
    where: { id: leadId },
    data: { status: "Not Interested", updatedAt: new Date() }
  });
};

export { markBooked, type MarkBookedResult } from "@/services/markBookedService";
