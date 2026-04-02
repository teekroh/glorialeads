"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { Lead } from "@/types/lead";
import {
  buildSearchQueryFromProfileDraft,
  leadToProfileDraft,
  profileDraftToApiPayload,
  type LeadProfileDraft
} from "@/lib/leadProfileDraft";
import { compareVerifyQueue } from "@/services/scoringService";
import {
  ADDRESS_CONFIDENCE_TOOLTIP,
  AddressConfidenceBadge
} from "@/components/ui/AddressConfidenceBadge";
import { SourceBadge } from "@/components/ui/SourceBadge";
import { LeadProfileForm } from "@/components/dashboard/LeadProfileForm";
import { useGloriaDialogs } from "@/components/ui/GloriaDialogs";

type QueueResponse = {
  leads: Lead[];
  stats: {
    pending: number;
    rejected: number;
    approvedHigh: number;
    minScore: number;
    loaded?: number;
    cappedAt?: number;
  };
};

type SearchResponse =
  | {
      ok: true;
      mode: "fallback";
      query: string;
      searchUrl: string;
      hint?: string;
      apiError?: string;
    }
  | {
      ok: true;
      mode: "cse";
      query: string;
      searchUrl: string;
      items: { title: string; link: string; snippet: string }[];
    };

export function VerifyWorkbench({ onRefresh }: { onRefresh: () => Promise<void> | void }) {
  const { alert: gloriaAlert } = useGloriaDialogs();
  const [queue, setQueue] = useState<Lead[]>([]);
  const [stats, setStats] = useState<QueueResponse["stats"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [slide, setSlide] = useState<"in" | "out">("in");
  const [searchPayload, setSearchPayload] = useState<SearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [editProfile, setEditProfile] = useState<LeadProfileDraft | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/verify/queue", { cache: "no-store" });
      const data = (await res.json()) as QueueResponse;
      const sorted = [...data.leads].sort(compareVerifyQueue);
      setQueue(sorted);
      setStats(data.stats);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const current = queue[0];
  const currentId = current?.id;

  useLayoutEffect(() => {
    const lead = queue[0];
    if (!lead) {
      setEditProfile(null);
      return;
    }
    setEditProfile(leadToProfileDraft(lead));
    // Only re-seed when the carousel advances to a different lead (not on every queue ref).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queue[0]?.id
  }, [queue[0]?.id]);

  const searchQueryString = useMemo(() => {
    if (!editProfile) return "";
    return buildSearchQueryFromProfileDraft(editProfile);
  }, [editProfile]);

  useEffect(() => {
    if (!currentId || !editProfile) {
      setSearchPayload(null);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      setSearchLoading(true);
      setSearchPayload(null);
      void fetch(`/api/verify/google-search?q=${encodeURIComponent(searchQueryString)}`, { signal: ac.signal })
        .then((r) => r.json())
        .then((data) => setSearchPayload(data as SearchResponse))
        .catch(() => setSearchPayload(null))
        .finally(() => setSearchLoading(false));
    }, 450);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [currentId, searchQueryString]);

  const openGoogle = useMemo(() => {
    return `https://www.google.com/search?q=${encodeURIComponent(searchQueryString)}&udm=50`;
  }, [searchQueryString]);

  const applyUnknownPenalty = async () => {
    if (!current || busy) return;
    setBusy(true);
    setSlide("out");
    await new Promise((r) => setTimeout(r, 180));
    try {
      const res = await fetch(`/api/leads/${current.id}/verify-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict: "unknown" })
      });
      if (!res.ok) {
        void gloriaAlert("Could not save uncertain verdict.", "Verify");
        setSlide("in");
        setBusy(false);
        return;
      }
      setQueue((prev) => prev.slice(1));
      setSlide("in");
      await onRefresh();
      await loadQueue();
    } finally {
      setBusy(false);
    }
  };

  const fireDecision = async (verdict: "approved" | "rejected") => {
    if (!current || !editProfile || busy) return;
    setBusy(true);
    setSlide("out");
    await new Promise((r) => setTimeout(r, 180));
    try {
      const res = await fetch(`/api/leads/${current.id}/verify-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict, profile: profileDraftToApiPayload(editProfile) })
      });
      if (res.status === 409) {
        void gloriaAlert("That email is already used by another lead.", "Verify");
        setSlide("in");
        return;
      }
      if (res.status === 400) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        const code = err.error;
        const msg =
          code === "invalid_email"
            ? "Enter a valid email or leave it empty."
            : code === "full_name_required"
              ? "Enter a name (at least a first name)."
              : code === "invalid_lead_type"
                ? "Invalid lead type."
                : "Could not save decision.";
        void gloriaAlert(msg, "Verify");
        setSlide("in");
        return;
      }
      if (!res.ok) {
        void gloriaAlert("Could not save decision.", "Verify");
        setSlide("in");
        return;
      }
      setQueue((prev) => prev.slice(1));
      setSlide("in");
      await onRefresh();
      await loadQueue();
    } finally {
      setBusy(false);
    }
  };

  if (loading && !queue.length) {
    return (
      <section className="card p-8 text-center text-slate-600">
        <p>Loading verify queue…</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-brand-ink">Pre-deploy verify</h2>
        <p className="mt-1 text-sm text-slate-600">
          <strong>Every</strong> lead must pass this check before you can include them in a campaign launch (green ✓ on the Leads table).{" "}
          <strong>Ready for first touch</strong> does not auto-send email. Reject bins bad fits. Uncertain applies a score penalty without rejecting. Edit the profile
          below; changes are saved when you choose <strong>Ready</strong> or <strong>Reject</strong>. Queue is sorted by <strong>date added</strong> (newest first), then score
          and lead type.
        </p>
        {stats ? (
          <>
            <p className="mt-2 text-xs text-slate-700">
              <strong>{stats.pending}</strong> pending · <strong className="text-rose-700">{stats.rejected}</strong> rejected (bin) ·{" "}
              <strong className="text-emerald-800">{stats.approvedHigh}</strong> approved for send
            </p>
            {stats.loaded !== undefined ? (
              <p className="mt-1 text-xs text-slate-600">
                Carousel: <strong>{stats.loaded}</strong> lead(s) loaded (newest first, then score).
                {stats.pending > stats.loaded && stats.cappedAt !== undefined ? (
                  <>
                    {" "}
                    <strong>{stats.pending - stats.loaded}</strong> more pending than fit in this load (cap {stats.cappedAt}).
                    Work through these, then <strong>Refresh queue</strong> when empty—or each approve/refetch adds the next top leads.
                  </>
                ) : stats.pending > 0 ? (
                  <> All <strong>{stats.pending}</strong> pending lead(s) are in this carousel.</>
                ) : null}
              </p>
            ) : null}
          </>
        ) : null}
      </header>

      {!current || !editProfile ? (
        <div className="card p-10 text-center">
          <p className="text-lg font-medium text-brand-ink/90">Queue empty</p>
          <p className="mt-2 text-sm text-slate-600">All leads are approved or rejected (none pending). New imports start unreviewed again.</p>
          <button
            type="button"
            className="mt-4 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-brand-ink/90 hover:bg-slate-50"
            onClick={() => void loadQueue()}
          >
            Refresh queue
          </button>
        </div>
      ) : (
        <>
          <div
            className={`grid gap-4 transition-all duration-200 ease-out lg:grid-cols-2 ${
              slide === "out" ? "translate-x-[-12px] opacity-40" : "translate-x-0 opacity-100"
            }`}
          >
            <article className="rounded-xl border-2 border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Lead profile</p>
              <div className="mt-4">
                <LeadProfileForm
                  value={editProfile}
                  onChange={setEditProfile}
                  hint="Edits below are written when you click Ready or Reject (not Unknown)."
                />
              </div>

              <div className="mt-6 space-y-2 border-t border-slate-100 pt-4 text-sm">
                <p>
                  <span className="text-slate-500">Date added</span>{" "}
                  <span className="font-medium">{new Date(current.createdAt).toLocaleString()}</span>
                </p>
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-500">Source</span> <SourceBadge source={current.source} />
                </p>
                <p>
                  <span className="text-slate-500">Score (rank)</span>{" "}
                  <span className="text-lg font-bold text-brand-ink">{current.score}</span>{" "}
                  <span className="text-slate-500">· {current.priorityTier}</span>
                  <span className="ml-1 text-[11px] text-slate-400">(refreshes after save if type/email changed)</span>
                </p>
                <p className="text-xs text-amber-900">
                  Campaign send: <strong>requires Ready for first touch</strong> on this screen first (all leads, any score).
                </p>
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-500" title={ADDRESS_CONFIDENCE_TOOLTIP}>
                    Addr %
                  </span>
                  <AddressConfidenceBadge score={current.addressConfidence} />
                </p>
                {current.confidenceNotes?.trim() ? (
                  <p className="rounded-lg bg-slate-50 p-2 text-xs text-brand-ink/90">
                    <span className="font-semibold">Confidence notes:</span> {current.confidenceNotes}
                  </p>
                ) : null}
              </div>
            </article>

            <article className="flex flex-col rounded-xl border-2 border-stone-200 bg-stone-50/60 p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-ink/80">Web search</p>
              <p className="mt-1 text-xs text-slate-600">
                Inline results use Google <strong>Custom Search</strong> (set <code className="rounded bg-white/80 px-1">GOOGLE_CSE_API_KEY</code> +{" "}
                <code className="rounded bg-white/80 px-1">GOOGLE_CSE_CX</code>). Otherwise open Google in a new tab.
              </p>
              <p className="mt-3 break-words rounded border border-stone-200 bg-white px-3 py-2 font-mono text-[11px] text-brand-ink/90">
                {searchQueryString}
              </p>
              <a
                href={openGoogle}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex w-fit items-center rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-dark"
              >
                Open in Google (AI mode) →
              </a>
              <div className="mt-4 min-h-[200px] flex-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 text-xs">
                {searchLoading ? (
                  <p className="text-slate-500">Loading results…</p>
                ) : searchPayload?.ok && searchPayload.mode === "fallback" ? (
                  <div className="space-y-2 text-slate-700">
                    <p>{searchPayload.hint}</p>
                    {searchPayload.apiError ? <p className="text-amber-800">API: {searchPayload.apiError}</p> : null}
                    <p>Use the button above to search in your browser.</p>
                  </div>
                ) : searchPayload?.ok && searchPayload.mode === "cse" ? (
                  <ul className="space-y-3">
                    {searchPayload.items.length === 0 ? (
                      <p className="text-slate-500">No results.</p>
                    ) : (
                      searchPayload.items.map((it, i) => (
                        <li key={`${it.link}-${i}`} className="border-b border-slate-100 pb-3 last:border-0">
                          <a href={it.link} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-ink hover:underline">
                            {it.title || it.link}
                          </a>
                          <p className="mt-1 text-[11px] leading-snug text-slate-600">{it.snippet}</p>
                        </li>
                      ))
                    )}
                  </ul>
                ) : (
                  <p className="text-slate-500">No search data.</p>
                )}
              </div>
            </article>
          </div>

          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              disabled={busy}
              onClick={() => void fireDecision("approved")}
              title="Outreach readiness: include in campaign audiences when you launch. No automatic email is sent from this action alone."
              className="flex min-w-[200px] items-center justify-center gap-2 rounded-xl border-2 border-emerald-600 bg-emerald-50 px-8 py-4 text-base font-semibold text-emerald-950 hover:bg-emerald-100 disabled:opacity-50"
            >
              <span className="text-2xl" aria-hidden>
                👍
              </span>
              Ready for first touch
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void applyUnknownPenalty()}
              className="flex min-w-[200px] items-center justify-center gap-2 rounded-xl border-2 border-brand/40 bg-brand/5 px-8 py-4 text-base font-semibold text-brand-ink hover:bg-brand/12 disabled:opacity-50"
              title="Not a full reject: applies a score penalty and leaves Verify unset so the lead can re-enter when score recovers. Does not save profile edits."
            >
              <span className="text-2xl" aria-hidden>
                ?
              </span>
              Unknown (−score)
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void fireDecision("rejected")}
              className="flex min-w-[200px] items-center justify-center gap-2 rounded-xl border-2 border-rose-500 bg-rose-50 px-8 py-4 text-base font-semibold text-rose-950 hover:bg-rose-100 disabled:opacity-50"
            >
              <span className="text-2xl" aria-hidden>
                👎
              </span>
              Reject (bad lead bin)
            </button>
          </div>

          <p className="text-center text-xs text-slate-500">
            {queue.length > 1 ? (
              <>
                <strong>{queue.length - 1}</strong> more after this in the carousel ·{" "}
                <strong>{stats?.pending ?? "—"}</strong> pending total (DB)
              </>
            ) : (
              <>
                Last in the loaded carousel · <strong>{stats?.pending ?? "—"}</strong> pending total (DB)
              </>
            )}
          </p>
        </>
      )}
    </section>
  );
}
