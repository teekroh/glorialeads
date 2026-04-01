import { NextResponse } from "next/server";
import { outreachConfig } from "@/config/outreachConfig";
import { requireAdminApiKey } from "@/lib/apiRouteSecurity";
import { outreachDryRunFromEnv, setOutreachDryRunOverride } from "@/services/outreachDryRunService";

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function allowDashboardLiveWhenEnvDry() {
  return String(process.env.ALLOW_DASHBOARD_LIVE_SEND ?? "").toLowerCase() === "true";
}

/** When set, all `sendOutreachEmail` Resend deliveries use this To — safe to allow dashboard live without blasting lead inboxes. */
function outreachTestInboxConfigured() {
  return Boolean(outreachConfig.testToEmail);
}

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
    const canLiveFromDashboard =
      allowDashboardLiveWhenEnvDry() || outreachTestInboxConfigured();
    if (isProduction() && outreachDryRunFromEnv() && !canLiveFromDashboard) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Production safety: .env has DRY_RUN on. To turn off dry run from the dashboard, set OUTREACH_TEST_TO to your inbox (all outreach Resend To: is redirected there), or set ALLOW_DASHBOARD_LIVE_SEND=true, or set DRY_RUN=false in the host environment."
        },
        { status: 403 }
      );
    }
    await setOutreachDryRunOverride(false);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { ok: false, error: "Invalid body: { mode: 'dry' | 'live' } or { clearOverride: true }" },
    { status: 400 }
  );
}
