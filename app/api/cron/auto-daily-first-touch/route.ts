import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/apiRouteSecurity";
import { runAutoDailyFirstTouchJob } from "@/services/autoDailyFirstTouchService";

/**
 * Sends one auto first-touch batch during 8–10 AM BUSINESS_TIMEZONE when enabled in DB.
 * Uses same limits as manual launch (DAILY_SEND_LIMIT, CAMPAIGN_SEND_LIMIT, etc.).
 * Secure with CRON_SECRET (Vercel cron).
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const result = await runAutoDailyFirstTouchJob();
  return NextResponse.json(result);
}
