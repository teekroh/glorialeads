import { NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/apiRouteSecurity";
import { setOutreachDryRunOverride } from "@/services/outreachDryRunService";

/**
 * Dashboard dry-run override (persisted in DB). Requires admin API key.
 * Turning live from the UI always applies — no extra env escape hatches.
 * Optional: OUTREACH_TEST_TO still redirects all Resend To: when set (separate safety rail).
 */
export async function POST(request: Request) {
  const authErr = requireAdminApiKey(request);
  if (authErr) return authErr;

  const body = await request.json().catch(() => ({}));

  if (body.clearOverride === true) {
    await setOutreachDryRunOverride(null);
    return NextResponse.json({ ok: true });
  }

  const mode = body.mode;
  if (mode === "dry") {
    await setOutreachDryRunOverride(true);
    return NextResponse.json({ ok: true });
  }

  if (mode === "live") {
    await setOutreachDryRunOverride(false);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { ok: false, error: "Invalid body: { mode: 'dry' | 'live' } or { clearOverride: true }" },
    { status: 400 }
  );
}
