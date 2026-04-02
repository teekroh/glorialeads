"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { VOICE_TRAIN_SCENARIOS, type VoiceTrainScenarioKind } from "@/config/voiceTrainScenarios";
import type { VoiceTrainingNoteDTO } from "@/services/voiceTrainingStorage";
import type { Lead } from "@/types/lead";
import { compareLeadsByPipelinePriority } from "@/services/scoringService";

const SCENARIO_LABELS: Record<VoiceTrainScenarioKind, string> = {
  first_touch: "Cold first touch",
  follow_up_1: "Follow-up #1",
  follow_up_2: "Final follow-up",
  reply_pricing: "Reply — pricing question",
  reply_info: "Reply — process / info",
  reply_unclear: "Reply — vague / TBC",
  booking_invite: "Reply — book a call"
};

export function VoiceTrainTab({
  leads,
  notes,
  onRefresh,
  generateMock,
  saveNote
}: {
  leads: Lead[];
  notes: VoiceTrainingNoteDTO[];
  onRefresh: () => Promise<void>;
  generateMock: (kind: VoiceTrainScenarioKind, leadId: string) => Promise<{ ok: boolean; mock?: string; error?: string }>;
  saveNote: (input: {
    scenarioKind: string;
    mockClaudeReply: string;
    userCorrection: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [scenario, setScenario] = useState<VoiceTrainScenarioKind>("first_touch");
  const [mock, setMock] = useState("");
  const [correction, setCorrection] = useState("");
  const [busy, setBusy] = useState<"gen" | "save" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Top-scoring leads that are not suppressed (same idea as “best” for outreach). */
  const trainLeadOptions = useMemo(
    () =>
      [...leads]
        .filter((l) => !l.doNotContact)
        .sort(compareLeadsByPipelinePriority)
        .slice(0, 80),
    [leads]
  );

  const [selectedLeadId, setSelectedLeadId] = useState<string>("");

  useEffect(() => {
    setSelectedLeadId((prev) => {
      if (prev && trainLeadOptions.some((l) => l.id === prev)) return prev;
      return trainLeadOptions[0]?.id ?? "";
    });
  }, [trainLeadOptions]);

  const scenarioOptions = useMemo(
    () => VOICE_TRAIN_SCENARIOS.map((k) => ({ value: k, label: SCENARIO_LABELS[k] })),
    []
  );

  const onGenerate = useCallback(async () => {
    setBusy("gen");
    setNotice(null);
    const r = await generateMock(scenario, selectedLeadId);
    setBusy(null);
    if (r.ok && r.mock) {
      setMock(r.mock);
      setNotice(null);
    } else {
      setNotice(r.error ?? "Could not generate (check ANTHROPIC_API_KEY and production admin key).");
    }
  }, [generateMock, scenario, selectedLeadId]);

  const onSave = useCallback(async () => {
    setBusy("save");
    setNotice(null);
    const r = await saveNote({
      scenarioKind: scenario,
      mockClaudeReply: mock,
      userCorrection: correction
    });
    setBusy(null);
    if (r.ok) {
      setNotice("Saved. Future Claude sends will see this correction in context.");
      setCorrection("");
      await onRefresh();
    } else {
      setNotice(r.error ?? "Save failed.");
    }
  }, [correction, mock, onRefresh, saveNote, scenario]);

  return (
    <section className="space-y-4">
      <div className="card space-y-2">
        <h2 className="text-lg font-semibold text-brand-ink">Train voice</h2>
        <p className="text-sm text-slate-600">
          Pick one of your highest-scoring leads (not on DNC) so the mock uses real CRM fields. Generate sample copy for a scenario, then note what you
          would do differently. Saved notes are appended to Claude&apos;s system prompt on real outbound and inbound drafts (most recent first).
        </p>
      </div>

      <div className="card grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <label className="block text-sm font-medium text-brand-ink" htmlFor="train-lead">
            CRM lead for mock (top {trainLeadOptions.length} by score, excluding DNC)
          </label>
          <select
            id="train-lead"
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
            value={selectedLeadId}
            onChange={(e) => {
              setSelectedLeadId(e.target.value);
              setNotice(null);
            }}
          >
            {trainLeadOptions.length === 0 ? (
              <option value="">No eligible leads — built-in sample only</option>
            ) : (
              <>
                {trainLeadOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.fullName} · score {l.score} · {l.city}, {l.state} · {l.leadType}
                  </option>
                ))}
                <option value="">— Built-in sample (not in your DB) —</option>
              </>
            )}
          </select>
          <button
            type="button"
            disabled={trainLeadOptions.length === 0}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-brand-ink hover:bg-slate-50 disabled:opacity-50"
            onClick={() => {
              const pool = trainLeadOptions.filter((l) => l.id);
              if (!pool.length) return;
              const pick = pool[Math.floor(Math.random() * pool.length)]!;
              setSelectedLeadId(pick.id);
              setNotice(null);
            }}
          >
            Random CRM lead
          </button>
          <label className="block text-sm font-medium text-brand-ink" htmlFor="train-scenario">
            Scenario
          </label>
          <select
            id="train-scenario"
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
            value={scenario}
            onChange={(e) => {
              setScenario(e.target.value as VoiceTrainScenarioKind);
              setNotice(null);
            }}
          >
            {scenarioOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy === "gen"}
            className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-dark disabled:opacity-50"
            onClick={() => void onGenerate()}
          >
            {busy === "gen" ? "Generating…" : "Generate mock reply"}
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-brand-ink">Mock Claude reply</p>
          <textarea
            className="min-h-[180px] w-full rounded border border-slate-300 bg-white p-2 text-sm text-brand-ink"
            placeholder="Click “Generate mock reply” or paste a draft here."
            value={mock}
            onChange={(e) => setMock(e.target.value)}
            rows={8}
          />
        </div>
      </div>

      <div className="card space-y-2">
        <label className="block text-sm font-medium text-brand-ink" htmlFor="train-correction">
          What you would do differently
        </label>
        <textarea
          id="train-correction"
          className="min-h-[120px] w-full rounded border border-slate-300 bg-white p-2 text-sm"
          placeholder="Tone, length, specificity, CTA, phrasing you prefer instead…"
          value={correction}
          onChange={(e) => setCorrection(e.target.value)}
          rows={5}
        />
        <button
          type="button"
          disabled={busy === "save" || !mock.trim() || !correction.trim()}
          className="rounded-md border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-950 hover:bg-violet-100 disabled:opacity-50"
          onClick={() => void onSave()}
        >
          {busy === "save" ? "Saving…" : "Save correction"}
        </button>
        {notice ? <p className="text-sm text-slate-700">{notice}</p> : null}
      </div>

      <div className="card">
        <h3 className="mb-2 text-sm font-semibold text-brand-ink">Saved corrections ({notes.length})</h3>
        {!notes.length ? (
          <p className="text-sm text-slate-500">No notes yet.</p>
        ) : (
          <ul className="max-h-[420px] space-y-3 overflow-y-auto text-sm">
            {notes.map((n) => (
              <li key={n.id} className="rounded border border-slate-200 bg-slate-50/80 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  {SCENARIO_LABELS[n.scenarioKind as VoiceTrainScenarioKind] ?? n.scenarioKind} ·{" "}
                  {new Date(n.createdAt).toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  <span className="font-semibold text-slate-700">Mock: </span>
                  <span className="whitespace-pre-wrap">{n.mockClaudeReply}</span>
                </p>
                <p className="mt-1 text-xs text-slate-800">
                  <span className="font-semibold">Prefer: </span>
                  <span className="whitespace-pre-wrap">{n.userCorrection}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
