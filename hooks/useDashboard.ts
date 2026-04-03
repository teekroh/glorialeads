"use client";

import { useCallback, useMemo, useState } from "react";
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
import type { CreateManualLeadPayload } from "@/types/lead";
import { Lead, LeadSource, LeadStatus, LeadType, PriorityTier } from "@/types/lead";
import type { DashboardNotificationDTO } from "@/services/dashboardNotificationService";
import type { VoiceTrainScenarioKind } from "@/config/voiceTrainScenarios";
import type { VoiceTrainingNoteDTO } from "@/services/voiceTrainingStorage";
import { compareLeadsForLibrary } from "@/services/scoringService";

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
  /** Lead library: hide rows already in an active campaign (status In Campaign). */
  hideInCampaignAlready: boolean;
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
  addressConfidenceMax: "",
  hideInCampaignAlready: false
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
  initialBookingReplyPreview = "",
  initialOutreachDryRun = true,
  initialOutreachDryRunEnvDefault = initialOutreachDryRun,
  initialOutreachDryRunOverride: boolean | null = null,
  initialNotifications: DashboardNotificationDTO[] = [],
  initialVoiceTrainingNotes: VoiceTrainingNoteDTO[] = [],
  initialOutreachTestToActive = false,
  initialAutoDailyFirstTouchEnabled = false
) => {
  const adminApiKey = process.env.NEXT_PUBLIC_ADMIN_API_KEY ?? "";
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [inboxThreads, setInboxThreads] = useState<InboxThread[]>(initialInboxThreads);
  const [phase3Metrics, setPhase3Metrics] = useState<Phase3Metrics>(initialPhase3Metrics);
  const [bookingLinkConfigured, setBookingLinkConfigured] = useState(initialBookingLinkConfigured);
  const [bookingLinkDisplay, setBookingLinkDisplay] = useState(initialBookingLinkDisplay);
  const [bookingReplyPreview, setBookingReplyPreview] = useState(initialBookingReplyPreview);
  const [outreachDryRun, setOutreachDryRun] = useState(initialOutreachDryRun);
  const [outreachDryRunEnvDefault, setOutreachDryRunEnvDefault] = useState(initialOutreachDryRunEnvDefault);
  const [outreachDryRunOverride, setOutreachDryRunOverrideState] = useState<boolean | null>(initialOutreachDryRunOverride);
  const [dryRunToggleBusy, setDryRunToggleBusy] = useState(false);
  const [outreachTestToActive, setOutreachTestToActive] = useState(initialOutreachTestToActive);
  const [autoDailyFirstTouchEnabled, setAutoDailyFirstTouchEnabledState] = useState(
    initialAutoDailyFirstTouchEnabled
  );
  const [autoDailyFirstTouchBusy, setAutoDailyFirstTouchBusy] = useState(false);
  const [filters, setFilters] = useState<Filters>(defaultLeadFilters);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>(initialCampaigns);
  const [notifications, setNotifications] = useState<DashboardNotificationDTO[]>(initialNotifications);
  const [voiceTrainingNotes, setVoiceTrainingNotes] = useState<VoiceTrainingNoteDTO[]>(initialVoiceTrainingNotes);

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
    if (typeof data.outreachDryRun === "boolean") setOutreachDryRun(data.outreachDryRun);
    if (typeof data.outreachDryRunEnvDefault === "boolean") setOutreachDryRunEnvDefault(data.outreachDryRunEnvDefault);
    if (
      "outreachDryRunOverride" in data &&
      (data.outreachDryRunOverride === null || typeof data.outreachDryRunOverride === "boolean")
    ) {
      setOutreachDryRunOverrideState(data.outreachDryRunOverride);
    }
    if (typeof data.outreachTestToActive === "boolean") setOutreachTestToActive(data.outreachTestToActive);
    if (typeof data.autoDailyFirstTouchEnabled === "boolean") {
      setAutoDailyFirstTouchEnabledState(data.autoDailyFirstTouchEnabled);
    }
    if (Array.isArray(data.notifications)) {
      setNotifications(data.notifications as DashboardNotificationDTO[]);
    }
    if (Array.isArray(data.voiceTrainingNotes)) {
      setVoiceTrainingNotes(data.voiceTrainingNotes as VoiceTrainingNoteDTO[]);
    }
  };

  const markNotificationsRead = async (ids: string[]) => {
    await fetch("/api/notifications/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids })
    });
    setNotifications((prev) => prev.map((n) => (ids.includes(n.id) ? { ...n, readAt: new Date().toISOString() } : n)));
  };

  const filtered = useMemo(() => {
    const out = leads.filter((lead) => {
      if (filters.source !== "all" && lead.source !== filters.source) return false;
      if (filters.leadType !== "all" && lead.leadType !== filters.leadType) return false;
      if (filters.priorityTier !== "all" && lead.priorityTier !== filters.priorityTier) return false;
      if (filters.hideInCampaignAlready && lead.status === "In Campaign") return false;
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
    });
    out.sort(compareLeadsForLibrary);
    return out;
  }, [filters, leads]);

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
      headers: {
        "Content-Type": "application/json",
        ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
      },
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
      headers: {
        "Content-Type": "application/json",
        ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
      },
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

  const voiceTrainingAuthHeaders = {
    "Content-Type": "application/json",
    ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
  };

  const generateVoiceTrainingMockClient = async (kind: VoiceTrainScenarioKind, leadId: string) => {
    const res = await fetch("/api/voice-training/generate-mock", {
      method: "POST",
      headers: voiceTrainingAuthHeaders,
      body: JSON.stringify({ kind, leadId: leadId.trim() || undefined })
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; mock?: string; error?: string };
    if (!res.ok || !data.ok) {
      return {
        ok: false as const,
        error:
          data.error ??
          (res.status === 401
            ? "Unauthorized (set ADMIN_API_KEY)"
            : res.status === 404
              ? "Lead not found."
              : "request_failed")
      };
    }
    return { ok: true as const, mock: data.mock ?? "" };
  };

  const saveVoiceTrainingNoteClient = async (input: {
    scenarioKind: string;
    mockClaudeReply: string;
    userCorrection: string;
  }) => {
    const res = await fetch("/api/voice-training/notes", {
      method: "POST",
      headers: voiceTrainingAuthHeaders,
      body: JSON.stringify(input)
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      return { ok: false as const, error: data.error ?? (res.status === 401 ? "Unauthorized" : "request_failed") };
    }
    return { ok: true as const };
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
      headers: {
        "Content-Type": "application/json",
        ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
      },
      body: JSON.stringify({ leadId, scenario })
    });
    await refresh();
  };

  const seedInboxSamples = async () => {
    const res = await fetch("/api/dev/seed-inbox-samples", {
      method: "POST",
      headers: {
        ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
      }
    });
    const data = await res.json().catch(() => ({}));
    await refresh();
    return data as { ok?: boolean; error?: string; results?: unknown[] };
  };

  const cleanSlateOutreach = async () => {
    const res = await fetch("/api/dev/clean-slate", {
      method: "POST",
      headers: {
        ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
      }
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      deleted?: Record<string, number>;
      leadsReset?: number;
      error?: string;
    };
    await refresh();
    return { ok: res.ok && data.ok !== false, ...data };
  };

  const placesDiscoverLeads = async (payload: Record<string, unknown> = {}) => {
    const res = await fetch("/api/dev/places-discover", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
      },
      body: JSON.stringify({ limit: 5, ...payload })
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      created?: number;
      skipped?: number;
      skippedReasons?: string[];
      queryUsed?: string;
      pricingNote?: string;
    };
    await refresh();
    if (!res.ok) {
      return { ok: false as const, error: data.error ?? `HTTP ${res.status}`, ...data };
    }
    return { ok: true as const, ...data };
  };

  const dispatchScheduledDue = async (limit = 20) => {
    const res = await fetch("/api/dev/dispatch-scheduled", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
      },
      body: JSON.stringify({ limit })
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      dispatched?: number;
      skipped?: number;
      errors?: string[];
    };
    await refresh();
    return data;
  };

  const setOutreachDryRunMode = async (mode: "dry" | "live" | "env_default") => {
    setDryRunToggleBusy(true);
    const body =
      mode === "env_default" ? { clearOverride: true } : { mode };
    const res = await fetch("/api/settings/outreach-dry-run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
      },
      body: JSON.stringify(body)
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      code?: string;
    };
    setDryRunToggleBusy(false);
    await refresh();
    return {
      ok: res.ok && data.ok !== false,
      error: data.error,
      code: data.code,
      status: res.status
    };
  };

  const setAutoDailyFirstTouchMode = async (enabled: boolean) => {
    setAutoDailyFirstTouchBusy(true);
    try {
      const res = await fetch("/api/settings/auto-daily-first-touch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
        },
        body: JSON.stringify({ enabled })
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      await refresh();
      return { ok: res.ok && data.ok !== false, error: data.error, status: res.status };
    } finally {
      setAutoDailyFirstTouchBusy(false);
    }
  };

  const createLead = async (payload: CreateManualLeadPayload) => {
    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; id?: string };
    if (!res.ok || !data.ok) {
      return { ok: false as const, error: data.error ?? "request_failed" };
    }
    await refresh();
    return { ok: true as const, id: data.id ?? "" };
  };

  const syncGoogleCalendarBookings = async () => {
    const res = await fetch("/api/bookings/sync-google", {
      method: "POST",
      headers: {
        ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
      }
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      eventsScanned?: number;
      markedBooked?: number;
      updatedExisting?: number;
      skipped?: string[];
    };
    await refresh();
    return {
      ok: res.ok && data.ok !== false,
      status: res.status,
      error: data.error,
      eventsScanned: data.eventsScanned,
      markedBooked: data.markedBooked,
      updatedExisting: data.updatedExisting,
      skipped: data.skipped
    };
  };

  const askDashboardAssistant = useCallback(
    async (message: string, context: unknown) => {
      const res = await fetch("/api/dashboard/assistant", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
        },
        body: JSON.stringify({ message, context })
      });
      return (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        mode?: string;
        text?: string;
        summary?: string;
        leadId?: string;
      };
    },
    [adminApiKey]
  );

  const deleteLeadClient = useCallback(
    async (leadId: string) => {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: "DELETE",
        headers: {
          ...(adminApiKey ? { "x-api-key": adminApiKey } : {})
        }
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      await refresh();
      return { ok: res.ok && data.ok !== false, error: data.error };
    },
    [adminApiKey]
  );

  return {
    leads,
    inboxThreads,
    phase3Metrics,
    bookingLinkConfigured,
    bookingLinkDisplay,
    bookingReplyPreview,
    outreachDryRun,
    outreachDryRunEnvDefault,
    outreachDryRunOverride,
    outreachTestToActive,
    autoDailyFirstTouchEnabled,
    autoDailyFirstTouchBusy,
    setAutoDailyFirstTouchMode,
    dryRunToggleBusy,
    setOutreachDryRunMode,
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
    voiceTrainingNotes,
    generateVoiceTrainingMockClient,
    saveVoiceTrainingNoteClient,
    snoozeLeadClient,
    markNotInterestedClient,
    simulateInbound,
    seedInboxSamples,
    cleanSlateOutreach,
    placesDiscoverLeads,
    createLead,
    notifications,
    markNotificationsRead,
    dispatchScheduledDue,
    syncGoogleCalendarBookings,
    askDashboardAssistant,
    deleteLeadClient
  };
};
