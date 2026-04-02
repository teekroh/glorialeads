import type { Booking, Campaign, FollowUp, InboundReply, Lead as DbLead, Message } from "@prisma/client";
import { mapDbLeadToLead } from "@/lib/mappers";
import { pickLastOutboundBodyForInbox } from "@/lib/inboxOutboundPreview";
import { Lead, ReplyCategory, TimelineItem } from "@/types/lead";

export type LeadWithCampaigns = DbLead & {
  campaignLinks: Array<{ assignedAt: Date; campaign: Campaign }>;
};

export type InboxThread = {
  leadId: string;
  fullName: string;
  email: string;
  source: string;
  sourceDetail: string;
  leadType: string;
  priorityTier: string;
  score: number;
  status: string;
  /** Full body of the most recent outbound message (by sentAt). */
  lastOutboundBody: string;
  /** Full text of the inbound reply for this thread. */
  inboundBody: string;
  classification: string;
  confidence: number;
  recommendedNext: string;
  classificationReason: string;
  classifierExplanation: string;
  mixedIntent: boolean;
  automationAllowed: boolean;
  automationBlockedReason: string | null;
  suggestedReplyDraft: string | null;
  needsReview: boolean;
  inboundReplyId: string;
  doNotContact: boolean;
};

export type Phase3Metrics = {
  repliesReceived: number;
  positiveReplies: number;
  bookingInvitesSent: number;
  bookedMeetings: number;
  notInterested: number;
  unsubscribes: number;
  replyRateBySource: Record<string, { contacted: number; replied: number }>;
  replyRateByLeadType: Record<string, { contacted: number; replied: number }>;
  bookingRateByTier: Record<string, { eligible: number; booked: number }>;
};

function timelineMessageLabel(m: Message): string {
  const sched = m.status === "scheduled" ? " · scheduled" : "";
  if (m.direction === "inbound") {
    if (m.kind === "inbound_reply") return `They replied${sched}`;
    return `Inbound · ${m.kind}${sched}`;
  }
  const kindPretty: Record<string, string> = {
    first_touch: "First outreach",
    follow_up_1: "Follow-up 1",
    follow_up_2: "Follow-up 2",
    booking_invite: "Booking invite sent",
    system_auto: "System update",
    manual_reply: "Manual reply sent",
    claude_auto_reply: "Claude auto-reply sent"
  };
  const base = kindPretty[m.kind] ?? m.kind.replace(/_/g, " ");
  return `${base}${sched}`;
}

function buildTimeline(
  leadId: string,
  leadSource: string,
  leadSourceDetail: string,
  leadCreatedAt: Date,
  campaignLinks: Array<{ assignedAt: Date; campaign: { name: string } }>,
  messages: Message[],
  inbounds: InboundReply[],
  bookings: Booking[]
): TimelineItem[] {
  const items: TimelineItem[] = [];
  items.push({
    at: leadCreatedAt.toISOString(),
    kind: "campaign",
    label: "Lead source",
    detail: `${leadSource} · ${leadSourceDetail.length > 160 ? `${leadSourceDetail.slice(0, 160)}…` : leadSourceDetail}`,
    isAuto: true
  });
  for (const cl of campaignLinks) {
    items.push({
      at: cl.assignedAt.toISOString(),
      kind: "campaign",
      label: "Joined campaign",
      detail: `“${cl.campaign.name}”`,
      isAuto: true
    });
  }
  for (const m of messages.filter((x) => x.leadId === leadId)) {
    const autoOutbound =
      m.direction === "outbound" &&
      (m.body.startsWith("[Auto-sent]") || m.kind === "system_auto" || m.kind === "booking_invite");
    items.push({
      at: m.sentAt.toISOString(),
      kind: m.direction === "inbound" ? "inbound" : "outbound",
      label: timelineMessageLabel(m),
      detail: m.body.length > 220 ? `${m.body.slice(0, 220)}…` : m.body,
      isAuto: autoOutbound
    });
  }
  for (const ir of inbounds.filter((x) => x.leadId === leadId)) {
    const base = ir.receivedAt.getTime();
    const pct = (ir.classificationConfidence * 100).toFixed(0);
    items.push({
      at: ir.receivedAt.toISOString(),
      kind: "system",
      label: `Classified as ${String(ir.classification).replace(/_/g, " ")}`,
      detail: `${ir.classificationReason} (${pct}% confidence).`,
      isAuto: true
    });
    if (ir.classifierExplanation?.trim()) {
      items.push({
        at: new Date(base + 1).toISOString(),
        kind: "system",
        label: "Classifier detail",
        detail:
          ir.classifierExplanation.length > 280 ? `${ir.classifierExplanation.slice(0, 280)}…` : ir.classifierExplanation,
        isAuto: true
      });
    }
    if (ir.mixedIntent) {
      items.push({
        at: new Date(base + 2).toISOString(),
        kind: "system",
        label: "Mixed intent — safety",
        detail: "Multiple qualification signals detected; booking automation blocked unless explicitly safe.",
        isAuto: true
      });
    }
    if (ir.automationBlockedReason) {
      items.push({
        at: new Date(base + 3).toISOString(),
        kind: "system",
        label: "Automation blocked",
        detail: ir.automationBlockedReason,
        isAuto: true
      });
    }
    if (ir.automationAllowed) {
      items.push({
        at: new Date(base + 4).toISOString(),
        kind: "system",
        label: "Booking invite auto-sent",
        detail: "Met AUTO_BOOKING_MIN_CONFIDENCE with no mixed intent.",
        isAuto: true
      });
    } else if (ir.needsReview) {
      items.push({
        at: new Date(base + 4).toISOString(),
        kind: "system",
        label: "Routed to Needs Review",
        detail: ir.suggestedAction,
        isAuto: true
      });
    }
  }
  for (const b of bookings.filter((x) => x.leadId === leadId)) {
    const label =
      b.status === "booked" ? "Booking confirmed" : b.status === "booking_sent" ? "Invite sent" : `Booking · ${b.status}`;
    items.push({
      at: (b.bookedAt ?? b.createdAt).toISOString(),
      kind: "booking",
      label,
      detail: [b.note, b.meetingStatus, b.bookingLink].filter(Boolean).join(" · "),
      isAuto: true
    });
  }
  return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

export function aggregateDashboard(
  leads: LeadWithCampaigns[],
  messages: Message[],
  _followUps: FollowUp[],
  bookings: Booking[],
  inboundReplies: InboundReply[],
  campaigns: Campaign[]
): { leads: Lead[]; inboxThreads: InboxThread[]; phase3Metrics: Phase3Metrics } {
  const byLeadInbound = new Map<string, InboundReply[]>();
  for (const ir of inboundReplies) {
    const list = byLeadInbound.get(ir.leadId) ?? [];
    list.push(ir);
    byLeadInbound.set(ir.leadId, list);
  }
  for (const [, list] of byLeadInbound) {
    list.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  }

  const leadsMapped: Lead[] = leads.map((lead) => {
    const mapped = mapDbLeadToLead(lead);
    const leadMsgs = messages.filter((m) => m.leadId === lead.id);
    const outreachHistory = leadMsgs
      .filter((m) => m.direction === "outbound" && m.kind !== "system_auto")
      .map((m) => ({ at: m.sentAt.toISOString(), message: m.body, campaignId: m.campaignId ?? "system" }));

    const irs = byLeadInbound.get(lead.id) ?? [];
    const replyHistory = [...irs]
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .map((ir) => ({
        at: ir.receivedAt.toISOString(),
        text: ir.bodyText,
        classification: ir.classification as ReplyCategory,
        confidence: ir.classificationConfidence
      }));

    const bookingHistory = bookings
      .filter((b) => b.leadId === lead.id)
      .map((b) => ({
        at: b.createdAt.toISOString(),
        status: b.status,
        note: b.note,
        bookingLink: b.bookingLink ?? undefined,
        bookedAt: b.bookedAt?.toISOString(),
        meetingStart: b.meetingStart?.toISOString(),
        meetingEnd: b.meetingEnd?.toISOString(),
        meetingStatus: b.meetingStatus ?? undefined,
        externalBookingId: b.externalBookingId ?? undefined
      }));

    const latestIr = irs[0];
    const timeline = buildTimeline(
      lead.id,
      mapped.source,
      mapped.sourceDetail,
      new Date(mapped.createdAt),
      lead.campaignLinks ?? [],
      leadMsgs,
      irs,
      bookings.filter((b) => b.leadId === lead.id)
    );

    const fixedLatest = latestIr
      ? {
          id: latestIr.id,
          snippet: latestIr.bodyText.length > 140 ? `${latestIr.bodyText.slice(0, 140)}…` : latestIr.bodyText,
          classification: latestIr.classification as ReplyCategory,
          confidence: latestIr.classificationConfidence,
          suggestedAction: latestIr.suggestedAction,
          suggestedReplyDraft: latestIr.suggestedReplyDraft ?? undefined,
          classificationReason: latestIr.classificationReason,
          classifierExplanation: latestIr.classifierExplanation ?? undefined,
          needsReview: latestIr.needsReview,
          mixedIntent: latestIr.mixedIntent,
          automationAllowed: latestIr.automationAllowed,
          automationBlockedReason: latestIr.automationBlockedReason ?? undefined,
          receivedAt: latestIr.receivedAt.toISOString()
        }
      : undefined;

    return {
      ...mapped,
      scoreBreakdown: JSON.parse(lead.scoreBreakdownJson || "{}"),
      outreachHistory,
      replyHistory,
      bookingHistory,
      timeline,
      latestInbound: fixedLatest
    };
  });

  const threads: InboxThread[] = [];
  for (const l of leadsMapped) {
    const irs = byLeadInbound.get(l.id) ?? [];
    const latest = irs[0];
    if (!latest) continue;
    const lastOutboundBody = pickLastOutboundBodyForInbox(messages, l.id, latest.receivedAt);
    threads.push({
      leadId: l.id,
      fullName: l.fullName,
      email: l.email,
      source: l.source,
      sourceDetail: l.sourceDetail,
      leadType: l.leadType,
      priorityTier: l.priorityTier,
      score: l.score,
      status: l.status,
      lastOutboundBody,
      inboundBody: latest.bodyText?.trim() ? latest.bodyText : "—",
      classification: latest.classification,
      confidence: latest.classificationConfidence,
      recommendedNext: latest.suggestedAction,
      classificationReason: latest.classificationReason,
      classifierExplanation: latest.classifierExplanation,
      mixedIntent: latest.mixedIntent,
      automationAllowed: latest.automationAllowed,
      automationBlockedReason: latest.automationBlockedReason ?? null,
      suggestedReplyDraft: latest.suggestedReplyDraft ?? null,
      needsReview: latest.needsReview,
      inboundReplyId: latest.id,
      doNotContact: l.doNotContact
    });
  }

  const contactedLeadIds = new Set(messages.filter((m) => m.kind === "first_touch").map((m) => m.leadId));
  const repliedLeadIds = new Set(inboundReplies.map((i) => i.leadId));
  const bookingInvites = messages.filter((m) => m.kind === "booking_invite" && ["sent", "dry_run"].includes(m.status));

  const phase3Metrics: Phase3Metrics = {
    repliesReceived: inboundReplies.length,
    positiveReplies: inboundReplies.filter((i) => ["positive", "asks_for_link"].includes(i.classification)).length,
    bookingInvitesSent: bookingInvites.length,
    bookedMeetings: leadsMapped.filter((l) => l.status === "Booked").length,
    notInterested: leadsMapped.filter((l) => l.status === "Not Interested").length,
    unsubscribes: leadsMapped.filter((l) => l.doNotContact).length,
    replyRateBySource: {},
    replyRateByLeadType: {},
    bookingRateByTier: {}
  };

  const sources = new Set(leadsMapped.map((l) => l.source));
  for (const s of sources) {
    const subset = leadsMapped.filter((l) => l.source === s);
    const contacted = subset.filter((l) => contactedLeadIds.has(l.id)).length;
    const replied = subset.filter((l) => repliedLeadIds.has(l.id)).length;
    phase3Metrics.replyRateBySource[s] = { contacted, replied };
  }
  const types = new Set(leadsMapped.map((l) => l.leadType));
  for (const t of types) {
    const subset = leadsMapped.filter((l) => l.leadType === t);
    const contacted = subset.filter((l) => contactedLeadIds.has(l.id)).length;
    const replied = subset.filter((l) => repliedLeadIds.has(l.id)).length;
    phase3Metrics.replyRateByLeadType[t] = { contacted, replied };
  }
  const tiers = new Set(leadsMapped.map((l) => l.priorityTier));
  for (const tier of tiers) {
    const subset = leadsMapped.filter((l) => l.priorityTier === tier);
    const eligible = subset.filter((l) => contactedLeadIds.has(l.id)).length;
    const booked = subset.filter((l) => l.status === "Booked").length;
    phase3Metrics.bookingRateByTier[tier] = { eligible, booked };
  }

  void campaigns;

  return { leads: leadsMapped, inboxThreads: threads, phase3Metrics };
}
