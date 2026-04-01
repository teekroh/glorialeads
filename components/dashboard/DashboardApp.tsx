"use client";

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { appConfig } from "@/config/appConfig";
import { ImportSummary } from "@/data/importLeads";
import { defaultLeadFilters, useDashboard } from "@/hooks/useDashboard";
import {
  ADDRESS_CONFIDENCE_TOOLTIP,
  AddressConfidenceBadge
} from "@/components/ui/AddressConfidenceBadge";
import { getCampaignSequencePreview, renderFirstTouchForLead } from "@/services/messagingService";
import {
  addressConfidenceBand,
  campaignSendEligibility,
  leadNeedsLowAddressConfirm,
  outreachReadiness,
  OUTREACH_ADDRESS_MIN_DEFAULT,
  OUTREACH_ADDRESS_VERY_POOR_MAX
} from "@/services/addressConfidencePolicy";
import { DEPLOY_VERIFY_MIN_SCORE, isEligibleForCampaignSend } from "@/services/deployVerifyPolicy";
import type { InboxThread, Phase3Metrics } from "@/services/dashboardAggregation";
import { Campaign } from "@/types/campaign";
import type { LeadType } from "@/types/lead";
import { Lead } from "@/types/lead";
import { CampaignSequenceTree } from "@/components/dashboard/CampaignSequenceTree";
import { SimulationPanel } from "@/components/dashboard/SimulationPanel";
import { VerifyWorkbench } from "@/components/dashboard/VerifyWorkbench";
import { AutomationAuditBadges } from "@/components/ui/HandlingBadge";
import { SourceBadge } from "@/components/ui/SourceBadge";
import { BookingStatusBadge, StatusBadge } from "@/components/ui/StatusBadge";

const MANUAL_LEAD_TYPES: LeadType[] = [
  "homeowner",
  "designer",
  "architect",
  "builder",
  "cabinet shop",
  "commercial builder"
];

const INBOX_TABS = ["Interested", "Booking Sent", "Needs Review", "Not Now", "Suppressed"] as const;

/** Sidebar order: Dashboard → Inbox → Campaigns → Bookings → Leads → Verify → Simulation */
const SIDEBAR_VIEWS = ["dashboard", "inbox", "campaigns", "bookings", "leads", "verify", "simulation"] as const;
const LITE_SIDEBAR_VIEWS = ["inbox", "bookings"] as const;

function inboxTabMatches(thread: InboxThread, lead: Lead | undefined, tab: (typeof INBOX_TABS)[number]): boolean {
  if (!lead) return false;
  if (tab === "Interested") return lead.status === "Interested";
  if (tab === "Booking Sent") return lead.status === "Booking Sent";
  if (tab === "Needs Review") return lead.status === "Needs Review" || thread.needsReview;
  if (tab === "Not Now") return lead.status === "Not Now";
  if (tab === "Suppressed") return lead.doNotContact;
  return false;
}

function clip(s: string, n: number) {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function latestBookingRecord(lead: Lead | null | undefined) {
  if (!lead?.bookingHistory?.length) return null;
  return [...lead.bookingHistory].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
}

/** Best-effort timestamp of the latest campaign reply. */
function lastReplyAtIso(lead: Lead): string | null {
  if (lead.latestInbound?.receivedAt) return lead.latestInbound.receivedAt;
  const rh = lead.replyHistory;
  if (rh?.length) return rh[rh.length - 1]!.at;
  const timelineIn = (lead.timeline ?? []).filter((t) => t.kind === "inbound");
  const last = timelineIn[timelineIn.length - 1];
  return last?.at ?? null;
}

function formatRelativeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "—";
  const now = Date.now();
  const sec = Math.floor((now - d) / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function leadNeedsInboxReview(lead: Lead) {
  return lead.status === "Needs Review" || Boolean(lead.latestInbound?.needsReview);
}

function DashboardBookingsCalendar({ leads }: { leads: Lead[] }) {
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());

  const events = useMemo(() => {
    const out: { at: Date; leadName: string; status: string; hasScheduledStart: boolean }[] = [];
    for (const lead of leads) {
      for (const b of lead.bookingHistory) {
        const anchor = bookingCalendarAnchor(b);
        if (!anchor) continue;
        out.push({
          at: anchor,
          leadName: lead.fullName,
          status: b.status || "—",
          hasScheduledStart: bookingHasScheduledStart(b)
        });
      }
    }
    return out.sort((a, b) => a.at.getTime() - b.at.getTime());
  }, [leads]);

  const y = viewYear;
  const m = viewMonth;
  const first = new Date(y, m, 1);
  const pad = first.getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const dayCells = Array.from({ length: pad + daysInMonth }, (_, i) => {
    if (i < pad) return { day: null as number | null, items: [] as typeof events };
    const day = i - pad + 1;
    const items = events.filter((e) => e.at.getFullYear() === y && e.at.getMonth() === m && e.at.getDate() === day);
    return { day, items };
  });

  const monthLabel = new Date(y, m, 15).toLocaleString("default", { month: "long", year: "numeric" });
  const goPrev = () => {
    if (m === 0) {
      setViewMonth(11);
      setViewYear((yy) => yy - 1);
    } else setViewMonth(m - 1);
  };
  const goNext = () => {
    if (m === 11) {
      setViewMonth(0);
      setViewYear((yy) => yy + 1);
    } else setViewMonth(m + 1);
  };
  const goToday = () => {
    const d = new Date();
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  return (
    <section className="card mt-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-brand-ink">Bookings calendar · {monthLabel}</h3>
          <p className="mt-1 text-xs text-slate-600">
            Scheduled meeting time when Cal provides it; otherwise the day the invite or confirmation was recorded.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={goPrev}
            className="rounded border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-brand-ink hover:bg-slate-50"
            aria-label="Previous month"
          >
            ←
          </button>
          <button
            type="button"
            onClick={goToday}
            className="rounded border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-brand-ink hover:bg-slate-50"
          >
            Today
          </button>
          <button
            type="button"
            onClick={goNext}
            className="rounded border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-brand-ink hover:bg-slate-50"
            aria-label="Next month"
          >
            →
          </button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase text-slate-500">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
        {dayCells.map((cell, idx) =>
          cell.day == null ? (
            <div key={`e-${idx}`} className="min-h-[72px] rounded border border-transparent bg-slate-50/30" />
          ) : (
            <div
              key={cell.day}
              className={`min-h-[72px] rounded border p-1 text-left text-xs ${cell.items.length ? "border-brand/40 bg-brand/10" : "border-stone-100 bg-white"}`}
            >
              <span className="font-semibold text-brand-ink/90">{cell.day}</span>
              {cell.items.slice(0, 2).map((e, j) => (
                <p key={j} className="mt-1 truncate text-[10px] text-slate-700" title={`${e.leadName} · ${e.status}`}>
                  {e.hasScheduledStart ? e.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Invite"}{" "}
                  {e.leadName.split(" ")[0]}
                </p>
              ))}
              {cell.items.length > 2 ? <p className="text-[10px] text-slate-500">+{cell.items.length - 2} more</p> : null}
            </div>
          )
        )}
      </div>
      {!events.length ? <p className="mt-3 text-sm text-slate-500">No booking activity with a date in {monthLabel}.</p> : null}
    </section>
  );
}

function Phase3IntelligenceCard({ metrics }: { metrics: Phase3Metrics }) {
  return (
    <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
      <p className="mb-2 text-sm font-semibold text-brand-ink/90">Phase 3 · Reply &amp; booking intelligence</p>
      <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
        {[
          ["Inbound replies", metrics.repliesReceived],
          ["Positive / link asks", metrics.positiveReplies],
          ["Booking invites sent", metrics.bookingInvitesSent],
          ["Booked meetings", metrics.bookedMeetings],
          ["Not interested", metrics.notInterested],
          ["Suppressed", metrics.unsubscribes]
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-slate-100 bg-slate-50 p-2">
            <p className="text-[11px] text-slate-500">{label}</p>
            <p className="text-lg font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="text-xs text-slate-600">
          <p className="font-medium text-brand-ink/90">Reply rate by source</p>
          {Object.entries(metrics.replyRateBySource).map(([k, v]) => (
            <p key={k}>
              {k}: {v.replied}/{v.contacted} replied
            </p>
          ))}
        </div>
        <div className="text-xs text-slate-600">
          <p className="font-medium text-brand-ink/90">Reply rate by lead type</p>
          {Object.entries(metrics.replyRateByLeadType).map(([k, v]) => (
            <p key={k}>
              {k}: {v.replied}/{v.contacted}
            </p>
          ))}
        </div>
        <div className="text-xs text-slate-600">
          <p className="font-medium text-brand-ink/90">Booking rate by priority tier</p>
          {Object.entries(metrics.bookingRateByTier).map(([k, v]) => (
            <p key={k}>
              {k}: {v.booked}/{v.eligible} booked
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}

function meetingBookingSummary(lead: Lead): { label: string; detail?: string } {
  const b = latestBookingRecord(lead);
  if (!b) return { label: "No booking yet" };
  if (lead.status === "Booked") return { label: "Booked", detail: b.meetingStart ? new Date(b.meetingStart).toLocaleString() : b.note };
  const st = (b.status || "").toLowerCase();
  if (st.includes("confirm") || st.includes("booked")) return { label: "Confirmed", detail: b.meetingStart ? new Date(b.meetingStart).toLocaleString() : undefined };
  if (lead.status === "Booking Sent" || st.includes("invit") || st.includes("pending")) return { label: "Invite / pending", detail: b.bookingLink ? clip(b.bookingLink, 40) : undefined };
  return { label: b.status || "Booking activity", detail: b.note || undefined };
}

function classifyBookingInvite(
  lead: Lead,
  b: NonNullable<Lead["bookingHistory"]>[number]
): "accepted" | "waiting" | "closed" {
  const st = (b.status || "").toLowerCase();
  const ms = (b.meetingStatus || "").toLowerCase();
  if (st === "cancelled" || ms.includes("cancel") || st.includes("deny") || ms.includes("deny")) return "closed";
  if (st === "booked" || st.includes("confirm") || lead.status === "Booked") return "accepted";
  return "waiting";
}

type BookingHistRow = NonNullable<Lead["bookingHistory"]>[number];

/** Day placement: Cal start &gt; confirmation time &gt; record created (invite sent). */
function bookingCalendarAnchor(b: BookingHistRow): Date | null {
  for (const raw of [b.meetingStart, b.bookedAt, b.at]) {
    if (raw == null || (typeof raw === "string" && !raw.trim())) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function bookingHasScheduledStart(b: BookingHistRow): boolean {
  if (!b.meetingStart?.trim()) return false;
  const d = new Date(b.meetingStart);
  return !Number.isNaN(d.getTime());
}

type BookingInviteRow = {
  lead: Lead;
  b: NonNullable<Lead["bookingHistory"]>[number];
  bucket: ReturnType<typeof classifyBookingInvite>;
};

function BookingsPageCalendar({
  rows,
  onSelect
}: {
  rows: BookingInviteRow[];
  onSelect: (row: BookingInviteRow) => void;
}) {
  type Ev = BookingInviteRow & { at: Date; key: string };
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());

  const events = useMemo(() => {
    const out: Ev[] = [];
    rows.forEach((row, i) => {
      const anchor = bookingCalendarAnchor(row.b);
      if (!anchor) return;
      out.push({ ...row, at: anchor, key: `${row.lead.id}-${row.b.at}-${i}` });
    });
    return out.sort((a, b) => a.at.getTime() - b.at.getTime());
  }, [rows]);

  const y = viewYear;
  const m = viewMonth;
  const first = new Date(y, m, 1);
  const pad = first.getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const dayCells = Array.from({ length: pad + daysInMonth }, (_, i) => {
    if (i < pad) return { day: null as number | null, items: [] as Ev[] };
    const day = i - pad + 1;
    const items = events.filter((e) => e.at.getFullYear() === y && e.at.getMonth() === m && e.at.getDate() === day);
    return { day, items };
  });

  const monthLabel = new Date(y, m, 15).toLocaleString("default", { month: "long", year: "numeric" });

  const goPrev = () => {
    if (m === 0) {
      setViewMonth(11);
      setViewYear((yy) => yy - 1);
    } else setViewMonth(m - 1);
  };
  const goNext = () => {
    if (m === 11) {
      setViewMonth(0);
      setViewYear((yy) => yy + 1);
    } else setViewMonth(m + 1);
  };
  const goToday = () => {
    const d = new Date();
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  const chipTimeLabel = (e: Ev) => {
    if (bookingHasScheduledStart(e.b)) {
      return new Date(e.b.meetingStart!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    if (e.bucket === "waiting") return "Invite out";
    return e.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };

  const chipClass = (bucket: BookingInviteRow["bucket"]) =>
    bucket === "accepted"
      ? "border-emerald-200 bg-emerald-50/90 text-emerald-950"
      : bucket === "waiting"
        ? "border-amber-200 bg-amber-50/90 text-amber-950"
        : "border-slate-200 bg-slate-100/90 text-slate-700";

  return (
    <section className="card">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-brand-ink">Live calendar</h3>
          <p className="mt-1 text-xs text-slate-600">
            Uses the real meeting start from Cal when present; otherwise the confirmation or invite timestamp for day placement. Click an entry for details.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={goPrev}
              className="rounded border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-brand-ink hover:bg-slate-50"
              aria-label="Previous month"
            >
              ←
            </button>
            <button
              type="button"
              onClick={goToday}
              className="rounded border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-brand-ink hover:bg-slate-50"
            >
              Today
            </button>
            <button
              type="button"
              onClick={goNext}
              className="rounded border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-brand-ink hover:bg-slate-50"
              aria-label="Next month"
            >
              →
            </button>
          </div>
          <p className="text-xs text-slate-500">
            <span className="mr-2 inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400" /> Pending
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> Confirmed
            </span>
          </p>
        </div>
      </div>
      <p className="mt-2 text-sm font-medium text-brand-ink/85">{monthLabel}</p>
      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase text-slate-500">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
        {dayCells.map((cell, idx) =>
          cell.day == null ? (
            <div key={`e-${idx}`} className="min-h-[80px] rounded border border-transparent bg-slate-50/30" />
          ) : (
            <div
              key={cell.day}
              className={`min-h-[80px] rounded border p-1 text-left text-xs ${cell.items.length ? "border-brand/35 bg-brand/5" : "border-stone-100 bg-white"}`}
            >
              <span className="font-semibold text-brand-ink/90">{cell.day}</span>
              <div className="mt-1 space-y-0.5">
                {cell.items.slice(0, 4).map((e) => (
                  <button
                    key={e.key}
                    type="button"
                    onClick={() => onSelect(e)}
                    className={`flex w-full flex-col rounded border border-transparent px-1 py-0.5 text-left text-[10px] leading-tight transition hover:opacity-90 ${chipClass(e.bucket)}`}
                  >
                    <span className="font-medium">{chipTimeLabel(e)}</span>
                    <span className="truncate">{e.lead.fullName.split(" ")[0]}</span>
                    <span className="text-[9px] opacity-90">{e.bucket === "waiting" ? "Pending" : e.bucket === "accepted" ? "Confirmed" : "Closed"}</span>
                  </button>
                ))}
                {cell.items.length > 4 ? (
                  <p className="text-[10px] text-slate-500">+{cell.items.length - 4} more</p>
                ) : null}
              </div>
            </div>
          )
        )}
      </div>
      {!events.length ? (
        <p className="mt-3 text-sm text-slate-500">No booking activity with a date in {monthLabel}.</p>
      ) : null}
    </section>
  );
}

function InboxChatColumn({
  vm,
  inboxLead,
  inboxLeadId,
  latestBookingRecordFn,
  clip,
  reviewEdit,
  setReviewEdit,
  className
}: {
  vm: ReturnType<typeof useDashboard>;
  inboxLead: Lead | null;
  inboxLeadId: string | null;
  latestBookingRecordFn: typeof latestBookingRecord;
  clip: (s: string, n: number) => string;
  reviewEdit: string;
  setReviewEdit: Dispatch<SetStateAction<string>>;
  className?: string;
}) {
  const selectedThread = vm.inboxThreads.find((t) => t.leadId === inboxLeadId) ?? null;

  return (
    <div className={className ?? "flex min-h-0 flex-1 flex-col gap-3 space-y-0"}>
      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <h3 className="mb-1 shrink-0 font-semibold text-brand-ink">Chat history</h3>
        {!inboxLead || !selectedThread ? (
          <p className="text-sm text-slate-500">Select a thread above to review, approve, and send.</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <p className="text-sm font-medium text-brand-ink">{inboxLead.fullName}</p>
            <p className="text-xs text-slate-500">{inboxLead.email}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <SourceBadge source={inboxLead.source} />
              <StatusBadge status={inboxLead.status} />
              {(() => {
                const b = latestBookingRecordFn(inboxLead);
                return b ? <BookingStatusBadge status={b.status} /> : null;
              })()}
            </div>
            <p className="mt-2 text-[11px] leading-snug text-slate-600">
              <span className="font-semibold text-slate-700">Provenance:</span> {clip(inboxLead.sourceDetail, 200)}
            </p>

            <div className="mt-3 flex min-h-0 flex-col gap-3 md:flex-row md:items-stretch">
              <div className="grid min-h-0 min-w-0 flex-1 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div>
                  <p className="text-[11px] font-semibold text-slate-700">Last outbound</p>
                  <p className="mt-1 max-h-28 overflow-y-auto text-xs text-slate-700 whitespace-pre-wrap">
                    {selectedThread.lastOutboundSnippet}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-slate-700">Their reply (last inbound)</p>
                  <p className="mt-1 max-h-40 overflow-y-auto text-xs text-slate-700 whitespace-pre-wrap">
                    {selectedThread.inboundSnippet}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-200/80 pt-2">
                  <span className="rounded-md bg-stone-100 px-2 py-0.5 text-[11px] font-medium capitalize text-brand-ink">
                    {selectedThread.classification.replace(/_/g, " ")}
                  </span>
                  <span className="text-[11px] text-slate-600">{(selectedThread.confidence * 100).toFixed(0)}% model confidence</span>
                </div>
                <p className="text-[11px] text-slate-600">Next step: {selectedThread.recommendedNext}</p>
              </div>

              {inboxLead.latestInbound?.needsReview ? (
                <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col space-y-2 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm md:max-w-[min(100%,480px)] md:shrink-0">
                  <p className="font-medium text-orange-900">Review queue</p>
                  <AutomationAuditBadges
                    needsReview={inboxLead.latestInbound.needsReview}
                    automationAllowed={inboxLead.latestInbound.automationAllowed ?? false}
                    automationBlockedReason={inboxLead.latestInbound.automationBlockedReason}
                    mixedIntent={inboxLead.latestInbound.mixedIntent}
                  />
                  <p className="text-[11px] text-slate-700">{inboxLead.latestInbound.classificationReason}</p>
                  {inboxLead.latestInbound.suggestedReplyDraft && (
                    <div className="max-h-28 overflow-y-auto rounded border border-orange-100 bg-white p-2 text-xs whitespace-pre-wrap text-brand-ink/90">
                      {inboxLead.latestInbound.suggestedReplyDraft}
                    </div>
                  )}
                  <textarea
                    className="min-h-[88px] w-full shrink-0 rounded border border-orange-200 bg-white p-2 text-xs"
                    rows={4}
                    value={reviewEdit || inboxLead.latestInbound?.suggestedReplyDraft || ""}
                    onChange={(e) => setReviewEdit(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink hover:bg-brand-dark"
                      onClick={() => {
                        const d = inboxLead.latestInbound?.suggestedReplyDraft || "";
                        void vm.sendReviewReply(inboxLead.id, d, inboxLead.latestInbound?.id);
                      }}
                    >
                      Approve &amp; send
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-orange-400 bg-white px-3 py-1.5 text-xs font-semibold text-orange-900"
                      onClick={() =>
                        void vm.sendReviewReply(
                          inboxLead.id,
                          reviewEdit || inboxLead.latestInbound?.suggestedReplyDraft || "",
                          inboxLead.latestInbound?.id
                        )
                      }
                    >
                      Edit &amp; send
                    </button>
                    <input
                      type="date"
                      className="rounded border px-2 py-1 text-xs"
                      onChange={(e) => e.target.value && void vm.snoozeLeadClient(inboxLead.id, new Date(e.target.value).toISOString())}
                    />
                    <span className="self-center text-[10px] text-slate-600">Snooze</span>
                    <button
                      type="button"
                      className="rounded-md border border-rose-200 px-3 py-1.5 text-xs text-rose-800"
                      onClick={() => void vm.markNotInterestedClient(inboxLead.id)}
                    >
                      Not interested
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function DashboardApp({
  initialLeads,
  initialCampaigns,
  initialInboxThreads,
  initialPhase3Metrics,
  initialBookingLinkConfigured = true,
  initialBookingLinkDisplay = "",
  initialBookingReplyPreview = "",
  initialOutreachDryRun = true,
  importSummary
}: {
  initialLeads: Lead[];
  initialCampaigns: Campaign[];
  initialInboxThreads: InboxThread[];
  initialPhase3Metrics: Phase3Metrics;
  initialBookingLinkConfigured?: boolean;
  initialBookingLinkDisplay?: string;
  initialBookingReplyPreview?: string;
  initialOutreachDryRun?: boolean;
  importSummary: ImportSummary;
}) {
  const vm = useDashboard(
    initialLeads,
    initialCampaigns,
    initialInboxThreads,
    initialPhase3Metrics,
    initialBookingLinkConfigured,
    initialBookingLinkDisplay,
    initialBookingReplyPreview,
    initialOutreachDryRun
  );

  type LeadStatFilterAction =
    | "reset"
    | "source_csv"
    | "source_external"
    | "status_booking_sent"
    | "status_booked"
    | "addr_86"
    | "addr_71"
    | "addr_lt71"
    | "addr_very_poor";

  const applyLeadStatFilter = useCallback(
    (action: LeadStatFilterAction) => {
      switch (action) {
        case "reset":
          vm.setFilters(() => ({ ...defaultLeadFilters }));
          break;
        case "source_csv":
          vm.setFilters(() => ({ ...defaultLeadFilters, source: "CSV Import" }));
          break;
        case "source_external":
          vm.setFilters(() => ({ ...defaultLeadFilters, source: "Scraped / External" }));
          break;
        case "status_booking_sent":
          vm.setFilters(() => ({ ...defaultLeadFilters, status: "Booking Sent" }));
          break;
        case "status_booked":
          vm.setFilters(() => ({ ...defaultLeadFilters, status: "Booked" }));
          break;
        case "addr_86":
          vm.setFilters(() => ({ ...defaultLeadFilters, addressQuick: "verified_86" }));
          break;
        case "addr_71":
          vm.setFilters(() => ({ ...defaultLeadFilters, addressQuick: "reachable_71" }));
          break;
        case "addr_lt71":
          vm.setFilters(() => ({ ...defaultLeadFilters, addressQuick: "needs_review_under_71" }));
          break;
        case "addr_very_poor":
          vm.setFilters(() => ({
            ...defaultLeadFilters,
            addressConfidenceMin: "0",
            addressConfidenceMax: String(OUTREACH_ADDRESS_VERY_POOR_MAX)
          }));
          break;
      }
    },
    [vm.setFilters]
  );

  const [simulationLeadId, setSimulationLeadId] = useState<string | null>(() => initialLeads[0]?.id ?? null);
  const [simReplyDraft, setSimReplyDraft] = useState("");

  useEffect(() => {
    if (!vm.leads.length) return;
    if (simulationLeadId && vm.leads.some((l) => l.id === simulationLeadId)) return;
    const top = [...vm.leads].sort((a, b) => b.score - a.score)[0];
    setSimulationLeadId(top?.id ?? null);
  }, [vm.leads, simulationLeadId]);
  const [campaignName, setCampaignName] = useState("Kitchen Intro Sprint");
  const [campaignIncludeBelow71, setCampaignIncludeBelow71] = useState(false);
  const [campaignIncludeVeryPoor, setCampaignIncludeVeryPoor] = useState(false);
  const [campaignConfirmLow, setCampaignConfirmLow] = useState(false);
  const [campaignOverrideVerify, setCampaignOverrideVerify] = useState(false);
  const [activeView, setActiveView] = useState<(typeof SIDEBAR_VIEWS)[number]>("dashboard");
  const [liteMode, setLiteMode] = useState(false);
  const [dashboardTab, setDashboardTab] = useState<"active" | "lost">("active");
  const [bookingDetailPick, setBookingDetailPick] = useState<BookingInviteRow | null>(null);
  const [inboxLeadId, setInboxLeadId] = useState<string | null>(null);
  const [inboxTab, setInboxTab] = useState<(typeof INBOX_TABS)[number]>("Needs Review");
  const [reviewEdit, setReviewEdit] = useState("");
  const [calWebhookTest, setCalWebhookTest] = useState<string | null>(null);
  const [isCalWebhookTesting, setIsCalWebhookTesting] = useState(false);
  const [addLeadOpen, setAddLeadOpen] = useState(false);
  const [addLeadBusy, setAddLeadBusy] = useState(false);
  const [addLeadForm, setAddLeadForm] = useState({
    firstName: "",
    lastName: "",
    company: "",
    email: "",
    phone: "",
    city: "",
    state: "",
    zip: "",
    leadType: "homeowner" as LeadType,
    amountSpent: "0",
    distanceMinutes: "30",
    addressConfidence: "",
    notes: "",
    sourceDetail: ""
  });
  const resetAddLeadForm = () =>
    setAddLeadForm({
      firstName: "",
      lastName: "",
      company: "",
      email: "",
      phone: "",
      city: "",
      state: "",
      zip: "",
      leadType: "homeowner",
      amountSpent: "0",
      distanceMinutes: "30",
      addressConfidence: "",
      notes: "",
      sourceDetail: ""
    });
  const inboxLead = vm.leads.find((l) => l.id === inboxLeadId) ?? null;

  const visibleViews = liteMode ? LITE_SIDEBAR_VIEWS : SIDEBAR_VIEWS;

  useEffect(() => {
    if (liteMode && !LITE_SIDEBAR_VIEWS.includes(activeView as (typeof LITE_SIDEBAR_VIEWS)[number])) {
      setActiveView("inbox");
    }
  }, [liteMode, activeView]);

  const inboxByTab = useMemo(() => {
    const map = {} as Record<(typeof INBOX_TABS)[number], InboxThread[]>;
    for (const tab of INBOX_TABS) {
      map[tab] = vm.inboxThreads.filter((t) => {
        const lead = vm.leads.find((l) => l.id === t.leadId);
        return inboxTabMatches(t, lead, tab);
      });
    }
    return map;
  }, [vm.inboxThreads, vm.leads]);

  const exportData = () => {
    const blob = new Blob([JSON.stringify(vm.filtered, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "gloria-leads-export.json";
    a.click();
  };
  const selectedLeads = vm.leads.filter((l) => vm.selectedIds.includes(l.id));
  const bookingLinkPreview = vm.bookingLinkDisplay || appConfig.bookingLink || "";
  const campaignSequencePreview = useMemo(() => getCampaignSequencePreview(bookingLinkPreview), [bookingLinkPreview]);
  const firstTouchLaunchSamples = useMemo(
    () =>
      selectedLeads.slice(0, 5).map((lead) => ({
        lead,
        rendered: renderFirstTouchForLead(lead, bookingLinkPreview)
      })),
    [selectedLeads, bookingLinkPreview]
  );

  const launchAddressOpts = useMemo(
    () => ({
      includeBelowOutreachMin: campaignIncludeBelow71,
      includeVeryPoorAddress: campaignIncludeVeryPoor,
      confirmLowAddressRisk: campaignConfirmLow,
      includeUnverifiedHighScore: campaignOverrideVerify
    }),
    [campaignIncludeBelow71, campaignIncludeVeryPoor, campaignConfirmLow, campaignOverrideVerify]
  );

  const campaignAddressPreview = useMemo(() => {
    const strict = {
      includeBelowOutreachMin: false,
      includeVeryPoorAddress: false,
      confirmLowAddressRisk: false
    };
    const bands = { strong: 0, good: 0, caution: 0, weak: 0, poor: 0, unknown: 0 };
    let excludedByDefault = 0;
    let excludedVeryPoor = 0;
    const riskyWithNotes: { id: string; name: string; score: number | null; notes: string }[] = [];
    for (const lead of selectedLeads) {
      bands[addressConfidenceBand(lead.addressConfidence)] += 1;
      const eligStrict = campaignSendEligibility(lead, strict);
      if (!eligStrict.eligible) {
        if (eligStrict.reason === "very_poor_address") excludedVeryPoor += 1;
        else excludedByDefault += 1;
      }
      const s = lead.addressConfidence;
      const n = s === null || s === undefined || Number.isNaN(s) ? null : Math.round(s);
      if ((n === null || n < OUTREACH_ADDRESS_MIN_DEFAULT) && lead.confidenceNotes?.trim()) {
        riskyWithNotes.push({
          id: lead.id,
          name: lead.fullName,
          score: n,
          notes: lead.confidenceNotes.trim()
        });
      }
    }
    const wouldSendNow = selectedLeads.filter((l) => isEligibleForCampaignSend(l, launchAddressOpts)).length;
    const needsConfirmEstimate = selectedLeads.filter((l) => {
      if (!isEligibleForCampaignSend(l, launchAddressOpts)) return false;
      const v = l.addressConfidence;
      const nn = v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v);
      return nn === null || nn <= 50;
    }).length;
    return {
      bands,
      excludedByDefault,
      excludedVeryPoor,
      riskyWithNotes,
      wouldSendNow,
      needsConfirmEstimate
    };
  }, [selectedLeads, launchAddressOpts]);

  const lowAddressInSelection = useMemo(
    () =>
      selectedLeads.some((l) => {
        const v = l.addressConfidence;
        if (v === null || v === undefined || Number.isNaN(v)) return true;
        return Math.round(v) < OUTREACH_ADDRESS_MIN_DEFAULT;
      }),
    [selectedLeads]
  );

  const veryPoorInSelection = useMemo(
    () =>
      selectedLeads.some((l) => {
        const v = l.addressConfidence;
        if (v === null || v === undefined || Number.isNaN(v)) return false;
        return Math.round(v) <= OUTREACH_ADDRESS_VERY_POOR_MAX;
      }),
    [selectedLeads]
  );

  const selectionNeedsLowAddressConfirm = useMemo(
    () =>
      selectedLeads.some(
        (l) => isEligibleForCampaignSend(l, launchAddressOpts) && leadNeedsLowAddressConfirm(l)
      ),
    [selectedLeads, launchAddressOpts]
  );

  const unapprovedHighScoreInSelection = useMemo(
    () =>
      selectedLeads.filter(
        (l) =>
          l.score >= DEPLOY_VERIFY_MIN_SCORE &&
          l.deployVerifyVerdict !== "approved" &&
          l.deployVerifyVerdict !== "rejected"
      ).length,
    [selectedLeads]
  );

  const singleSelectedLead =
    vm.selectedIds.length === 1 ? vm.leads.find((l) => l.id === vm.selectedIds[0]) : undefined;
  const conversionBy = (key: "leadType" | "source" | "priorityTier") =>
    Object.entries(
      vm.leads.reduce<Record<string, { total: number; booked: number }>>((acc, lead) => {
        const k = lead[key];
        acc[k] = acc[k] ?? { total: 0, booked: 0 };
        acc[k].total += 1;
        if (lead.status === "Booked") acc[k].booked += 1;
        return acc;
      }, {})
    );
  const isLostLead = (l: Lead) => l.status === "Not Interested" || l.doNotContact;

  /** Replied and still in play (not retired to lost). */
  const dashboardActiveLeads = useMemo(
    () => vm.leads.filter((l) => (l.replyHistory?.length ?? 0) > 0 && !isLostLead(l)),
    [vm.leads]
  );
  /** Replied then marked not interested / DNC — archived pipeline. */
  const dashboardLostLeads = useMemo(
    () => vm.leads.filter((l) => (l.replyHistory?.length ?? 0) > 0 && isLostLead(l)),
    [vm.leads]
  );
  const dashboardRows = dashboardTab === "active" ? dashboardActiveLeads : dashboardLostLeads;

  const sortedDashboardRows = useMemo(() => {
    const rows = [...dashboardRows];
    const byLastReplyDesc = (a: Lead, b: Lead) => {
      const ta = lastReplyAtIso(a);
      const tb = lastReplyAtIso(b);
      return (tb ? new Date(tb).getTime() : 0) - (ta ? new Date(ta).getTime() : 0);
    };
    const notInterestedLast = (a: Lead, b: Lead) => {
      const ai = a.status === "Not Interested" ? 1 : 0;
      const bi = b.status === "Not Interested" ? 1 : 0;
      return ai - bi;
    };
    if (dashboardTab === "lost") {
      rows.sort(byLastReplyDesc);
    } else {
      rows.sort((a, b) => {
        const ni = notInterestedLast(a, b);
        if (ni !== 0) return ni;
        return byLastReplyDesc(a, b);
      });
    }
    return rows;
  }, [dashboardRows, dashboardTab]);

  const bookingInviteList = useMemo(() => {
    const rows: { lead: Lead; b: Lead["bookingHistory"][number]; bucket: ReturnType<typeof classifyBookingInvite> }[] = [];
    for (const lead of vm.leads) {
      for (const b of lead.bookingHistory) {
        rows.push({ lead, b, bucket: classifyBookingInvite(lead, b) });
      }
    }
    return rows;
  }, [vm.leads]);

  const simulationSuggestedLeads = useMemo(
    () =>
      [...vm.leads]
        .filter((l) => !l.doNotContact)
        .sort((a, b) => b.score - a.score || (a.fullName || "").localeCompare(b.fullName || ""))
        .slice(0, 8),
    [vm.leads]
  );

  return (
    <div className="min-h-screen">
      <div className="grid min-h-screen grid-cols-[250px_1fr]">
        <aside className="border-r border-white/10 bg-brand-ink p-4 text-stone-100">
          <div className="mb-6 flex items-center justify-center px-1">
            <img src="/gloria-logo.svg" alt="Gloria" className="h-11 w-auto max-w-[200px] opacity-95" />
          </div>
          <nav className="space-y-2 text-sm">
            {visibleViews.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setActiveView(v)}
                className={`block w-full rounded px-3 py-2 text-left capitalize ${activeView === v ? "bg-brand font-medium text-brand-ink shadow-sm" : "text-stone-100 hover:bg-brand-inkLight"}`}
              >
                {v}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setLiteMode((v) => !v)}
              className={`mt-2 block w-full rounded border px-3 py-2 text-left text-xs font-medium ${
                liteMode
                  ? "border-stone-300 bg-stone-100 text-brand-ink"
                  : "border-white/20 text-stone-200 hover:bg-brand-inkLight"
              }`}
            >
              {liteMode ? "Lite mode: Inbox + Bookings" : "Switch to Lite mode"}
            </button>
            <button
              type="button"
              onClick={exportData}
              className="mt-2 block w-full rounded border border-white/20 px-3 py-2 text-left text-xs font-medium text-stone-200 hover:bg-brand-inkLight hover:text-white"
            >
              Export (includes source)
            </button>
          </nav>
        </aside>

        <main className="p-4">
          {!vm.bookingLinkConfigured && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              <p className="font-semibold">BOOKING_LINK not configured</p>
              <p className="mt-1 text-xs">
                Set <code className="rounded bg-white/80 px-1">BOOKING_LINK</code> (and optionally{" "}
                <code className="rounded bg-white/80 px-1">NEXT_PUBLIC_BOOKING_LINK</code>) in your environment to your public Cal.com event URL. Until then,
                booking automation is blocked and drafts show a placeholder.
              </p>
            </div>
          )}

          {activeView === "leads" && (
            <section className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-11">
              {(
                [
                  { label: "Total Leads", value: vm.metrics.totalLeads, filter: "reset" as const },
                  { label: "Qualified", value: vm.metrics.qualifiedLeads, filter: null },
                  { label: "CSV Leads", value: vm.metrics.csvLeads, filter: "source_csv" as const },
                  { label: "External", value: vm.metrics.externalLeads, filter: "source_external" as const },
                  { label: "Online Enriched", value: vm.metrics.enrichedLeads, filter: null },
                  { label: "Campaigns", value: vm.metrics.campaignsLaunched, filter: null },
                  { label: "Emails Sent", value: vm.metrics.emailsSent, filter: null },
                  { label: "Replies", value: vm.metrics.replies, filter: null },
                  { label: "Positive Replies", value: vm.metrics.positiveReplies, filter: null },
                  { label: "Booking Sent", value: vm.metrics.bookingSent, filter: "status_booking_sent" as const },
                  { label: "Booked", value: vm.metrics.booked, filter: "status_booked" as const },
                  { label: "Addr score 86+", value: vm.addressMetrics.verified, filter: "addr_86" as const },
                  { label: "Addr score 71+", value: vm.addressMetrics.good, filter: "addr_71" as const },
                  { label: "Addr <71 (review)", value: vm.addressMetrics.low, filter: "addr_lt71" as const },
                  { label: "Addr ≤10 (very poor)", value: vm.addressMetrics.veryPoor, filter: "addr_very_poor" as const }
                ] as const
              ).map(({ label, value, filter }) => {
                const interactive = filter !== null;
                const inner = (
                  <>
                    <p className="line-clamp-2 text-[10px] leading-tight text-slate-500">{label}</p>
                    <p className="text-sm font-bold tabular-nums leading-tight text-brand-ink">{value}</p>
                  </>
                );
                const boxClass =
                  "rounded-md border border-slate-200 bg-white px-1.5 py-1 text-left shadow-sm transition-colors" +
                  (interactive ? " cursor-pointer hover:border-slate-400 hover:bg-slate-50" : "");
                if (!interactive) {
                  return (
                    <div key={label} className={boxClass}>
                      {inner}
                    </div>
                  );
                }
                return (
                  <button
                    key={label}
                    type="button"
                    className={boxClass}
                    title="Apply matching filters to the lead library below"
                    onClick={() => applyLeadStatFilter(filter)}
                  >
                    {inner}
                  </button>
                );
              })}
            </section>
          )}
          {activeView === "leads" && (
            <section className="mb-3 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-700">
              <p className="font-semibold text-brand-ink/90">
                <span title={ADDRESS_CONFIDENCE_TOOLTIP} className="cursor-help border-b border-dotted border-slate-400">
                  Address confidence bands
                </span>{" "}
                (selected CSV pass)
              </p>
              <p className="mt-1">
                Strong 86+: {vm.addressMetrics.bands.strong} · Good 71–85: {vm.addressMetrics.bands.good} · Caution 51–70:{" "}
                {vm.addressMetrics.bands.caution} · Weak 31–50: {vm.addressMetrics.bands.weak} · Poor 0–30:{" "}
                {vm.addressMetrics.bands.poor} · Unknown: {vm.addressMetrics.bands.unknown}
              </p>
              <p className="mt-1 font-medium text-brand-ink/90">
                Outreach-ready by classification (addr ≥{OUTREACH_ADDRESS_MIN_DEFAULT}, not DNC): designer/architect{" "}
                {vm.addressMetrics.byClass.designer_architect} · builder/contractor {vm.addressMetrics.byClass.builder_contractor} · cabinet partner{" "}
                {vm.addressMetrics.byClass.cabinet_shop_partner} · homeowner {vm.addressMetrics.byClass.homeowner}
              </p>
            </section>
          )}
          {activeView === "leads" && (
            <section className="mb-4 grid grid-cols-4 gap-3">
              {[
                ["CSV Import", vm.sourceCounts["CSV Import"] ?? 0],
                ["Online Enriched", vm.sourceCounts["Online Enriched"] ?? 0],
                ["Scraped / External", vm.sourceCounts["Scraped / External"] ?? 0],
                ["Manual", vm.sourceCounts.Manual ?? 0]
              ].map(([label, value]) => (
                <div key={label} className="card">
                  <p className="text-xs text-slate-500">Source: {label}</p>
                  <p className="text-2xl font-bold">{value}</p>
                </div>
              ))}
            </section>
          )}

          {activeView === "leads" && (
            <section className="mb-4 card text-sm">
              <p className="font-semibold">CSV Import Summary</p>
              <p>
                File: <strong>resources/{importSummary.sourceFile}</strong> · Total rows: {importSummary.totalRows} | Valid rows:{" "}
                {importSummary.validRows} | Skipped: {importSummary.skippedRows} | Duplicates: {importSummary.duplicateRows}
              </p>
            </section>
          )}

          {activeView === "leads" && (
            <section className="card overflow-hidden border-t-4 border-brand/35 bg-gradient-to-b from-white to-slate-50 shadow-sm">
                {addLeadOpen ? (
                  <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
                    role="presentation"
                    onClick={() => {
                      if (!addLeadBusy) setAddLeadOpen(false);
                    }}
                  >
                    <div
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="add-lead-title"
                      className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <h3 id="add-lead-title" className="text-lg font-semibold text-brand-ink">
                        Add lead
                      </h3>
                      <p className="mt-1 text-xs text-slate-600">
                        Creates a <strong>Manual</strong> source lead, recomputes fit score from distance / spend / type, and sets Verify to pending if score is high.
                      </p>
                      <form
                        className="mt-4 space-y-3"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          setAddLeadBusy(true);
                          try {
                            const addrTrim = addLeadForm.addressConfidence.trim();
                            const addrNum = addrTrim === "" ? NaN : Number(addrTrim);
                            const r = await vm.createLead({
                              firstName: addLeadForm.firstName.trim(),
                              lastName: addLeadForm.lastName.trim(),
                              company: addLeadForm.company.trim(),
                              email: addLeadForm.email.trim(),
                              phone: addLeadForm.phone.trim(),
                              city: addLeadForm.city.trim(),
                              state: addLeadForm.state.trim(),
                              zip: addLeadForm.zip.trim(),
                              leadType: addLeadForm.leadType,
                              amountSpent: Number(addLeadForm.amountSpent) || 0,
                              distanceMinutes: Number(addLeadForm.distanceMinutes) || 30,
                              notes: addLeadForm.notes.trim(),
                              sourceDetail: addLeadForm.sourceDetail.trim() || undefined,
                              addressConfidence:
                                addrTrim === "" || !Number.isFinite(addrNum) ? null : addrNum
                            });
                            if (!r.ok) {
                              if (r.error === "duplicate_email") {
                                window.alert("A lead with this email already exists.");
                              } else {
                                window.alert(`Could not add lead: ${r.error}`);
                              }
                              return;
                            }
                            setAddLeadOpen(false);
                            resetAddLeadForm();
                          } finally {
                            setAddLeadBusy(false);
                          }
                        }}
                      >
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            required
                            className="rounded border border-slate-300 p-2 text-sm"
                            placeholder="First name *"
                            value={addLeadForm.firstName}
                            onChange={(e) => setAddLeadForm((f) => ({ ...f, firstName: e.target.value }))}
                          />
                          <input
                            required
                            className="rounded border border-slate-300 p-2 text-sm"
                            placeholder="Last name *"
                            value={addLeadForm.lastName}
                            onChange={(e) => setAddLeadForm((f) => ({ ...f, lastName: e.target.value }))}
                          />
                        </div>
                        <input
                          required
                          type="email"
                          className="w-full rounded border border-slate-300 p-2 text-sm"
                          placeholder="Email *"
                          value={addLeadForm.email}
                          onChange={(e) => setAddLeadForm((f) => ({ ...f, email: e.target.value }))}
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            className="rounded border border-slate-300 p-2 text-sm"
                            placeholder="Phone"
                            value={addLeadForm.phone}
                            onChange={(e) => setAddLeadForm((f) => ({ ...f, phone: e.target.value }))}
                          />
                          <input
                            className="rounded border border-slate-300 p-2 text-sm"
                            placeholder="Company"
                            value={addLeadForm.company}
                            onChange={(e) => setAddLeadForm((f) => ({ ...f, company: e.target.value }))}
                          />
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <input
                            className="rounded border border-slate-300 p-2 text-sm"
                            placeholder="City"
                            value={addLeadForm.city}
                            onChange={(e) => setAddLeadForm((f) => ({ ...f, city: e.target.value }))}
                          />
                          <input
                            className="rounded border border-slate-300 p-2 text-sm"
                            placeholder="State"
                            value={addLeadForm.state}
                            onChange={(e) => setAddLeadForm((f) => ({ ...f, state: e.target.value }))}
                          />
                          <input
                            className="rounded border border-slate-300 p-2 text-sm"
                            placeholder="ZIP"
                            value={addLeadForm.zip}
                            onChange={(e) => setAddLeadForm((f) => ({ ...f, zip: e.target.value }))}
                          />
                        </div>
                        <select
                          className="w-full rounded border border-slate-300 p-2 text-sm"
                          value={addLeadForm.leadType}
                          onChange={(e) =>
                            setAddLeadForm((f) => ({ ...f, leadType: e.target.value as LeadType }))
                          }
                        >
                          {MANUAL_LEAD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-xs text-slate-600">
                            <span className="mb-0.5 block font-medium">Est. project spend ($)</span>
                            <input
                              type="number"
                              min={0}
                              className="w-full rounded border border-slate-300 p-2 text-sm"
                              value={addLeadForm.amountSpent}
                              onChange={(e) => setAddLeadForm((f) => ({ ...f, amountSpent: e.target.value }))}
                            />
                          </label>
                          <label className="text-xs text-slate-600">
                            <span className="mb-0.5 block font-medium">Distance (minutes)</span>
                            <input
                              type="number"
                              min={0}
                              className="w-full rounded border border-slate-300 p-2 text-sm"
                              value={addLeadForm.distanceMinutes}
                              onChange={(e) => setAddLeadForm((f) => ({ ...f, distanceMinutes: e.target.value }))}
                            />
                          </label>
                        </div>
                        <label className="block text-xs text-slate-600">
                          <span className="mb-0.5 block font-medium">Address confidence (0–100, optional)</span>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            className="w-full rounded border border-slate-300 p-2 text-sm"
                            placeholder="Leave blank if unknown"
                            value={addLeadForm.addressConfidence}
                            onChange={(e) => setAddLeadForm((f) => ({ ...f, addressConfidence: e.target.value }))}
                          />
                        </label>
                        <input
                          className="w-full rounded border border-slate-300 p-2 text-sm"
                          placeholder="Source detail (optional)"
                          value={addLeadForm.sourceDetail}
                          onChange={(e) => setAddLeadForm((f) => ({ ...f, sourceDetail: e.target.value }))}
                        />
                        <textarea
                          className="w-full rounded border border-slate-300 p-2 text-sm"
                          rows={3}
                          placeholder="Notes (optional)"
                          value={addLeadForm.notes}
                          onChange={(e) => setAddLeadForm((f) => ({ ...f, notes: e.target.value }))}
                        />
                        <div className="flex justify-end gap-2 pt-2">
                          <button
                            type="button"
                            disabled={addLeadBusy}
                            className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-brand-ink/90 hover:bg-slate-50 disabled:opacity-50"
                            onClick={() => {
                              if (!addLeadBusy) setAddLeadOpen(false);
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            disabled={addLeadBusy}
                            className="rounded bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-dark disabled:opacity-50"
                          >
                            {addLeadBusy ? "Saving…" : "Save lead"}
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                ) : null}
                <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-brand-ink">Lead library</h2>
                      <p className="mt-0.5 text-xs text-slate-600">
                        Sorted by <strong>score</strong> (highest first). Filter, multi-select with checkboxes, preview first-touch copy, and launch campaigns to the
                        selected audience.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-dark"
                      onClick={() => {
                        resetAddLeadForm();
                        setAddLeadOpen(true);
                      }}
                    >
                      Add lead
                    </button>
                  </div>
                </div>
                <div className="p-4">
                <div className="mb-3 grid grid-cols-4 gap-2">
                  <input className="rounded border p-2 text-sm" placeholder="Search name/company/email" value={vm.filters.query} onChange={(e) => vm.setFilters((f) => ({ ...f, query: e.target.value }))} />
                  <select className="rounded border p-2 text-sm" value={vm.filters.source} onChange={(e) => vm.setFilters((f) => ({ ...f, source: e.target.value as typeof f.source }))}>
                    <option value="all">All sources</option><option>CSV Import</option><option>Online Enriched</option><option>Scraped / External</option><option>Manual</option>
                  </select>
                  <select className="rounded border p-2 text-sm" value={vm.filters.priorityTier} onChange={(e) => vm.setFilters((f) => ({ ...f, priorityTier: e.target.value as typeof f.priorityTier }))}>
                    <option value="all">All priorities</option><option>Tier A</option><option>Tier B</option><option>Tier C</option><option>Tier D</option>
                  </select>
                  <select className="rounded border p-2 text-sm" value={vm.filters.status} onChange={(e) => vm.setFilters((f) => ({ ...f, status: e.target.value as typeof f.status }))}>
                    <option value="all">All status</option><option>New</option><option>Qualified</option><option>In Campaign</option><option>Interested</option><option>Needs Review</option><option>Booking Sent</option><option>Booked</option><option>Not Interested</option><option>Not Now</option>
                  </select>
                </div>
                <div className="mb-3 grid grid-cols-4 gap-2">
                  <select className="rounded border p-2 text-sm" value={vm.filters.leadType} onChange={(e) => vm.setFilters((f) => ({ ...f, leadType: e.target.value as typeof f.leadType }))}>
                    <option value="all">All lead types</option><option>designer</option><option>architect</option><option>builder</option><option>cabinet shop</option><option>homeowner</option><option>commercial builder</option>
                  </select>
                  <select className="rounded border p-2 text-sm" value={vm.filters.projectTier} onChange={(e) => vm.setFilters((f) => ({ ...f, projectTier: e.target.value as typeof f.projectTier }))}>
                    <option value="all">All project tiers</option><option>Sub-$20k</option><option>$20k-$40k</option><option>$40k-$100k</option><option>$100k-$300k</option><option>$300k+</option>
                  </select>
                  <select className="rounded border p-2 text-sm" value={vm.filters.contacted} onChange={(e) => vm.setFilters((f) => ({ ...f, contacted: e.target.value as typeof f.contacted }))}>
                    <option value="all">Contacted + not contacted</option><option value="contacted">Contacted</option><option value="not_contacted">Not contacted</option>
                  </select>
                  <input className="rounded border p-2 text-sm" type="number" value={vm.filters.maxDistance} onChange={(e) => vm.setFilters((f) => ({ ...f, maxDistance: Number(e.target.value) || 180 }))} placeholder="Max distance minutes" />
                </div>
                <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-6">
                  <select
                    className="rounded border p-2 text-sm"
                    value={vm.filters.addressQuick}
                    onChange={(e) =>
                      vm.setFilters((f) => ({
                        ...f,
                        addressQuick: e.target.value as typeof f.addressQuick
                      }))
                    }
                  >
                    <option value="all">Address: all</option>
                    <option value="verified_86">Verified / strong (≥86)</option>
                    <option value="reachable_71">Reachable for outreach (≥71)</option>
                    <option value="needs_review_under_71">Needs review (&lt;71 or unknown)</option>
                  </select>
                  <select
                    className="rounded border p-2 text-sm"
                    value={vm.filters.addressBand}
                    onChange={(e) =>
                      vm.setFilters((f) => ({
                        ...f,
                        addressBand: e.target.value as typeof f.addressBand
                      }))
                    }
                  >
                    <option value="all">Band: any</option>
                    <option value="strong">Strong 86–100</option>
                    <option value="good">Good 71–85</option>
                    <option value="caution">Caution 51–70</option>
                    <option value="weak">Weak 31–50</option>
                    <option value="poor">Poor 0–30</option>
                    <option value="unknown">Unknown</option>
                  </select>
                  <input
                    className="rounded border p-2 text-sm"
                    type="number"
                    min={0}
                    max={100}
                    placeholder="Addr min"
                    value={vm.filters.addressConfidenceMin}
                    onChange={(e) => vm.setFilters((f) => ({ ...f, addressConfidenceMin: e.target.value }))}
                  />
                  <input
                    className="rounded border p-2 text-sm"
                    type="number"
                    min={0}
                    max={100}
                    placeholder="Addr max"
                    value={vm.filters.addressConfidenceMax}
                    onChange={(e) => vm.setFilters((f) => ({ ...f, addressConfidenceMax: e.target.value }))}
                  />
                  <p className="col-span-2 flex items-center text-[11px] text-slate-600 lg:col-span-2">
                    <span title={ADDRESS_CONFIDENCE_TOOLTIP} className="cursor-help border-b border-dotted border-slate-400">
                      What is address confidence?
                    </span>
                  </p>
                </div>

                <div className="max-h-[560px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="text-left text-xs text-slate-500">
                        <th className="p-2"><input type="checkbox" onChange={(e) => vm.setSelectedIds(e.target.checked ? vm.filtered.map((l) => l.id) : [])} /></th>
                        <th className="p-2">Lead</th><th className="p-2">Source</th><th className="p-2">Status</th>
                        <th className="p-2" title={ADDRESS_CONFIDENCE_TOOLTIP}>
                          Addr %
                        </th>
                        <th className="p-2">Readiness</th>
                        <th className="p-2">Score</th><th className="p-2">Tier</th><th className="p-2">Distance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...vm.filtered].sort((a, b) => b.score - a.score).map((lead) => (
                        <tr key={lead.id} className="border-t hover:bg-slate-50">
                          <td className="p-2"><input type="checkbox" checked={vm.selectedIds.includes(lead.id)} onChange={(e) => vm.setSelectedIds((ids) => e.target.checked ? [...ids, lead.id] : ids.filter((id) => id !== lead.id))} /></td>
                          <td className="p-2">
                            <p className="font-medium text-brand-ink">{lead.fullName}</p>
                            <p className="text-xs text-slate-500">{lead.company || lead.email}</p>
                          </td>
                          <td className="p-2">
                            <div className="flex flex-col gap-1">
                              <SourceBadge source={lead.source} />
                              {lead.enrichmentStatus === "enriched" && (
                                <span className="badge bg-amber-100 text-amber-900">Enriched</span>
                              )}
                            </div>
                          </td>
                          <td className="p-2"><StatusBadge status={lead.status} /></td>
                          <td className="p-2">
                            <AddressConfidenceBadge score={lead.addressConfidence} />
                          </td>
                          <td className="p-2 text-[11px] text-slate-700">
                            <span
                              className={
                                outreachReadiness(lead).tier === "ready"
                                  ? "text-emerald-800"
                                  : outreachReadiness(lead).tier === "caution"
                                    ? "text-amber-900"
                                    : "text-rose-800"
                              }
                            >
                              {outreachReadiness(lead).label}
                            </span>
                          </td>
                          <td className="p-2 font-semibold">{lead.score}</td>
                          <td className="p-2">{lead.priorityTier}</td>
                          <td className="p-2">{lead.distanceMinutes} min</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {singleSelectedLead ? (
                  <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-brand-ink/90">
                    <p className="font-semibold text-brand-ink">Lead detail · {singleSelectedLead.fullName}</p>
                    <p className="mt-1 text-xs">
                      <strong>Outreach readiness:</strong> {outreachReadiness(singleSelectedLead).label} —{" "}
                      {outreachReadiness(singleSelectedLead).factors.join(" · ")}
                    </p>
                    <p className="mt-2 text-xs">
                      <strong>Confidence notes:</strong>{" "}
                      {singleSelectedLead.confidenceNotes?.trim() ? (
                        singleSelectedLead.confidenceNotes
                      ) : (
                        <span className="text-slate-500">None on file.</span>
                      )}
                    </p>
                  </div>
                ) : null}

                {lowAddressInSelection && !campaignIncludeBelow71 ? (
                  <div className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                    Selection includes leads with address confidence under {OUTREACH_ADDRESS_MIN_DEFAULT} or unknown scores. They are{" "}
                    <strong>excluded by default</strong>. Check <strong>Include &lt;71 addresses</strong> to allow them (very poor ≤{OUTREACH_ADDRESS_VERY_POOR_MAX}{" "}
                    also needs its checkbox).
                  </div>
                ) : null}
                {veryPoorInSelection && campaignIncludeBelow71 && !campaignIncludeVeryPoor ? (
                  <div className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                    Selection includes very poor addresses (≤{OUTREACH_ADDRESS_VERY_POOR_MAX}). Enable <strong>Include very poor addresses</strong> to send to those
                    rows.
                  </div>
                ) : null}
                {selectionNeedsLowAddressConfirm && !campaignConfirmLow ? (
                  <div className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-950">
                    Some selected leads have address confidence ≤50 or unknown. Check <strong>I confirm low / unknown address risk</strong> before launch.
                  </div>
                ) : null}

                <div className="mt-3 flex flex-col gap-2 border-t pt-3 sm:flex-row sm:flex-wrap sm:items-center">
                  <input className="rounded border p-2 text-sm" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} />
                  <label className="flex items-center gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={campaignIncludeBelow71}
                      onChange={(e) => setCampaignIncludeBelow71(e.target.checked)}
                    />
                    Include &lt;71 address scores (override default)
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={campaignIncludeVeryPoor}
                      onChange={(e) => setCampaignIncludeVeryPoor(e.target.checked)}
                    />
                    Include very poor addresses (≤10)
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-700">
                    <input type="checkbox" checked={campaignConfirmLow} onChange={(e) => setCampaignConfirmLow(e.target.checked)} />
                    I confirm low / unknown address risk (≤50)
                  </label>
                  <label className="flex items-center gap-2 text-xs text-amber-900">
                    <input
                      type="checkbox"
                      checked={campaignOverrideVerify}
                      onChange={(e) => setCampaignOverrideVerify(e.target.checked)}
                    />
                    Send to score ≥{DEPLOY_VERIFY_MIN_SCORE} without Verify approval (override)
                  </label>
                  {unapprovedHighScoreInSelection > 0 && !campaignOverrideVerify ? (
                    <p className="w-full text-xs text-amber-800">
                      {unapprovedHighScoreInSelection} selected lead(s) need <strong>Verify</strong> thumbs-up before send, or check the override above.
                    </p>
                  ) : null}
                  <button
                    onClick={async () => {
                      const data = await vm.launchCampaign(campaignName, launchAddressOpts);
                      if (data && "ok" in data && data.ok && data.result) {
                        const r = data.result;
                        window.alert(
                          `${r.dryRun ? "Dry run" : "Live send"} complete: ${r.sentCount} sent · limit skips ${r.skippedByLimit} · ` +
                            `addr policy ${r.skippedByAddressPolicy} · very poor ${r.skippedVeryPoor} · verify gate ${r.skippedByDeployVerify ?? 0} · DNC ${r.skippedDoNotContact}`
                        );
                      } else if (data && "ok" in data && !data.ok) {
                        window.alert((data as { error?: string }).error ?? "Launch blocked.");
                      }
                    }}
                    className="rounded bg-brand px-3 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-dark"
                  >
                    Launch Campaign ({vm.selectedIds.length})
                  </button>
                </div>

                {selectedLeads.length > 0 ? (
                  <div className="mt-3 rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                    <p className="font-semibold text-brand-ink">Campaign · address selection summary</p>
                    <p className="mt-1">
                      Bands: strong {campaignAddressPreview.bands.strong} · good {campaignAddressPreview.bands.good} · caution{" "}
                      {campaignAddressPreview.bands.caution} · weak {campaignAddressPreview.bands.weak} · poor {campaignAddressPreview.bands.poor} · unknown{" "}
                      {campaignAddressPreview.bands.unknown}
                    </p>
                    <p className="mt-1">
                      Excluded by default (need &lt;71 override): {campaignAddressPreview.excludedByDefault} · excluded very poor (≤10, need checkbox):{" "}
                      {campaignAddressPreview.excludedVeryPoor} · would send with current checkboxes: {campaignAddressPreview.wouldSendNow}{" "}
                      (includes Verify gate for score ≥{DEPLOY_VERIFY_MIN_SCORE})
                    </p>
                    {unapprovedHighScoreInSelection > 0 && !campaignOverrideVerify ? (
                      <p className="mt-1 text-amber-900">
                        Verify: {unapprovedHighScoreInSelection} selected high-score lead(s) not approved — they will be skipped unless you override.
                      </p>
                    ) : null}
                    <p className="mt-1 text-amber-900">
                      If launch includes scores ≤50 (or unknown), check the confirmation box ({campaignAddressPreview.needsConfirmEstimate} lead(s) may need
                      it).
                    </p>
                    {campaignAddressPreview.riskyWithNotes.length ? (
                      <div className="mt-2 border-t border-slate-100 pt-2">
                        <p className="font-medium text-brand-ink/90">Confidence notes (under {OUTREACH_ADDRESS_MIN_DEFAULT} or unknown)</p>
                        <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto">
                          {campaignAddressPreview.riskyWithNotes.map((x) => (
                            <li key={x.id}>
                              <span className="font-medium">{x.name}</span> ({x.score ?? "—"}) — {x.notes}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
                  <p className="font-semibold text-brand-ink">Launch preview — first-touch (up to 5 leads)</p>
                  <p className="mt-1 text-xs text-slate-600">
                    Copy is generated from <strong>lead type → classification</strong>. City appears only when <strong>address confidence ≥86</strong> or CRM
                    / enrichment location trust is high. Business score does not change wording.
                  </p>
                  <p className="mt-2 text-xs text-slate-700">Audience selected: {selectedLeads.length}</p>
                  {firstTouchLaunchSamples.length === 0 ? (
                    <p className="mt-2 text-xs text-amber-800">Select at least one lead to preview copy.</p>
                  ) : (
                    <ul className="mt-3 space-y-3">
                      {firstTouchLaunchSamples.map(({ lead, rendered }) => (
                        <li key={lead.id} className="rounded-lg border border-slate-200 bg-white p-3 text-xs">
                          <p className="font-medium text-brand-ink">
                            {lead.fullName} · <span className="capitalize text-slate-600">{lead.leadType.replace(/_/g, " ")}</span> ·{" "}
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
                              {rendered.classification}
                            </span>
                            {rendered.locationOmitted ? (
                              <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950">
                                location omitted
                              </span>
                            ) : null}{" "}
                            <span className="text-slate-500">{rendered.templateId}</span>
                          </p>
                          <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-brand-ink/90">
                            {rendered.body}
                          </pre>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                </div>
            </section>
          )}

          {activeView === "dashboard" && (
            <section className="card">
              <div className="mb-4 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                <p className="font-semibold text-brand-ink/90">
                  Address quality · verified {vm.addressMetrics.verified} · 71+ {vm.addressMetrics.good} · needs review (&lt;71){" "}
                  {vm.addressMetrics.low} · very poor (≤10) {vm.addressMetrics.veryPoor}
                </p>
                <p className="mt-1" title={ADDRESS_CONFIDENCE_TOOLTIP}>
                  First-touch location lines only when addr ≥ 86 or CRM/enrichment location trust is high.
                </p>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 border-b border-slate-100 pb-3">
                <button
                  type="button"
                  onClick={() => setDashboardTab("active")}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    dashboardTab === "active" ? "bg-brand text-brand-ink shadow" : "border border-stone-200 bg-white text-brand-ink/75 hover:bg-brand/10"
                  }`}
                >
                  Active leads
                  <span
                    className={`rounded-full px-1.5 py-0 text-[11px] ${dashboardTab === "active" ? "bg-brand-ink/15 text-brand-ink" : "bg-stone-200/80 text-brand-ink/70"}`}
                  >
                    {dashboardActiveLeads.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setDashboardTab("lost")}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    dashboardTab === "lost" ? "bg-brand text-brand-ink shadow" : "border border-stone-200 bg-white text-brand-ink/75 hover:bg-brand/10"
                  }`}
                >
                  Lost leads
                  <span
                    className={`rounded-full px-1.5 py-0 text-[11px] ${dashboardTab === "lost" ? "bg-brand-ink/15 text-brand-ink" : "bg-stone-200/80 text-brand-ink/70"}`}
                  >
                    {dashboardLostLeads.length}
                  </span>
                </button>
              </div>

              <div className="mt-4 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr className="text-left text-xs text-slate-500">
                      <th className="p-2">Lead</th>
                      <th className="p-2">Source</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">Last reply</th>
                      <th className="p-2">Meeting</th>
                      {dashboardTab === "active" ? <th className="whitespace-nowrap p-2">Actions</th> : null}
                      <th className="p-2">Score</th>
                      <th className="p-2">Tier</th>
                      <th className="p-2">Distance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDashboardRows.map((lead) => {
                      const replyIso = lastReplyAtIso(lead);
                      const mtg = meetingBookingSummary(lead);
                      return (
                        <tr
                          key={lead.id}
                          className="cursor-pointer border-t hover:bg-slate-50"
                          onClick={() => {
                            if (leadNeedsInboxReview(lead)) {
                              setInboxLeadId(lead.id);
                              setInboxTab("Needs Review");
                              setReviewEdit("");
                              setActiveView("inbox");
                            } else {
                              vm.setSelectedIds([lead.id]);
                              setActiveView("leads");
                            }
                          }}
                        >
                          <td className="p-2">
                            <p className="font-medium text-brand-ink">{lead.fullName}</p>
                            <p className="text-xs text-slate-500">{lead.company || lead.email}</p>
                          </td>
                          <td className="p-2">
                            <SourceBadge source={lead.source} />
                          </td>
                          <td className="p-2">
                            <StatusBadge status={lead.status} />
                          </td>
                          <td className="p-2 text-xs text-slate-700">
                            {replyIso ? (
                              <>
                                <span className="font-medium text-brand-ink">{formatRelativeAgo(replyIso)}</span>
                                <span className="mt-0.5 block text-[11px] text-slate-500">{new Date(replyIso).toLocaleString()}</span>
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="p-2 text-xs">
                            <span className="font-medium text-brand-ink/90">{mtg.label}</span>
                            {mtg.detail ? <span className="mt-0.5 block text-[11px] text-slate-600">{mtg.detail}</span> : null}
                          </td>
                          {dashboardTab === "active" ? (
                            <td className="p-2 align-middle" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                className="whitespace-nowrap rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-900 hover:bg-rose-100"
                                onClick={() => void vm.markNotInterestedClient(lead.id)}
                              >
                                Retire to lost
                              </button>
                            </td>
                          ) : null}
                          <td className="p-2 font-semibold">{lead.score}</td>
                          <td className="p-2">{lead.priorityTier}</td>
                          <td className="p-2">{lead.distanceMinutes} min</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!sortedDashboardRows.length && (
                  <p className="p-6 text-center text-sm text-slate-500">
                    {dashboardTab === "active"
                      ? "No active replies right now. Replies show here until you retire them to lost."
                      : "No lost leads yet. Use Retire to lost on an active lead to archive them here."}
                  </p>
                )}
              </div>
              <DashboardBookingsCalendar leads={vm.leads} />
            </section>
          )}

          {activeView === "campaigns" && <Phase3IntelligenceCard metrics={vm.phase3Metrics} />}
          {activeView === "campaigns" && (
            <section className="card mb-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-brand-ink">Email deployment log</h2>
                <div
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${
                    vm.outreachDryRun
                      ? "border-amber-300 bg-amber-50 text-amber-900"
                      : "border-rose-300 bg-rose-50 text-rose-900"
                  }`}
                >
                  {vm.outreachDryRun ? "DRY RUN (no sends)" : "LIVE SEND"}
                </div>
              </div>
              <p className="mt-1 text-xs text-slate-600">Each launch batch with recipient coverage where tracked.</p>
              <ul className="mt-3 divide-y divide-slate-100">
                {vm.campaigns.map((c) => {
                  const names = c.recipientNames ?? [];
                  const showNames = c.sentCount >= 1 && c.sentCount <= 5 && names.length > 0;
                  return (
                    <li key={c.id} className="py-3 text-sm">
                      <p className="font-medium text-brand-ink">{c.name}</p>
                      <p className="text-xs text-slate-600">
                        Sent: {c.sentCount} · Launched {new Date(c.launchedAt).toLocaleString()}
                      </p>
                      {showNames ? (
                        <p className="mt-1 text-xs text-slate-700">
                          Recipients: {names.slice(0, 5).join(", ")}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {!vm.campaigns.length ? <p className="text-sm text-slate-500">No deployments yet.</p> : null}
            </section>
          )}
          {activeView === "campaigns" && (
            <section className="mb-4">
              <CampaignSequenceTree
                bookingLinkDisplay={bookingLinkPreview}
                initialFollow1={campaignSequencePreview.followUp1}
                initialFollow2={campaignSequencePreview.followUp2}
                initialBooking={campaignSequencePreview.bookingReply}
                initialPricing={campaignSequencePreview.pricingReply}
                initialInfo={campaignSequencePreview.infoReply}
              />
            </section>
          )}
          {activeView === "campaigns" && (
            <section className="mt-4 grid grid-cols-3 gap-3">
              {[
                { title: "Conversion by Lead Type", rows: conversionBy("leadType") },
                { title: "Conversion by Source", rows: conversionBy("source") },
                { title: "Conversion by Priority Tier", rows: conversionBy("priorityTier") }
              ].map((group) => (
                <div key={group.title} className="card">
                  <p className="mb-2 font-semibold">{group.title}</p>
                  {group.rows.map(([k, v]) => (
                    <p key={k} className="text-sm">{k}: {v.booked}/{v.total}</p>
                  ))}
                </div>
              ))}
            </section>
          )}
          {activeView === "inbox" && (
            <section className="flex flex-col gap-4">
              <div className="card max-h-[220px] shrink-0 overflow-hidden shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-3 py-2">
                  <div>
                    <h2 className="text-base font-semibold text-brand-ink">Priority Inbox</h2>
                    <p className="text-[11px] text-slate-600">Scroll horizontally to scan threads; full review below.</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-3 py-2">
                  {INBOX_TABS.map((tab) => {
                    const n = inboxByTab[tab].length;
                    const active = inboxTab === tab;
                    return (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setInboxTab(tab)}
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition ${
                          active ? "bg-brand text-brand-ink shadow" : "border border-stone-200 bg-white text-brand-ink/75 hover:bg-brand/10"
                        }`}
                      >
                        {tab}
                        <span
                          className={`rounded-full px-1 py-0 text-[10px] ${active ? "bg-brand-ink/15 text-brand-ink" : "bg-stone-200/80 text-brand-ink/70"}`}
                        >
                          {n}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-2 overflow-x-auto px-3 py-2">
                  {inboxByTab[inboxTab].map((t) => {
                    const active = inboxLeadId === t.leadId;
                    return (
                      <button
                        key={`${t.leadId}-${t.inboundReplyId}`}
                        type="button"
                        onClick={() => {
                          setInboxLeadId(t.leadId);
                          setReviewEdit("");
                        }}
                        className={`min-w-[200px] max-w-[260px] shrink-0 rounded-lg border p-2.5 text-left transition ${
                          active ? "border-brand/50 bg-brand/10 ring-2 ring-brand/35" : "border-stone-200 bg-white hover:border-brand/35"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1">
                          <p className="text-xs font-semibold leading-tight text-brand-ink">{t.fullName}</p>
                          {t.needsReview ? <span className="shrink-0 rounded bg-orange-100 px-1 py-0 text-[9px] font-semibold text-orange-900">Review</span> : null}
                        </div>
                        <p className="mt-0.5 truncate text-[10px] text-slate-500">{t.email}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          <SourceBadge source={t.source as Lead["source"]} />
                          <StatusBadge status={t.status as Lead["status"]} />
                        </div>
                        <p className="mt-1.5 line-clamp-2 text-[10px] text-slate-600">{clip(t.inboundSnippet, 120)}</p>
                      </button>
                    );
                  })}
                  {!inboxByTab[inboxTab].length ? (
                    <div className="flex min-h-[100px] w-full items-center justify-center rounded border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-500">
                      No threads in this tab.
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="min-h-[min(70vh,720px)] flex-1">
                <InboxChatColumn
                  vm={vm}
                  inboxLead={inboxLead}
                  inboxLeadId={inboxLeadId}
                  latestBookingRecordFn={latestBookingRecord}
                  clip={clip}
                  reviewEdit={reviewEdit}
                  setReviewEdit={setReviewEdit}
                  className="flex h-full min-h-[480px] flex-col gap-3"
                />
              </div>

            </section>
          )}
          {activeView === "bookings" && (
            <section className="space-y-4">
              <div className="card flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-brand-ink">Bookings</h2>
                  <p className="text-xs text-slate-600">Pipeline state and calendar confirmations. Lead source stays visible for attribution.</p>
                </div>
                <p className="text-sm text-slate-700">
                  Cal link:{" "}
                  <span className="font-mono text-xs text-brand-ink">{vm.bookingLinkDisplay || appConfig.bookingLink}</span>
                </p>
              </div>
              <div className="space-y-4">
                <BookingsPageCalendar rows={bookingInviteList} onSelect={(row) => setBookingDetailPick(row)} />
                <details className="card">
                  <summary className="cursor-pointer text-sm font-semibold text-brand-ink/90">Declined / cancelled ({bookingInviteList.filter((r) => r.bucket === "closed").length})</summary>
                  <ul className="mt-3 divide-y divide-slate-100">
                    {bookingInviteList
                      .filter((r) => r.bucket === "closed")
                      .map(({ lead, b }, i) => (
                        <li key={`c-${lead.id}-${i}`} className="py-3 text-sm">
                          <p className="font-medium text-brand-ink">{lead.fullName}</p>
                          <p className="text-xs text-slate-500">{b.note || b.status}</p>
                          <p className="text-[11px] text-slate-500">{new Date(b.at).toLocaleString()}</p>
                        </li>
                      ))}
                  </ul>
                  {!bookingInviteList.some((r) => r.bucket === "closed") ? (
                    <p className="mt-2 text-sm text-slate-500">No closed invites.</p>
                  ) : null}
                </details>
                {!bookingInviteList.length ? (
                  <p className="card text-sm text-slate-500">No booking records yet. Send a booking invite or simulate confirmation from the Simulation tab.</p>
                ) : null}
              </div>
            </section>
          )}
          {activeView === "verify" && <VerifyWorkbench onRefresh={() => void vm.refresh()} />}
          {activeView === "simulation" && (
            <section className="space-y-4">
              <div className="card">
                <h2 className="text-lg font-semibold text-brand-ink">Simulation</h2>
                <p className="mt-1 text-xs text-slate-600">
                  Dev-only workflows: synthetic inbound messages, Cal booking confirmations, inbox seeding, and the tools below. Use a sandbox lead when possible.
                </p>
                <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-stretch">
                  <label className="block min-w-0 max-w-xl flex-1">
                    <span className="text-xs font-semibold text-slate-700">Target lead</span>
                    <select
                      className="mt-1 w-full rounded border border-slate-200 p-2 text-sm"
                      value={simulationLeadId ?? ""}
                      onChange={(e) => setSimulationLeadId(e.target.value || null)}
                    >
                      {[...vm.leads].sort((a, b) => b.score - a.score).map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.fullName} · score {l.score} · {l.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-slate-200 bg-slate-50/90 p-3">
                    <p className="text-xs font-semibold text-brand-ink/90">Suggested targets</p>
                    <p className="mt-1 text-[11px] text-slate-600">
                      Strong scores and not suppressed — quick picks for simulations.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {simulationSuggestedLeads.length ? (
                        simulationSuggestedLeads.map((l) => (
                          <button
                            key={l.id}
                            type="button"
                            onClick={() => setSimulationLeadId(l.id)}
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                              simulationLeadId === l.id
                                ? "border-brand bg-brand text-brand-ink shadow-sm"
                                : "border-slate-200 bg-white text-brand-ink/85 hover:border-brand/40"
                            }`}
                          >
                            {l.fullName.split(" ")[0] ?? l.fullName} · {l.score}
                          </button>
                        ))
                      ) : (
                        <span className="text-[11px] text-slate-500">No eligible leads.</span>
                      )}
                    </div>
                  </div>
                </div>
                {!vm.leads.length ? <p className="mt-2 text-sm text-slate-500">No leads loaded — import or seed data first.</p> : null}
              </div>

              <SimulationPanel
                leadId={simulationLeadId}
                onSimulateInbound={(sc) => simulationLeadId && void vm.simulateInbound(simulationLeadId, sc)}
                onSimulateBooking={() => simulationLeadId && void vm.simulateCalBookingConfirmation(simulationLeadId)}
              />

              <div className="card space-y-3">
                <p className="text-sm font-semibold text-brand-ink">Bulk &amp; fixtures</p>
                <button
                  type="button"
                  className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-brand-ink/90 shadow-sm hover:bg-slate-50"
                  onClick={() =>
                    void vm.seedInboxSamples().then((r) => {
                      if (r?.ok === false && r.error) window.alert(r.error);
                    })
                  }
                >
                  Seed inbox samples
                </button>
                <p className="text-xs text-slate-600">Runs POST /api/dev/seed-inbox-samples — one simulated inbound per scenario on top-scored leads.</p>
              </div>

              <div className="card space-y-4">
                <p className="text-sm font-semibold text-brand-ink">Cal webhook &amp; mock tools</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={isCalWebhookTesting || !simulationLeadId}
                    onClick={async () => {
                      const leadId = simulationLeadId;
                      if (!leadId) {
                        setCalWebhookTest("Pick a target lead first.");
                        return;
                      }
                      setIsCalWebhookTesting(true);
                      setCalWebhookTest("Testing Cal webhook...");
                      try {
                        const res = await vm.testCalWebhook(leadId);
                        if (!res.ok) {
                          setCalWebhookTest(`Webhook failed: ${(res.data as { error?: string })?.error ?? "unknown error"}`);
                          return;
                        }
                        const duplicate = Boolean((res.data as { duplicate?: boolean })?.duplicate);
                        setCalWebhookTest(duplicate ? "Webhook ok (lead already booked/confirmed)" : "Webhook ok (booking confirmed)");
                      } catch (e) {
                        setCalWebhookTest(`Webhook test error: ${String(e)}`);
                      } finally {
                        setIsCalWebhookTesting(false);
                      }
                    }}
                    className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                  >
                    {isCalWebhookTesting ? "Testing..." : "Cal webhook health"}
                  </button>
                  {calWebhookTest ? <span className="text-xs text-slate-600">{calWebhookTest}</span> : null}
                </div>
                <div>
                  <button
                    type="button"
                    disabled={!simulationLeadId}
                    className="rounded border border-slate-200 bg-white px-3 py-1.5 text-sm text-brand-ink/90 hover:bg-slate-50 disabled:opacity-50"
                    onClick={() => simulationLeadId && void vm.enrichLead(simulationLeadId)}
                  >
                    Mock enrich (selected lead)
                  </button>
                  <p className="mt-2 max-w-2xl text-[11px] text-slate-600">
                    Calls the same <code className="rounded bg-slate-100 px-0.5">POST /api/leads/[id]/enrich</code> path as production: OSM / geocode lookup, address
                    confidence refresh, and full lead rescoring (no new email activity).
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold text-brand-ink/90">Mock reply classifier</p>
                  <p className="mb-2 max-w-2xl text-[11px] text-slate-600">
                    Runs the production inbound classifier on pasted text and updates the selected lead (status, booking hints, timeline) — a dev shortcut with no real email.
                  </p>
                  <textarea
                    className="w-full max-w-2xl rounded border border-slate-200 p-2 text-sm"
                    rows={4}
                    value={simReplyDraft}
                    onChange={(e) => setSimReplyDraft(e.target.value)}
                    placeholder="Paste sample reply text to classify and apply to the selected lead"
                  />
                  <button
                    type="button"
                    className="mt-2 rounded bg-brand-inkLight px-3 py-2 text-sm text-white disabled:opacity-50"
                    disabled={!simulationLeadId}
                    onClick={() => simulationLeadId && void vm.applyMockReply(simulationLeadId, simReplyDraft)}
                  >
                    Classify &amp; apply
                  </button>
                </div>
              </div>

              <p className="text-[11px] text-slate-500">
                Production paths: inbound email <code className="rounded bg-slate-100 px-1">POST /api/webhooks/inbound-email</code> · Cal{" "}
                <code className="rounded bg-slate-100 px-1">POST /api/webhooks/cal-booking</code>
              </p>
            </section>
          )}

          {bookingDetailPick ? (
            <div
              className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4"
              role="presentation"
              onClick={() => setBookingDetailPick(null)}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="booking-detail-title"
                className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 id="booking-detail-title" className="text-lg font-semibold text-brand-ink">
                    {bookingDetailPick.lead.fullName}
                  </h3>
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                    onClick={() => setBookingDetailPick(null)}
                  >
                    Close
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-600">{bookingDetailPick.lead.email}</p>
                <p className="mt-3 text-sm">
                  <span className="font-medium text-brand-ink/90">Meeting summary</span>
                </p>
                <ul className="mt-2 space-y-2 text-sm text-slate-700">
                  <li>
                    <span className="text-slate-500">State: </span>
                    {bookingDetailPick.bucket === "waiting"
                      ? "Pending invite"
                      : bookingDetailPick.bucket === "accepted"
                        ? "Confirmed"
                        : "Declined / cancelled"}
                  </li>
                  {bookingDetailPick.b.meetingStart ? (
                    <li>
                      <span className="text-slate-500">Start: </span>
                      {new Date(bookingDetailPick.b.meetingStart).toLocaleString()}
                    </li>
                  ) : (
                    <li>
                      <span className="text-slate-500">Invite sent: </span>
                      {new Date(bookingDetailPick.b.at).toLocaleString()}
                    </li>
                  )}
                  {bookingDetailPick.b.meetingEnd ? (
                    <li>
                      <span className="text-slate-500">End: </span>
                      {new Date(bookingDetailPick.b.meetingEnd).toLocaleString()}
                    </li>
                  ) : null}
                  {bookingDetailPick.b.bookingLink ? (
                    <li className="break-all text-xs">
                      <span className="text-slate-500">Link: </span>
                      <a className="text-brand-ink underline" href={bookingDetailPick.b.bookingLink} target="_blank" rel="noopener noreferrer">
                        {clip(bookingDetailPick.b.bookingLink, 80)}
                      </a>
                    </li>
                  ) : null}
                  {bookingDetailPick.b.note?.trim() ? (
                    <li>
                      <span className="text-slate-500">Note: </span>
                      {bookingDetailPick.b.note}
                    </li>
                  ) : null}
                  <li className="text-xs text-slate-600">
                    Record status: {bookingDetailPick.b.status}
                    {bookingDetailPick.b.meetingStatus ? ` · ${bookingDetailPick.b.meetingStatus}` : ""}
                  </li>
                </ul>
              </div>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
