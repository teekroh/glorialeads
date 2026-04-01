"use client";

import { SIMULATED_SCENARIO_ORDER, type SimulatedScenario } from "@/services/inboundSimulation";

const SCENARIO_LABELS: Record<SimulatedScenario, string> = {
  positive: "Positive reply",
  asks_for_link: "Asks for calendar link",
  suggested_time: "Suggested time",
  pricing_question: "Pricing question",
  info_request: "Info request",
  objection: "Objection / chose another vendor",
  not_now: "Not now / circle back",
  unsubscribe: "Unsubscribe",
  unclear: "Unclear / low signal"
};

export function SimulationPanel({
  leadId,
  onSimulateInbound,
  onSimulateBooking,
  onDispatchScheduledDue
}: {
  leadId: string | null;
  onSimulateInbound: (scenario: SimulatedScenario) => void;
  onSimulateBooking: () => void;
  onDispatchScheduledDue?: () => void;
}) {
  const disabled = !leadId;

  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/80 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Simulated inbound</p>
      <p className="mt-1 text-xs text-slate-600">
        POST <code className="rounded bg-white px-0.5">/api/dev/simulate-inbound</code> with the selected lead. Uses the same classifier as production inbound.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {SIMULATED_SCENARIO_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => onSimulateInbound(key)}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {SCENARIO_LABELS[key]}
          </button>
        ))}
      </div>

      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Booking</p>
      <p className="mt-1 text-xs text-slate-600">
        Simulate Cal confirmation via <code className="rounded bg-white px-0.5">POST /api/webhooks/cal-booking</code> (same path as production).
      </p>
      <div className="mt-2">
        <button
          type="button"
          disabled={disabled}
          onClick={onSimulateBooking}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-ink transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          Simulate booking confirmation
        </button>
      </div>

      {onDispatchScheduledDue ? (
        <>
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Scheduled follow-ups</p>
          <p className="mt-1 text-xs text-slate-600">
            Sends any due <code className="rounded bg-white px-0.5">follow_up_1/2</code> messages (regenerates copy with Claude when
            configured). Production uses Vercel cron <code className="rounded bg-white px-0.5">/api/cron/outreach-dispatch</code>.
          </p>
          <div className="mt-2">
            <button
              type="button"
              onClick={onDispatchScheduledDue}
              className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-950 hover:bg-violet-100"
            >
              Run due scheduled sends now (dev)
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
