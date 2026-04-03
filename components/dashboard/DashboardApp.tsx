"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type Dispatch,
  type SetStateAction
} from "react";
import { appConfig } from "@/config/appConfig";
import { ImportSummary } from "@/data/importLeads";
import type { DashboardNotificationDTO } from "@/services/dashboardNotificationService";
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
import { isEligibleForCampaignSend } from "@/services/deployVerifyPolicy";
import type { InboxThread, Phase3Metrics } from "@/services/dashboardAggregation";
import { Campaign } from "@/types/campaign";
import type { LeadType } from "@/types/lead";
import { Lead } from "@/types/lead";
import { CampaignSequenceTree } from "@/components/dashboard/CampaignSequenceTree";
import { SimulationPanel } from "@/components/dashboard/SimulationPanel";
import { VoiceTrainTab } from "@/components/dashboard/VoiceTrainTab";
import type { VoiceTrainingNoteDTO } from "@/services/voiceTrainingStorage";
import { VerifyWorkbench } from "@/components/dashboard/VerifyWorkbench";
import { LeadProfileForm } from "@/components/dashboard/LeadProfileForm";
import { leadToProfileDraft, profileDraftToApiPayload, type LeadProfileDraft } from "@/lib/leadProfileDraft";
import { compareLeadsForLibrary } from "@/services/scoringService";
import { AutomationAuditBadges } from "@/components/ui/HandlingBadge";
import { SourceBadge } from "@/components/ui/SourceBadge";
import { BookingStatusBadge, StatusBadge } from "@/components/ui/StatusBadge";
import { GloriaDialogProvider, useGloriaDialogs } from "@/components/ui/GloriaDialogs";

/** Lead library ✓ colors: yellow = verify-approved pool; green = first touch / in campaign. */
function leadLibraryVerifyCheck(lead: Lead): "green" | "yellow" | null {
  if (lead.outreachHistory.length > 0 || lead.status === "In Campaign") return "green";
  if (lead.deployVerifyVerdict === "approved") return "yellow";
  return null;
}

const MANUAL_LEAD_TYPES: LeadType[] = [
  "homeowner",
  "designer",
  "architect",
  "builder",
  "cabinet shop",
  "commercial builder"
];

const INBOX_TABS = ["Interested", "Booking Sent", "Needs Review", "Not Now", "Suppressed"] as const;

/** Sidebar order: Dashboard → Inbox → Train → Campaigns → Bookings → Leads → Verify → Simulation */
const SIDEBAR_VIEWS = ["dashboard", "inbox", "train", "campaigns", "bookings", "leads", "verify", "simulation"] as const;

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

function bookingRecordSortRank(b: Lead["bookingHistory"][number]): number {
  if (b.status === "booked" && (b.meetingStatus ?? "").toLowerCase() === "confirmed") return 3;
  if (b.status === "booked") return 2;
  if (b.status === "booking_sent") return 1;
  return 0;
}

/**
 * Calendar data only — never show invite-sent rows. Tentative slots and taken times live in Cal.com until we
 * persist a confirmed `booked` row with a real `meetingStart` (webhook/sync). Avoids misleading “pending” chips.
 */
function bookingHistoryForCalendarDisplay(lead: Lead): Lead["bookingHistory"] {
  const rows = lead.bookingHistory ?? [];
  return rows.filter((b) => b.status !== "booking_sent");
}

/** Prefer a confirmed Cal booking over an older “invite sent” row so the dashboard matches reality. */
function latestBookingRecord(lead: Lead | null | undefined) {
  if (!lead?.bookingHistory?.length) return null;
  return [...lead.bookingHistory].sort((a, b) => {
    const dr = bookingRecordSortRank(b) - bookingRecordSortRank(a);
    if (dr !== 0) return dr;
    const bt = new Date(b.bookedAt ?? b.at).getTime();
    const at = new Date(a.bookedAt ?? a.at).getTime();
    if (bt !== at) return bt - at;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  })[0];
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
    const out: {
      at: Date;
      leadName: string;
      status: string;
      b: BookingHistRow;
      bucket: ReturnType<typeof classifyBookingInvite>;
    }[] = [];
    for (const lead of leads) {
      for (const b of bookingHistoryForCalendarDisplay(lead)) {
        const anchor = bookingCalendarAnchor(b);
        if (!anchor) continue;
        out.push({
          at: anchor,
          leadName: lead.fullName,
          status: b.status || "—",
          b,
          bucket: classifyBookingInvite(lead, b)
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
            Confirmed meetings in Gloria only. Invite-sent / “pick a time” state stays on the lead row — availability is in Cal.com until we store a booked time.
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
                <p key={j} className="mt-1 text-[10px] text-slate-700 leading-tight" title={`${e.leadName} · ${e.status}`}>
                  <span className="font-semibold tabular-nums">{bookingChipSlotDisplay(e.b, e.at)}</span>
                  <span className="block truncate font-medium text-brand-ink/90">{e.leadName}</span>
                  <span className="block text-[9px] text-slate-600">{bookingChipStatusLabel(e.bucket)}</span>
                </p>
              ))}
              {cell.items.length > 2 ? <p className="text-[10px] text-slate-500">+{cell.items.length - 2} more</p> : null}
            </div>
          )
        )}
      </div>
      {!events.length ? (
        <p className="mt-3 text-sm text-slate-500">No confirmed meetings in {monthLabel}. Pending invites are not shown here.</p>
      ) : null}
    </section>
  );
}

function Phase3IntelligenceCard({ metrics }: { metrics: Phase3Metrics }) {
  return (
    <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
      <p className="mb-2 text-sm font-semibold text-brand-ink/90">Reply &amp; booking intelligence</p>
      <p className="mb-3 text-[11px] text-slate-600">Post–outreach funnel metrics (replies, invites, bookings). Not a campaign send step.</p>
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

function bookingChipSlotDisplay(b: BookingHistRow, anchor: Date): string {
  if (bookingHasScheduledStart(b)) {
    return new Date(b.meetingStart!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return anchor.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function bookingChipStatusLabel(bucket: ReturnType<typeof classifyBookingInvite>): string {
  if (bucket === "waiting") return "Meeting pending";
  if (bucket === "accepted") return "Confirmed";
  return "Cancelled";
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
            Confirmed times Gloria has recorded only — not pending invites (Cal.com reflects open vs taken slots). Click an entry for details.
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
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> Confirmed
            </span>
            <span className="ml-2 inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-slate-400" /> Closed
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
                    <span className="font-semibold tabular-nums">{bookingChipSlotDisplay(e.b, e.at)}</span>
                    <span className="truncate font-medium leading-tight">{e.lead.fullName}</span>
                    <span className="text-[9px] font-medium opacity-95">{bookingChipStatusLabel(e.bucket)}</span>
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
  selectedInboundReplyId,
  latestBookingRecordFn,
  clip,
  reviewEdit,
  setReviewEdit,
  className
}: {
  vm: ReturnType<typeof useDashboard>;
  inboxLead: Lead | null;
  inboxLeadId: string | null;
  selectedInboundReplyId: string | null;
  latestBookingRecordFn: typeof latestBookingRecord;
  clip: (s: string, n: number) => string;
  reviewEdit: string;
  setReviewEdit: Dispatch<SetStateAction<string>>;
  className?: string;
}) {
  const selectedThread = useMemo(() => {
    if (!inboxLeadId) return null;
    const forLead = vm.inboxThreads.filter((t) => t.leadId === inboxLeadId);
    if (!forLead.length) return null;
    if (selectedInboundReplyId) {
      return forLead.find((t) => t.inboundReplyId === selectedInboundReplyId) ?? forLead[0] ?? null;
    }
    return forLead[0] ?? null;
  }, [inboxLeadId, selectedInboundReplyId, vm.inboxThreads]);

  const multiThreadCount = useMemo(() => {
    if (!inboxLeadId) return 0;
    return vm.inboxThreads.filter((t) => t.leadId === inboxLeadId).length;
  }, [inboxLeadId, vm.inboxThreads]);

  const showReplyEditor =
    Boolean(selectedThread?.needsReview) || Boolean((selectedThread?.suggestedReplyDraft ?? "").trim());

  return (
    <div className={className ?? "flex min-h-0 flex-1 flex-col gap-3 space-y-0"}>
      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <h3 className="mb-1 shrink-0 font-semibold text-brand-ink">Chat history</h3>
        {multiThreadCount > 1 ? (
          <p className="mb-2 rounded border border-amber-200/80 bg-amber-50/90 px-2 py-1.5 text-[10px] text-amber-950">
            This lead has <strong>{multiThreadCount}</strong> inbox threads. The highlighted card above is the inbound message you are replying to; buttons use{" "}
            <strong>that</strong> thread only.
          </p>
        ) : null}
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
                  <p className="mt-1 max-h-[min(40vh,22rem)] overflow-y-auto text-xs text-slate-700 whitespace-pre-wrap">
                    {selectedThread.lastOutboundBody}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-slate-700">Their reply (last inbound)</p>
                  <p className="mt-1 max-h-[min(40vh,22rem)] overflow-y-auto text-xs text-slate-700 whitespace-pre-wrap">
                    {selectedThread.inboundBody}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-200/80 pt-2">
                  <span className="rounded-md bg-stone-100 px-2 py-0.5 text-[11px] font-medium capitalize text-brand-ink">
                    {selectedThread.classification.replace(/_/g, " ")}
                  </span>
                  <span className="text-[11px] text-slate-600">{(selectedThread.confidence * 100).toFixed(0)}% model confidence</span>
                </div>
                <p className="text-[11px] text-slate-600">Next step: {selectedThread.recommendedNext}</p>

                {showReplyEditor ? (
                  <div className="mt-2 border-t border-slate-200/80 pt-2">
                    <p className="text-[11px] font-semibold text-slate-700">Automated reply</p>
                    <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
                      Draft for <span className="font-medium capitalize">{selectedThread.classification.replace(/_/g, " ")}</span>. Generated with Claude using your voice
                      guidelines and corrections from the <strong className="font-medium">Train</strong> tab. Edit before sending — this panel does not save training notes.
                    </p>
                    <textarea
                      className="mt-1.5 min-h-[100px] w-full rounded border border-slate-300 bg-white p-2 text-xs text-brand-ink"
                      rows={5}
                      value={reviewEdit || selectedThread.suggestedReplyDraft || ""}
                      onChange={(e) => setReviewEdit(e.target.value)}
                    />
                  </div>
                ) : null}
              </div>

              {showReplyEditor ? (
                <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col space-y-2 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm md:max-w-[min(100%,480px)] md:shrink-0">
                  {selectedThread.needsReview ? (
                    <>
                      <p className="font-medium text-orange-900">Review queue</p>
                      <AutomationAuditBadges
                        needsReview={selectedThread.needsReview}
                        automationAllowed={selectedThread.automationAllowed ?? false}
                        automationBlockedReason={selectedThread.automationBlockedReason}
                        mixedIntent={selectedThread.mixedIntent}
                      />
                      <p className="text-[11px] text-slate-700">{selectedThread.classificationReason}</p>
                    </>
                  ) : (
                    <p className="text-[11px] text-slate-700">
                      This thread has a suggested draft. Edit on the left, then send or snooze here if needed.
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink hover:bg-brand-dark"
                      title="Sends the automated reply you edited on the left"
                      onClick={() => {
                        const text = (reviewEdit || selectedThread.suggestedReplyDraft || "").trim();
                        if (!text) return;
                        void vm.sendReviewReply(inboxLead.id, text, selectedThread.inboundReplyId);
                      }}
                    >
                      Send reply
                    </button>
                    <div className="flex flex-wrap items-center gap-1 border-l border-orange-200/80 pl-2">
                      <input
                        type="date"
                        className="rounded border px-2 py-1 text-xs"
                        title="Set follow-up date (moves lead to Not Now)"
                        onChange={(e) => e.target.value && void vm.snoozeLeadClient(inboxLead.id, new Date(e.target.value).toISOString())}
                      />
                      <span className="text-[10px] text-slate-600">Snooze follow-up</span>
                    </div>
                    <button
                      type="button"
                      title="Mark lead not interested and retire from active pipeline"
                      className="rounded-md border border-rose-200 px-3 py-1.5 text-xs text-rose-800"
                      onClick={() => void vm.markNotInterestedClient(inboxLead.id)}
                    >
                      Not interested
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-600">
                    Edit the message in the <strong>Automated reply</strong> panel on the left, then <strong>Send reply</strong> here.{" "}
                    <strong>Snooze</strong> only sets a follow-up reminder (lead moves toward &quot;Not Now&quot;); it does <strong>not</strong> schedule the email.{" "}
                    <strong>Not interested</strong> marks the lead as not interested and removes them from the active reply pipeline.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DashboardAppInner({
  initialLeads,
  initialCampaigns,
  initialInboxThreads,
  initialPhase3Metrics,
  initialBookingLinkConfigured = true,
  initialBookingLinkDisplay = "",
  initialBookingReplyPreview = "",
  initialOutreachDryRun = true,
  initialOutreachDryRunEnvDefault,
  initialOutreachDryRunOverride = null,
  initialNotifications = [],
  initialVoiceTrainingNotes = [],
  initialOutreachTestToActive = false,
  initialAutoDailyFirstTouchEnabled = false,
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
  initialOutreachDryRunEnvDefault?: boolean;
  initialOutreachDryRunOverride?: boolean | null;
  initialNotifications?: DashboardNotificationDTO[];
  initialVoiceTrainingNotes?: VoiceTrainingNoteDTO[];
  initialOutreachTestToActive?: boolean;
  initialAutoDailyFirstTouchEnabled?: boolean;
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
    initialOutreachDryRun,
    initialOutreachDryRunEnvDefault ?? initialOutreachDryRun,
    initialOutreachDryRunOverride ?? null,
    initialNotifications,
    initialVoiceTrainingNotes,
    initialOutreachTestToActive,
    initialAutoDailyFirstTouchEnabled
  );

  const { alert: gloriaAlert, confirm: gloriaConfirm } = useGloriaDialogs();

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
  const [gcalSyncBusy, setGcalSyncBusy] = useState(false);
  const [gcalSyncMsg, setGcalSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!vm.leads.length) return;
    if (simulationLeadId && vm.leads.some((l) => l.id === simulationLeadId)) return;
    const top = [...vm.leads].sort(compareLeadsForLibrary)[0];
    setSimulationLeadId(top?.id ?? null);
  }, [vm.leads, simulationLeadId]);
  const [campaignName, setCampaignName] = useState("Kitchen Intro Sprint");
  const [campaignIncludeBelow71, setCampaignIncludeBelow71] = useState(false);
  const [campaignIncludeVeryPoor, setCampaignIncludeVeryPoor] = useState(false);
  const [campaignConfirmLow, setCampaignConfirmLow] = useState(false);
  const [campaignOverrideVerify, setCampaignOverrideVerify] = useState(false);
  const [activeView, setActiveView] = useState<(typeof SIDEBAR_VIEWS)[number]>("dashboard");
  const [dashboardTab, setDashboardTab] = useState<"active" | "in_campaign" | "lost">("active");
  const [bookingDetailPick, setBookingDetailPick] = useState<BookingInviteRow | null>(null);
  const [inboxLeadId, setInboxLeadId] = useState<string | null>(null);
  /** Which inbound message thread is active when one lead has multiple inbox rows. */
  const [inboxInboundReplyId, setInboxInboundReplyId] = useState<string | null>(null);
  const [inboxTab, setInboxTab] = useState<(typeof INBOX_TABS)[number]>("Needs Review");
  const [reviewEdit, setReviewEdit] = useState("");
  const [calWebhookTest, setCalWebhookTest] = useState<string | null>(null);
  const [isCalWebhookTesting, setIsCalWebhookTesting] = useState(false);
  const [addLeadOpen, setAddLeadOpen] = useState(false);
  const [addLeadBusy, setAddLeadBusy] = useState(false);
  const [libraryEditLeadId, setLibraryEditLeadId] = useState<string | null>(null);
  const [libraryEditDraft, setLibraryEditDraft] = useState<LeadProfileDraft | null>(null);
  const [libraryEditBusy, setLibraryEditBusy] = useState(false);
  const [assistantLine, setAssistantLine] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantReply, setAssistantReply] = useState<string | null>(null);
  const [placesDiscoverBusy, setPlacesDiscoverBusy] = useState(false);
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

  const inboxNeedsReviewCount = inboxByTab["Needs Review"].length;

  useEffect(() => {
    if (!inboxLeadId) {
      setInboxInboundReplyId(null);
      return;
    }
    const inTab = inboxByTab[inboxTab].filter((t) => t.leadId === inboxLeadId);
    if (!inTab.length) {
      setInboxInboundReplyId(null);
      return;
    }
    setInboxInboundReplyId((prev) => {
      if (prev && inTab.some((t) => t.inboundReplyId === prev)) return prev;
      const lead = vm.leads.find((l) => l.id === inboxLeadId);
      const prefer = lead?.latestInbound?.id;
      const pick = prefer ? inTab.find((t) => t.inboundReplyId === prefer) : undefined;
      return (pick ?? inTab[0])!.inboundReplyId;
    });
  }, [inboxLeadId, inboxTab, inboxByTab, vm.leads]);

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
  /** One template sample only (first selected lead) — avoids implying we preview every lead and never calls Claude in the browser. */
  const firstTouchLaunchSample = useMemo(() => {
    const lead = selectedLeads[0];
    if (!lead) return null;
    return { lead, rendered: renderFirstTouchForLead(lead, bookingLinkPreview) };
  }, [selectedLeads, bookingLinkPreview]);

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

  /** Leads without Verify ✓ (null or rejected) — rejected still cannot send even with override. */
  const unapprovedVerifyInSelection = useMemo(
    () => selectedLeads.filter((l) => l.deployVerifyVerdict !== "approved").length,
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
  const dashboardInCampaignLeads = useMemo(
    () => vm.leads.filter((l) => l.status === "In Campaign"),
    [vm.leads]
  );
  const dashboardRows =
    dashboardTab === "active"
      ? dashboardActiveLeads
      : dashboardTab === "in_campaign"
        ? dashboardInCampaignLeads
        : dashboardLostLeads;

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
    } else if (dashboardTab === "in_campaign") {
      rows.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.fullName.localeCompare(b.fullName);
      });
    } else {
      rows.sort((a, b) => {
        const ra = leadNeedsInboxReview(a) ? 0 : 1;
        const rb = leadNeedsInboxReview(b) ? 0 : 1;
        if (ra !== rb) return ra - rb;
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
      for (const b of bookingHistoryForCalendarDisplay(lead)) {
        rows.push({ lead, b, bucket: classifyBookingInvite(lead, b) });
      }
    }
    return rows;
  }, [vm.leads]);

  const simulationSuggestedLeads = useMemo(
    () =>
      [...vm.leads]
        .filter((l) => !l.doNotContact)
        .sort(compareLeadsForLibrary)
        .slice(0, 8),
    [vm.leads]
  );

  const runDashboardAssistant = useCallback(async () => {
    const msg = assistantLine.trim();
    if (!msg) return;
    setAssistantBusy(true);
    try {
      const context = {
        activeView,
        totalLeads: vm.metrics.totalLeads,
        qualifiedLeads: vm.metrics.qualifiedLeads,
        campaignsLaunched: vm.metrics.campaignsLaunched,
        replies: vm.metrics.replies,
        bookingLinkConfigured: vm.bookingLinkConfigured,
        outreachDryRun: vm.outreachDryRun
      };
      const data = await vm.askDashboardAssistant(msg, context);
      if (data.ok && data.mode === "lead_created") {
        setAssistantReply(data.summary ?? "Lead created — open Verify to review.");
        setAssistantLine("");
        await vm.refresh();
      } else if (data.ok && data.text) {
        setAssistantReply(data.text);
        setAssistantLine("");
      } else {
        setAssistantReply(
          data.error === "Unauthorized." || String(data.error ?? "").includes("Unauthorized")
            ? "Unauthorized — in production set NEXT_PUBLIC_ADMIN_API_KEY to match ADMIN_API_KEY."
            : data.error ?? "Request failed."
        );
      }
    } finally {
      setAssistantBusy(false);
    }
  }, [assistantLine, activeView, vm]);

  return (
    <div className="min-h-screen">
      <div className="grid min-h-screen grid-cols-[250px_1fr]">
        <aside className="sticky top-0 flex h-screen max-h-screen flex-col overflow-hidden border-r border-white/10 bg-brand-ink p-4 text-stone-100">
          <div className="mb-6 flex shrink-0 items-center justify-center gap-2 px-1">
            <img src="/gloria-logo.svg" alt="" className="h-11 w-auto shrink-0 max-w-[100px] opacity-95" aria-hidden />
            <span className="font-semibold tracking-tight text-xl text-stone-100">Gloria Leads</span>
          </div>
          <nav className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain text-sm">
            {SIDEBAR_VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setActiveView(v)}
                className={`relative block w-full rounded px-3 py-2 pr-9 text-left capitalize ${activeView === v ? "bg-brand font-medium text-brand-ink shadow-sm" : "text-stone-100 hover:bg-brand-inkLight"}`}
              >
                {v}
                {v === "inbox" && inboxNeedsReviewCount > 0 ? (
                  <span
                    className="absolute right-2 top-1/2 flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-full bg-orange-400 px-1 text-[10px] font-bold leading-none text-brand-ink"
                    aria-label={`${inboxNeedsReviewCount} in Needs Review`}
                  >
                    {inboxNeedsReviewCount > 99 ? "99+" : inboxNeedsReviewCount}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
          <div
            className="mt-4 shrink-0 border-t border-white/15 pt-3 text-[11px] text-stone-300"
            title={
              `${vm.outreachDryRun ? "Dry run — Resend does not deliver outreach." : "Live — Resend delivers real mail."} .env DRY_RUN default: ${vm.outreachDryRunEnvDefault ? "on" : "off"}.` +
              (vm.outreachDryRunOverride === null
                ? " Dashboard override: none."
                : vm.outreachDryRunOverride
                  ? " Dashboard override: force dry."
                  : " Dashboard override: force live.") +
              (vm.outreachTestToActive
                ? " OUTREACH_TEST_TO is on — outreach To: is your test inbox only."
                : "")
            }
          >
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                role="switch"
                aria-checked={vm.outreachDryRun}
                className="h-4 w-4 shrink-0 cursor-pointer accent-amber-400"
                checked={vm.outreachDryRun}
                disabled={vm.dryRunToggleBusy}
                onClick={(e) => {
                  if (vm.dryRunToggleBusy) return;
                  // Controlled checkbox + async confirm: if we let the browser uncheck first, `checked`
                  // stays true until the API returns and the UI looks "stuck". Block the uncheck, confirm, then POST.
                  if (vm.outreachDryRun) {
                    e.preventDefault();
                    void (async () => {
                      const ok = vm.outreachTestToActive
                        ? await gloriaConfirm(
                            "Resend will deliver real mail, but OUTREACH_TEST_TO is set — every outreach email goes only to that inbox (not to each lead’s address). Continue?",
                            "Turn off dry run?"
                          )
                        : await gloriaConfirm(
                            "Leads will receive actual messages at their own addresses via Resend. Continue?",
                            "Send real email?"
                          );
                      if (!ok) return;
                      const r = await vm.setOutreachDryRunMode("live");
                      if (!r.ok && (r.error || r.code)) {
                        void gloriaAlert(r.error ?? "Request failed.", "Dry run mode");
                      }
                    })();
                  }
                }}
                onChange={(e) => {
                  if (!e.target.checked) return;
                  void (async () => {
                    const r = await vm.setOutreachDryRunMode("dry");
                    if (!r.ok && (r.error || r.code)) {
                      void gloriaAlert(r.error ?? "Request failed.", "Dry run mode");
                    }
                  })();
                }}
              />
              <span className="font-medium text-stone-200">Dry run</span>
            </label>
            {vm.outreachDryRunOverride !== null ? (
              <button
                type="button"
                disabled={vm.dryRunToggleBusy}
                className="mt-2 w-full rounded border border-white/25 px-2 py-1 text-[10px] font-medium text-stone-200 hover:bg-brand-inkLight"
                onClick={() => void vm.setOutreachDryRunMode("env_default")}
              >
                Use .env only
              </button>
            ) : null}
            <div className="mt-3 border-t border-white/15 pt-3 text-[11px] text-stone-300">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-amber-400"
                  checked={vm.autoDailyFirstTouchEnabled}
                  disabled={vm.autoDailyFirstTouchBusy}
                  onChange={(e) => {
                    const on = e.target.checked;
                    void (async () => {
                      if (on) {
                        const ok = await gloriaConfirm(
                          "Each business day between 8:00 and 10:00 (BUSINESS_TIMEZONE / server), automatically launch one batch of first-touch emails for Verify-approved leads who have never received a first touch. Uses the same limits as manual launch (DAILY_SEND_LIMIT, CAMPAIGN_SEND_LIMIT, address floors, pacing). Respects dry run when it is on. Requires Vercel cron hitting /api/cron/auto-daily-first-touch with CRON_SECRET.",
                          "Enable morning auto-send?"
                        );
                        if (!ok) return;
                      } else {
                        const ok = await gloriaConfirm("Turn off automatic morning first-touch sends?", "Auto-send");
                        if (!ok) return;
                      }
                      const r = await vm.setAutoDailyFirstTouchMode(on);
                      if (!r.ok) {
                        void gloriaAlert(r.error ?? "Could not save setting.", "Auto-send");
                      }
                    })();
                  }}
                />
                <span>
                  <span className="font-medium text-stone-200">Auto morning send</span>
                  <span className="mt-0.5 block text-[10px] text-stone-400">
                    Verified pool only · never contacted · cron every 15m (runs inside 8–10 AM window only)
                  </span>
                </span>
              </label>
              <p className="mt-2 text-[10px] leading-snug text-stone-500">
                Gmail may file cold outreach under <strong className="text-stone-300">Promotions</strong> — improving domain auth (SPF/DKIM), reply-to, and
                content helps Primary placement; that is separate from this toggle.
              </p>
            </div>
          </div>
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
            <>
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
                        Creates a <strong>Manual</strong> source lead, recomputes fit score from distance / spend / type, and leaves <strong>Verify</strong> pending until
                        you approve in the Verify tab.
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
                                void gloriaAlert("A lead with this email already exists.", "Add lead");
                              } else {
                                void gloriaAlert(`Could not add lead: ${r.error}`, "Add lead");
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
                        <strong>Verify-approved</strong> leads first, then <strong>score</strong> (homeowners below trade types; designer → builder → architect).{" "}
                        <strong>Click a row</strong> to edit the same fields as Verify (saved on Save — Verify status unchanged). Filter, multi-select with checkboxes, preview
                        first-touch copy, and launch campaigns to the selected audience.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={`shrink-0 rounded-lg border px-4 py-2 text-sm font-medium ${
                          vm.filters.hideInCampaignAlready
                            ? "border-amber-400/80 bg-amber-50 text-amber-950"
                            : "border-slate-300 bg-white text-brand-ink hover:bg-slate-50"
                        }`}
                        onClick={() =>
                            vm.setFilters((f) => ({
                              ...f,
                              hideInCampaignAlready: !f.hideInCampaignAlready
                            }))
                          }
                        title="Hide leads whose status is already In Campaign"
                      >
                        {vm.filters.hideInCampaignAlready ? "Excluding in-campaign ✓" : "Exclude in-campaign"}
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-brand-ink hover:bg-slate-50"
                        onClick={exportData}
                      >
                        Export (includes source)
                      </button>
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
                      <button
                        type="button"
                        disabled={vm.selectedIds.length === 0}
                        className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={async () => {
                          if (vm.selectedIds.length === 0) {
                            void gloriaAlert("Select one or more leads in the table (checkboxes) before launching.", "Launch campaign");
                            return;
                          }
                          const data = await vm.launchCampaign(campaignName, launchAddressOpts);
                          if (data && "ok" in data && data.ok && data.result) {
                            const r = data.result;
                            void gloriaAlert(
                              `${r.dryRun ? "Dry run" : "Live send"} complete: ${r.sentCount} sent · limit skips ${r.skippedByLimit} · ` +
                                `addr policy ${r.skippedByAddressPolicy} · very poor ${r.skippedVeryPoor} · verify gate ${r.skippedByDeployVerify ?? 0} · DNC ${r.skippedDoNotContact}`,
                              "Campaign sent"
                            );
                          } else if (data && "ok" in data && !data.ok) {
                            void gloriaAlert((data as { error?: string }).error ?? "Launch blocked.", "Launch campaign");
                          }
                        }}
                      >
                        Launch campaign ({vm.selectedIds.length})
                      </button>
                    </div>
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
                        <th className="p-2">Lead</th>
                        <th className="p-2 whitespace-nowrap">Date added</th>
                        <th className="p-2">Source</th><th className="p-2">Status</th>
                        <th className="p-2" title={ADDRESS_CONFIDENCE_TOOLTIP}>
                          Addr %
                        </th>
                        <th className="p-2">Readiness</th>
                        <th className="p-2">Score</th><th className="p-2">Tier</th><th className="p-2">Distance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vm.filtered.map((lead) => {
                        const verifyMark = leadLibraryVerifyCheck(lead);
                        return (
                        <tr
                          key={lead.id}
                          className="cursor-pointer border-t hover:bg-slate-50"
                          onClick={() => {
                            setLibraryEditLeadId(lead.id);
                            setLibraryEditDraft(leadToProfileDraft(lead));
                          }}
                        >
                          <td className="p-2" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={vm.selectedIds.includes(lead.id)}
                              onChange={(e) =>
                                vm.setSelectedIds((ids) =>
                                  e.target.checked ? [...ids, lead.id] : ids.filter((id) => id !== lead.id)
                                )
                              }
                            />
                          </td>
                          <td className="p-2">
                            <p className="flex items-center gap-1.5 font-medium text-brand-ink">
                              {verifyMark === "green" ? (
                                <span
                                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold leading-none text-white"
                                  title="First touch sent or In Campaign — green verify / pipeline"
                                >
                                  ✓
                                </span>
                              ) : verifyMark === "yellow" ? (
                                <span
                                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-400 text-[11px] font-bold leading-none text-amber-950"
                                  title="Verify approved — not yet in campaign (auto-send or manual launch eligible)"
                                >
                                  ✓
                                </span>
                              ) : null}
                              <span>{lead.fullName}</span>
                            </p>
                            <p className="text-xs text-slate-500">{lead.company || lead.email}</p>
                          </td>
                          <td className="p-2 whitespace-nowrap text-xs text-slate-600">
                            {new Date(lead.createdAt).toLocaleString(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short"
                            })}
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
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {libraryEditLeadId && libraryEditDraft ? (
                  <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="library-edit-lead-title"
                    onClick={() => {
                      if (!libraryEditBusy) {
                        setLibraryEditLeadId(null);
                        setLibraryEditDraft(null);
                      }
                    }}
                  >
                    <div
                      className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <h3 id="library-edit-lead-title" className="text-lg font-semibold text-brand-ink">
                        Edit lead
                      </h3>
                      <p className="mt-1 text-xs text-slate-600">
                        Same fields as the Verify tab. Fit score recomputes from lead type and email. Library checkmarks:{" "}
                        <strong>yellow ✓</strong> = verify-approved, not sent yet; <strong>green ✓</strong> = first touch / In Campaign. Approve/reject only
                        in Verify.
                      </p>
                      <div className="mt-4">
                        <LeadProfileForm value={libraryEditDraft} onChange={setLibraryEditDraft} />
                      </div>
                      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4">
                        <button
                          type="button"
                          disabled={libraryEditBusy}
                          className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-900 hover:bg-rose-100 disabled:opacity-50"
                          onClick={async () => {
                            const id = libraryEditLeadId;
                            if (!id) return;
                            if (
                              !(await gloriaConfirm(
                                "Related messages, follow-ups, bookings, and campaign links are removed. This cannot be undone.",
                                "Delete this lead?"
                              ))
                            ) {
                              return;
                            }
                            setLibraryEditBusy(true);
                            try {
                              const r = await vm.deleteLeadClient(id);
                              if (!r.ok) {
                                void gloriaAlert(
                                  r.error === "Unauthorized." || String(r.error ?? "").includes("Unauthorized")
                                    ? "Unauthorized — in production set NEXT_PUBLIC_ADMIN_API_KEY to match ADMIN_API_KEY."
                                    : r.error ?? "Could not delete lead.",
                                  "Delete lead"
                                );
                                return;
                              }
                              setLibraryEditLeadId(null);
                              setLibraryEditDraft(null);
                              vm.setSelectedIds((sel) => sel.filter((x) => x !== id));
                            } finally {
                              setLibraryEditBusy(false);
                            }
                          }}
                        >
                          Delete lead
                        </button>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={libraryEditBusy}
                            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-brand-ink/90 hover:bg-slate-50 disabled:opacity-50"
                            onClick={() => {
                              if (!libraryEditBusy) {
                                setLibraryEditLeadId(null);
                                setLibraryEditDraft(null);
                              }
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={libraryEditBusy}
                            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-dark disabled:opacity-50"
                            onClick={async () => {
                              if (!libraryEditLeadId) return;
                              setLibraryEditBusy(true);
                              try {
                                const res = await fetch(`/api/leads/${libraryEditLeadId}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ profile: profileDraftToApiPayload(libraryEditDraft) })
                                });
                                if (res.status === 409) {
                                  void gloriaAlert("That email is already used by another lead.", "Save lead");
                                  return;
                                }
                                if (res.status === 400) {
                                  const err = (await res.json().catch(() => ({}))) as { error?: string };
                                  const code = err.error;
                                  void gloriaAlert(
                                    code === "invalid_email"
                                      ? "Enter a valid email or leave it empty."
                                      : code === "full_name_required"
                                        ? "Enter a name (at least a first name)."
                                        : code === "invalid_lead_type"
                                          ? "Invalid lead type."
                                          : code === "profile_required"
                                            ? "Invalid save request."
                                            : "Could not save lead.",
                                    "Save lead"
                                  );
                                  return;
                                }
                                if (!res.ok) {
                                  void gloriaAlert("Could not save lead.", "Save lead");
                                  return;
                                }
                                setLibraryEditLeadId(null);
                                setLibraryEditDraft(null);
                                await vm.refresh();
                              } finally {
                                setLibraryEditBusy(false);
                              }
                            }}
                          >
                            {libraryEditBusy ? "Saving…" : "Save"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

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
                    Skip Verify approval for all selected leads (dangerous)
                  </label>
                  {unapprovedVerifyInSelection > 0 && !campaignOverrideVerify ? (
                    <p className="w-full text-xs text-amber-800">
                      {unapprovedVerifyInSelection} selected lead(s) are not Verify-approved (no green ✓). Approve in the <strong>Verify</strong> tab, or use the
                      override above.
                    </p>
                  ) : null}
                  <p className="w-full text-[11px] text-slate-500">
                    Launch with the green <strong>Launch campaign</strong> button in the lead library header (campaign name and checkboxes here apply).
                  </p>
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
                      (every lead needs Verify ✓ before send unless you use the override)
                    </p>
                    {unapprovedVerifyInSelection > 0 && !campaignOverrideVerify ? (
                      <p className="mt-1 text-amber-900">
                        Verify: {unapprovedVerifyInSelection} selected lead(s) without green ✓ — they will be skipped unless you override.
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
                  <p className="font-semibold text-brand-ink">Launch preview — sample first-touch (template)</p>
                  <p className="mt-1 text-xs text-slate-600">
                    <strong>Each launched lead gets unique copy:</strong> template layers vary by lead; on the server, with{" "}
                    <code className="rounded bg-white/80 px-1">ANTHROPIC_API_KEY</code>, Claude rewrites each first-touch from that lead&apos;s CRM context.
                    This panel shows <strong>one template example</strong> only (first lead in your selection) — <strong>no Claude calls here</strong>, so
                    final sends can read differently per lead.
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    Template rules: <strong>lead type → classification</strong>; city only when <strong>address ≥86</strong> or high location trust. Score
                    does not change wording.
                  </p>
                  <p className="mt-2 text-xs text-slate-700">
                    Audience selected: {selectedLeads.length}
                    {selectedLeads.length > 1 ? (
                      <span className="text-slate-500"> · sample below is the first lead only; others are not pre-rendered.</span>
                    ) : null}
                  </p>
                  {!firstTouchLaunchSample ? (
                    <p className="mt-2 text-xs text-amber-800">Select at least one lead to see a template sample.</p>
                  ) : (
                    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-xs">
                      <p className="font-medium text-brand-ink">
                        {firstTouchLaunchSample.lead.fullName} ·{" "}
                        <span className="capitalize text-slate-600">{firstTouchLaunchSample.lead.leadType.replace(/_/g, " ")}</span> ·{" "}
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
                          {firstTouchLaunchSample.rendered.classification}
                        </span>
                        {firstTouchLaunchSample.rendered.locationOmitted ? (
                          <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950">
                            location omitted
                          </span>
                        ) : null}{" "}
                        <span className="text-slate-500">{firstTouchLaunchSample.rendered.templateId}</span>
                      </p>
                      <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-brand-ink/90">
                        {firstTouchLaunchSample.rendered.body}
                      </pre>
                    </div>
                  )}
                </div>
                </div>
            </section>

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
                    title="Apply matching filters to the lead library table above"
                    onClick={() => applyLeadStatFilter(filter)}
                  >
                    {inner}
                  </button>
                );
              })}
            </section>
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
            <section className="mb-4 card text-sm">
              <p className="font-semibold">CSV Import Summary</p>
              <p>
                File: <strong>resources/{importSummary.sourceFile}</strong> · Total rows: {importSummary.totalRows} | Valid rows:{" "}
                {importSummary.validRows} | Skipped: {importSummary.skippedRows} | Duplicates: {importSummary.duplicateRows}
              </p>
            </section>
            <section className="mb-4 rounded-xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-xs text-amber-950">
              <p className="font-semibold text-brand-ink/90">Web discovery (Google Places)</p>
              <p className="mt-1 text-[11px] leading-snug opacity-95">
                Creates up to <strong>5</strong> leads per run (<strong>Scraped / External</strong>) via Places Text Search —{" "}
                <strong>billed</strong> on your Google Cloud / Maps account (
                <a
                  className="font-medium text-brand-ink underline"
                  href="https://developers.google.com/maps/documentation/places/web-service/usage-and-billing"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  usage and billing
                </a>
                ). Needs <code className="rounded bg-white/80 px-1">GOOGLE_PLACES_API_KEY</code>, optional{" "}
                <code className="rounded bg-white/80 px-1">PLACES_DISCOVER_DEFAULT_QUERY</code>, and the same admin access as other dev tools.
              </p>
              <p className="mt-2 text-[11px] leading-snug text-slate-800">
                <strong className="text-brand-ink/90">No Places key?</strong> Use <strong>CSV import</strong>, <strong>Add lead</strong>, or{" "}
                <strong>Enrich</strong> on a row (OpenStreetMap / Nominatim geocode — free with a proper{" "}
                <code className="rounded bg-white/70 px-1">NOMINATIM_USER_AGENT</code>). Inline web results in Verify can use Google Custom Search (
                <code className="rounded bg-white/70 px-1">GOOGLE_CSE_*</code>, 100 queries/day free tier) if you add keys; otherwise use browser search there.
              </p>
              <button
                type="button"
                disabled={placesDiscoverBusy}
                className="mt-3 rounded-md bg-brand px-3 py-2 text-xs font-semibold text-brand-ink hover:bg-brand-dark disabled:opacity-50"
                onClick={() => {
                  setPlacesDiscoverBusy(true);
                  void vm
                    .placesDiscoverLeads({ limit: 5 })
                    .then((r) => {
                      if (!r.ok) {
                        void gloriaAlert(r.error ?? "Places discover failed.", "Places discover");
                        return;
                      }
                      void gloriaAlert(
                        `Created ${r.created ?? 0} lead(s), skipped ${r.skipped ?? 0}. Query: ${r.queryUsed ?? "—"}\n\n${(r.pricingNote ?? "").slice(0, 280)}${(r.pricingNote?.length ?? 0) > 280 ? "…" : ""}`,
                        "Places discover"
                      );
                    })
                    .finally(() => setPlacesDiscoverBusy(false));
                }}
              >
                {placesDiscoverBusy ? "Discovering…" : "Run Places discover (up to 5)"}
              </button>
            </section>
            </>
          )}

          {activeView === "dashboard" && (
            <section className="card">
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-stretch">
                <label className="min-w-0 flex-1 text-[11px] text-slate-600">
                  <span className="font-semibold text-brand-ink/90">Ask Gloria (Claude)</span>
                  <input
                    type="text"
                    value={assistantLine}
                    onChange={(e) => setAssistantLine(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void runDashboardAssistant();
                      }
                    }}
                    disabled={assistantBusy}
                    placeholder="Ask about this dashboard, or paste a designer/builder website URL to pull a contact into leads (Verify pending)"
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-brand-ink placeholder:text-slate-400 disabled:opacity-60"
                  />
                </label>
                <button
                  type="button"
                  disabled={assistantBusy || !assistantLine.trim()}
                  onClick={() => void runDashboardAssistant()}
                  className="shrink-0 self-end rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-dark disabled:opacity-50 sm:self-auto"
                >
                  {assistantBusy ? "…" : "Ask"}
                </button>
              </div>
              {assistantReply ? (
                <p className="mb-4 whitespace-pre-wrap rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2 text-xs text-brand-ink/90">
                  {assistantReply}
                </p>
              ) : null}
              <p className="mb-4 text-[10px] text-slate-500">
                Needs <code className="rounded bg-slate-100 px-1">ANTHROPIC_API_KEY</code>. URL-only lines merge the pasted URL with same-origin contact-style paths server-side (many sites block bots); if import
                fails, try Add lead manually. Production also needs matching <code className="rounded bg-slate-100 px-1">ADMIN_API_KEY</code> /{" "}
                <code className="rounded bg-slate-100 px-1">NEXT_PUBLIC_ADMIN_API_KEY</code>.
              </p>

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
                  onClick={() => setDashboardTab("in_campaign")}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    dashboardTab === "in_campaign"
                      ? "bg-brand text-brand-ink shadow"
                      : "border border-stone-200 bg-white text-brand-ink/75 hover:bg-brand/10"
                  }`}
                >
                  In campaign
                  <span
                    className={`rounded-full px-1.5 py-0 text-[11px] ${
                      dashboardTab === "in_campaign" ? "bg-brand-ink/15 text-brand-ink" : "bg-stone-200/80 text-brand-ink/70"
                    }`}
                  >
                    {dashboardInCampaignLeads.length}
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
                      {dashboardTab === "active" || dashboardTab === "in_campaign" ? (
                        <th className="whitespace-nowrap p-2">Actions</th>
                      ) : null}
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
                          className={`cursor-pointer border-t hover:bg-slate-50 ${
                            leadNeedsInboxReview(lead) ? "bg-amber-50/90 ring-1 ring-inset ring-amber-200/70" : ""
                          }`}
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
                          {dashboardTab === "active" || dashboardTab === "in_campaign" ? (
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
                      : dashboardTab === "in_campaign"
                        ? "No leads with status In Campaign. Launch a campaign from the Leads tab to move recipients here."
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
                  {vm.outreachDryRun
                    ? "DRY RUN (no sends)"
                    : vm.outreachTestToActive
                      ? "LIVE (To: OUTREACH_TEST_TO)"
                      : "LIVE SEND"}
                </div>
              </div>
              {vm.outreachTestToActive && !vm.outreachDryRun ? (
                <div className="mt-3 rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                  <p className="font-semibold">Test recipient mode is on</p>
                  <p className="mt-1">
                    <code className="rounded bg-white/90 px-1">OUTREACH_TEST_TO</code> redirects every Resend “To” to that address — leads never see mail at their own email.
                    To go <strong>live to each lead</strong>: open Vercel → Project → Settings → Environment Variables →{" "}
                    <strong>remove</strong> <code className="rounded bg-white/90 px-1">OUTREACH_TEST_TO</code> (or clear its value) → save →{" "}
                    <strong>Redeploy</strong>. Keep <code className="rounded bg-white/90 px-1">DRY_RUN=false</code> and the sidebar <strong>Dry run</strong> unchecked.
                  </p>
                </div>
              ) : null}
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
                    const active = inboxLeadId === t.leadId && inboxInboundReplyId === t.inboundReplyId;
                    return (
                      <button
                        key={`${t.leadId}-${t.inboundReplyId}`}
                        type="button"
                        onClick={() => {
                          setInboxLeadId(t.leadId);
                          setInboxInboundReplyId(t.inboundReplyId);
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
                        <p
                          className="mt-1.5 line-clamp-2 text-[10px] text-slate-600"
                          title="Last outbound email (not their reply)"
                        >
                          {clip(
                            t.lastOutboundBody && t.lastOutboundBody !== "—" ? t.lastOutboundBody : t.inboundBody,
                            120
                          )}
                        </p>
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
                  selectedInboundReplyId={inboxInboundReplyId}
                  latestBookingRecordFn={latestBookingRecord}
                  clip={clip}
                  reviewEdit={reviewEdit}
                  setReviewEdit={setReviewEdit}
                  className="flex h-full min-h-[480px] flex-col gap-3"
                />
              </div>

            </section>
          )}
          {activeView === "train" && (
            <VoiceTrainTab
              leads={vm.leads}
              notes={vm.voiceTrainingNotes}
              onRefresh={vm.refresh}
              generateMock={vm.generateVoiceTrainingMockClient}
              saveNote={vm.saveVoiceTrainingNoteClient}
            />
          )}
          {activeView === "bookings" && (
            <section className="space-y-4">
              <div className="card flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold text-brand-ink">Bookings</h2>
                  <p className="text-xs text-slate-600">Pipeline state and calendar confirmations. Lead source stays visible for attribution.</p>
                  {gcalSyncMsg ? (
                    <p className="mt-2 text-xs text-slate-700" role="status">
                      {gcalSyncMsg}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
                  <a
                    href={vm.bookingLinkDisplay || appConfig.bookingLink}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-brand-ink shadow-sm transition hover:border-brand/40"
                  >
                    Add booking
                  </a>
                  <button
                    type="button"
                    disabled={gcalSyncBusy}
                    onClick={async () => {
                      setGcalSyncMsg(null);
                      setGcalSyncBusy(true);
                      try {
                        const r = await vm.syncGoogleCalendarBookings();
                        if (r.ok) {
                          const skipped = r.skipped?.length ? ` · skipped: ${r.skipped.length}` : "";
                          setGcalSyncMsg(
                            `Google Calendar: ${r.markedBooked ?? 0} marked booked, ${r.updatedExisting ?? 0} times filled, ${r.eventsScanned ?? 0} events scanned.${skipped}`
                          );
                        } else {
                          setGcalSyncMsg(
                            r.error ??
                              (r.status === 401
                                ? "Unauthorized — set NEXT_PUBLIC_ADMIN_API_KEY to match ADMIN_API_KEY for this dashboard."
                                : `Sync failed (${r.status}).`)
                          );
                        }
                      } finally {
                        setGcalSyncBusy(false);
                      }
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-brand-ink shadow-sm transition hover:border-brand/40 disabled:opacity-60"
                  >
                    {gcalSyncBusy ? "Syncing…" : "Sync from Google Calendar"}
                  </button>
                  <p className="text-sm text-slate-700">
                    Cal link:{" "}
                    <span className="font-mono text-xs text-brand-ink">{vm.bookingLinkDisplay || appConfig.bookingLink}</span>
                  </p>
                </div>
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
                  <p className="card text-sm text-slate-500">
                    No confirmed or closed bookings in Gloria yet. Invite-only leads stay on the <strong>Leads</strong> / <strong>Dashboard</strong> rows — use Cal.com for who picked a slot until a webhook stores the time here.
                  </p>
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
                      {[...vm.leads].sort(compareLeadsForLibrary).map((l) => (
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
                onDispatchScheduledDue={() =>
                  void vm.dispatchScheduledDue(25).then((r) => {
                    void gloriaAlert(
                      `Dispatched: ${r.dispatched ?? 0} · skipped: ${r.skipped ?? 0}` +
                        ((r.errors?.length ? "\nErrors:\n" + r.errors.slice(0, 5).join("\n") : "") || ""),
                      "Scheduled due"
                    );
                  })
                }
              />

              <div className="card space-y-3">
                <p className="text-sm font-semibold text-brand-ink">Bulk &amp; fixtures</p>
                <button
                  type="button"
                  className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-brand-ink/90 shadow-sm hover:bg-slate-50"
                  onClick={() =>
                    void vm.seedInboxSamples().then((r) => {
                      if (r?.ok === false && r.error) void gloriaAlert(r.error, "Seed inbox");
                    })
                  }
                >
                  Seed inbox samples
                </button>
                <p className="text-xs text-slate-600">Runs POST /api/dev/seed-inbox-samples — one simulated inbound per scenario on top-scored leads.</p>
                <button
                  type="button"
                  className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-950 hover:bg-rose-100"
                  onClick={() => {
                    void (async () => {
                      if (
                        !(await gloriaConfirm(
                          "Deletes all messages, campaigns, inbound replies, follow-ups, bookings, and notifications; resets every lead to New with Verify cleared (DNC and scores kept).",
                          "Clean slate?"
                        ))
                      ) {
                        return;
                      }
                      const r = await vm.cleanSlateOutreach();
                      if (!r?.ok) {
                        void gloriaAlert(
                          (r as { error?: string })?.error ?? "Clean slate failed (check ALLOW_DEV_ROUTES + admin key).",
                          "Clean slate"
                        );
                        return;
                      }
                      void gloriaAlert(
                        `Leads reset: ${r.leadsReset ?? "?"}. Deleted: ${JSON.stringify(r.deleted ?? {})}`,
                        "Clean slate done"
                      );
                    })();
                  }}
                >
                  Clean slate (outreach data)
                </button>
                <p className="text-xs text-slate-600">
                  POST /api/dev/clean-slate — requires <code className="rounded bg-white/80 px-1">ALLOW_DEV_ROUTES</code> and admin key. Use before a fresh send pass.
                </p>
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

export function DashboardApp(props: ComponentProps<typeof DashboardAppInner>) {
  return (
    <GloriaDialogProvider>
      <DashboardAppInner {...props} />
    </GloriaDialogProvider>
  );
}
