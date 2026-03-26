"use client";

import { useMemo, useState } from "react";
import type { InboxThread, Phase3Metrics } from "@/services/dashboardAggregation";
import type { SimulatedScenario } from "@/services/inboundSimulation";
import { Campaign } from "@/types/campaign";
import type { LaunchCampaignOptions } from "@/services/addressConfidencePolicy";
import {
  addressConfidenceBand,
  countByAddressBand,
  countOutreachReadyByClassification,
  OUTREACH_ADDRESS_MIN_DEFAULT,
  OUTREACH_ADDRESS_VERY_POOR_MAX,
  type AddressConfidenceBand
} from "@/services/addressConfidencePolicy";
import { Lead, LeadSource, LeadStatus, LeadType, PriorityTier } from "@/types/lead";

export type AddressQuickFilter = "all" | "verified_86" | "reachable_71" | "needs_review_under_71";

export interface Filters {
  source: LeadSource | "all";
  leadType: LeadType | "all";
  priorityTier: PriorityTier | "all";
  status: LeadStatus | "all";
  projectTier: Lead["estimatedProjectTier"] | "all";
  contacted: "all" | "contacted" | "not_contacted";
  maxDistance: number;
  query: string;
  addressQuick: AddressQuickFilter;
  addressBand: AddressConfidenceBand | "all";
  addressConfidenceMin: string;
  addressConfidenceMax: string;
}

export const defaultLeadFilters: Filters = {
  source: "all",
  leadType: "all",
  priorityTier: "all",
  status: "all",
  projectTier: "all",
  contacted: "all",
  maxDistance: 180,
  query: "",
  addressQuick: "all",
  addressBand: "all",
  addressConfidenceMin: "",
  addressConfidenceMax: ""
};

function numericAddressScore(lead: Lead): number | null {
  const v = lead.addressConfidence;
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.min(100, Math.max(0, Math.round(v)));
}

export const useDashboard = (
  initialLeads: Lead[],
  initialCampaigns: Campaign[],
  initialInboxThreads: InboxThread[],
  initialPhase3Metrics: Phase3Metrics,
  initialBookingLinkConfigured = true,
  initialBookingLinkDisplay = "",
  initialBookingReplyPreview = ""
) => {
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [inboxThreads, setInboxThreads] = useState<InboxThread[]>(initialInboxThreads);
  const [phase3Metrics, setPhase3Metrics] = useState<Phase3Metrics>(initialPhase3Metrics);
  const [bookingLinkConfigured, setBookingLinkConfigured] = useState(initialBookingLinkConfigured);
  const [bookingLinkDisplay, setBookingLinkDisplay] = useState(initialBookingLinkDisplay);
  const [bookingReplyPreview, setBookingReplyPreview] = useState(initialBookingReplyPreview);
  const [filters, setFilters] = useState<Filters>(defaultLeadFilters);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>(initialCampaigns);

  const refresh = async () => {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    const data = await response.json();
    setLeads(data.leads);
    setInboxThreads(data.inboxThreads ?? []);
    setPhase3Metrics(
      data.phase3Metrics ?? {
        repliesReceived: 0,
        positiveReplies: 0,
        bookingInvitesSent: 0,
        bookedMeetings: 0,
        notInterested: 0,
        unsubscribes: 0,
        replyRateBySource: {},
        replyRateByLeadType: {},
        bookingRateByTier: {}
      }
    );
    setCampaigns(
      (data.campaigns || []).map(
        (c: { id: string; name: string; launchedAt: string; sentCount: number; recipientNames?: string[] }) => ({
          id: c.id,
          name: c.name,
          launchedAt: c.launchedAt,
          sentCount: c.sentCount,
          recipientNames: c.recipientNames
        })
      )
    );
    if (typeof data.bookingLinkConfigured === "boolean") setBookingLinkConfigured(data.bookingLinkConfigured);
    if (typeof data.bookingLinkDisplay === "string") setBookingLinkDisplay(data.bookingLinkDisplay);
    if (typeof data.bookingReplyPreview === "string") setBookingReplyPreview(data.bookingReplyPreview);
  };

  const filtered = useMemo(
    () =>
      leads.filter((lead) => {
        if (filters.source !== "all" && lead.source !== filters.source) return false;
        if (filters.leadType !== "all" && lead.leadType !== filters.leadType) return false;
        if (filters.priorityTier !== "all" && lead.priorityTier !== filters.priorityTier) return false;
        if (filters.status !== "all" && lead.status !== filters.status) return false;
        if (filters.projectTier !== "all" && lead.estimatedProjectTier !== filters.projectTier) return false;
        if (lead.distanceMinutes > filters.maxDistance) return false;
        if (filters.contacted === "contacted" && !lead.lastContactedAt) return false;
        if (filters.contacted === "not_contacted" && lead.lastContactedAt) return false;
        if (filters.query) {
          const q = filters.query.toLowerCase();
          if (
            !`${lead.fullName} ${lead.email} ${lead.company} ${lead.city} ${lead.state}`.toLowerCase().includes(q)
          )
            return false;
        }
        const ascore = numericAddressScore(lead);
        if (filters.addressQuick === "verified_86") {
          if (ascore === null || ascore < 86) return false;
        }
        if (filters.addressQuick === "reachable_71") {
          if (ascore === null || ascore < OUTREACH_ADDRESS_MIN_DEFAULT) return false;
        }
        if (filters.addressQuick === "needs_review_under_71") {
          if (ascore !== null && ascore >= OUTREACH_ADDRESS_MIN_DEFAULT) return false;
        }
        if (filters.addressBand !== "all") {
          const b = addressConfidenceBand(lead.addressConfidence);
          if (b !== filters.addressBand) return false;
        }
        const minN = filters.addressConfidenceMin.trim() ? Number(filters.addressConfidenceMin) : NaN;
        if (Number.isFinite(minN) && (ascore === null || ascore < minN)) return false;
        const maxN = filters.addressConfidenceMax.trim() ? Number(filters.addressConfidenceMax) : NaN;
        if (Number.isFinite(maxN) && (ascore === null || ascore > maxN)) return false;
        return true;
      }),
    [filters, leads]
  );

  const metrics = useMemo(() => {
    const replies = leads.flatMap((l) => l.replyHistory);
    const positive = replies.filter((r) => ["positive", "asks_for_link"].includes(r.classification)).length;
    return {
      totalLeads: leads.length,
      qualifiedLeads: leads.filter((l) => l.priorityTier === "Tier A" || l.priorityTier === "Tier B").length,
      csvLeads: leads.filter((l) => l.source === "CSV Import").length,
      externalLeads: leads.filter((l) => l.source === "Scraped / External").length,
      enrichedLeads: leads.filter((l) => l.enrichmentStatus === "enriched").length,
      campaignsLaunched: campaigns.length,
      emailsSent: leads.reduce((sum, l) => sum + l.outreachHistory.length, 0),
      replies: replies.length,
      positiveReplies: positive,
      bookingSent: leads.filter((l) => l.status === "Booking Sent").length,
      booked: leads.filter((l) => l.status === "Booked").length
    };
  }, [leads, campaigns]);

  const addressMetrics = useMemo(() => {
    const bands = countByAddressBand(leads);
    const score = (l: Lead) => numericAddressScore(l);
    const verified = leads.filter((l) => (score(l) ?? -1) >= 86).length;
    const good = leads.filter((l) => (score(l) ?? -1) >= OUTREACH_ADDRESS_MIN_DEFAULT).length;
    const low = leads.filter((l) => {
      const s = score(l);
      return s === null || s < OUTREACH_ADDRESS_MIN_DEFAULT;
    }).length;
    const veryPoor = leads.filter((l) => {
      const s = score(l);
      return s !== null && s <= OUTREACH_ADDRESS_VERY_POOR_MAX;
    }).length;
    const byClass = countOutreachReadyByClassification(leads);
    return { bands, verified, good, low, veryPoor, byClass };
  }, [leads]);

  const sourceCounts = useMemo(
    () =>
      leads.reduce<Record<string, number>>((acc, lead) => {
        acc[lead.source] = (acc[lead.source] ?? 0) + 1;
        return acc;
      }, {}),
    [leads]
  );

  const launchCampaign = async (name: string, options?: LaunchCampaignOptions) => {
    const response = await fetch("/api/campaigns/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        leadIds: selectedIds,
        includeBelowOutreachMin: options?.includeBelowOutreachMin,
        includeVeryPoorAddress: options?.includeVeryPoorAddress,
        confirmLowAddressRisk: options?.confirmLowAddressRisk,
        includeUnverifiedHighScore: options?.includeUnverifiedHighScore
      })
    });
    const data = await response.json();
    if (data?.ok) setSelectedIds([]);
    await refresh();
    return data as
      | {
          ok: true;
          result: {
            ok: boolean;
            campaignId: string;
            sentCount: number;
            skippedByLimit: number;
            skippedByAddressPolicy: number;
            skippedVeryPoor: number;
            skippedDoNotContact: number;
            skippedByDeployVerify: number;
            dryRun: boolean;
          };
        }
      | { ok: false; error?: string; errorCode?: string; result?: unknown };
  };

  const applyMockReply = async (leadId: string, text: string) => {
    await fetch(`/api/leads/${leadId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    await refresh();
  };

  /** Confirms booking via the same handler as production Cal webhooks. */
  const simulateCalBookingConfirmation = async (leadId: string) => {
    const start = new Date(Date.now() + 86400000);
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    const res = await fetch("/api/webhooks/cal-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mock: true,
        leadId,
        bookingUid: `sim-${Date.now()}`,
        startTime: start.toISOString(),
        endTime: end.toISOString()
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.warn("[Gloria] /api/webhooks/cal-booking", data);
    await refresh();
  };

  /** Webhook self-test: POST a realistic payload (no `mock:true`). */
  const testCalWebhook = async (leadId: string) => {
    const start = new Date(Date.now() + 86400000);
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    const res = await fetch("/api/webhooks/cal-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadId,
        bookingUid: `selftest-${Date.now()}`,
        startTime: start.toISOString(),
        endTime: end.toISOString()
      })
    });

    const data = await res.json().catch(() => ({} as any));
    await refresh();
    return { ok: res.ok, data };
  };

  const enrichLead = async (leadId: string) => {
    await fetch(`/api/leads/${leadId}/enrich`, { method: "POST" });
    await refresh();
  };

  const sendReviewReply = async (leadId: string, text: string, inboundReplyId?: string) => {
    await fetch(`/api/leads/${leadId}/review-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, inboundReplyId })
    });
    await refresh();
  };

  const snoozeLeadClient = async (leadId: string, followUpAt: string) => {
    await fetch(`/api/leads/${leadId}/snooze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followUpAt })
    });
    await refresh();
  };

  const markNotInterestedClient = async (leadId: string) => {
    await fetch(`/api/leads/${leadId}/mark-not-interested`, { method: "POST" });
    await refresh();
  };

  const simulateInbound = async (leadId: string, scenario: SimulatedScenario) => {
    await fetch("/api/dev/simulate-inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId, scenario })
    });
    await refresh();
  };

  const seedInboxSamples = async () => {
    const res = await fetch("/api/dev/seed-inbox-samples", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    await refresh();
    return data as { ok?: boolean; error?: string; results?: unknown[] };
  };

  return {
    leads,
    inboxThreads,
    phase3Metrics,
    bookingLinkConfigured,
    bookingLinkDisplay,
    bookingReplyPreview,
    filtered,
    filters,
    setFilters,
    selectedIds,
    setSelectedIds,
    campaigns,
    refresh,
    launchCampaign,
    applyMockReply,
    metrics,
    addressMetrics,
    sourceCounts,
    simulateCalBookingConfirmation,
    testCalWebhook,
    enrichLead,
    sendReviewReply,
    snoozeLeadClient,
    markNotInterestedClient,
    simulateInbound,
    seedInboxSamples
  };
};
