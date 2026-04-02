import { NextResponse } from "next/server";
import { outreachConfig } from "@/config/outreachConfig";
import { verifyCronSecret } from "@/lib/apiRouteSecurity";
import { dispatchDueScheduledOutreach } from "@/services/scheduledOutreachDispatchService";

/**
 * Send due scheduled follow-ups (and regenerate copy with Claude when configured).
 * Secure with CRON_SECRET. Vercel: add cron in vercel.json pointing here.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const result = await dispatchDueScheduledOutreach(outreachConfig.scheduledDispatchBatchLimit);
  return NextResponse.json({ ok: true, ...result });
}
