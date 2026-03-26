import Link from "next/link";
import { CALCOM_BOOKING_LINK_EXAMPLE, CALCOM_EVENT_DURATION_MIN, CALCOM_EVENT_NAME, CALCOM_EVENT_SLUG } from "@/config/calcomSetup";

export default function CalSetupPage() {
  return (
    <main className="mx-auto max-w-2xl p-8 text-slate-800">
      <p className="mb-2 text-sm text-slate-500">
        <Link href="/dashboard" className="text-brand underline">
          ← Dashboard
        </Link>
      </p>
      <h1 className="text-2xl font-semibold text-slate-900">Cal.com: Cabinet intro event</h1>
      <p className="mt-2 text-sm text-slate-600">
        Configure one event type for Gloria’s outbound + inbound booking funnel, then set <code className="rounded bg-slate-100 px-1">BOOKING_LINK</code> in{" "}
        <code className="rounded bg-slate-100 px-1">.env.local</code>.
      </p>
      <ol className="mt-6 list-decimal space-y-4 pl-5 text-sm">
        <li>
          <strong>Event name:</strong> {CALCOM_EVENT_NAME}
        </li>
        <li>
          <strong>Duration:</strong> {CALCOM_EVENT_DURATION_MIN} minutes
        </li>
        <li>
          <strong>URL slug:</strong> <code className="rounded bg-slate-100 px-1">{CALCOM_EVENT_SLUG}</code> → public URL looks like{" "}
          <code className="break-all rounded bg-slate-100 px-1">{CALCOM_BOOKING_LINK_EXAMPLE}</code>
        </li>
        <li>
          <strong>Location:</strong> Google Meet (connect Google Calendar in Cal.com; set location to Meet or your default video).
        </li>
        <li>
          <strong>Availability:</strong> Weekdays, reasonable hours (e.g. 9:00–17:00 in your timezone).
        </li>
        <li>
          <strong>Buffers:</strong> 5–10 minutes between meetings (Event type → Advanced).
        </li>
        <li>
          <strong>Minimum notice:</strong> 4–8 hours before a slot can be booked.
        </li>
        <li>
          <strong>Environment:</strong>
          <pre className="mt-2 overflow-x-auto rounded border border-slate-200 bg-slate-50 p-3 text-xs">
            {`BOOKING_LINK=${CALCOM_BOOKING_LINK_EXAMPLE}`}
            {`\n# Optional — same URL, for client-side previews:\nNEXT_PUBLIC_BOOKING_LINK=${CALCOM_BOOKING_LINK_EXAMPLE}`}
          </pre>
        </li>
        <li>
          <strong>Production webhook:</strong> In Cal.com, point webhooks to{" "}
          <code className="rounded bg-slate-100 px-1">POST /api/webhooks/cal-booking</code> on your deployed host. Confirmed bookings set the lead to <em>Booked</em> and
          append timeline <em>Booking confirmed</em>.
        </li>
      </ol>
      <p className="mt-8 text-xs text-slate-500">Technical notes live in <code className="rounded bg-slate-50 px-1">config/calcomSetup.ts</code> and <code className="rounded bg-slate-50 px-1">config/bookingCopy.ts</code>.</p>
    </main>
  );
}
