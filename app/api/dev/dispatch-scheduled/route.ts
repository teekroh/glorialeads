import { NextResponse } from "next/server";
import { blockInProductionUnlessEnabled, requireAdminApiKey } from "@/lib/apiRouteSecurity";
import { dispatchDueScheduledOutreach } from "@/services/scheduledOutreachDispatchService";

export async function POST(request: Request) {
  const blocked = blockInProductionUnlessEnabled("ALLOW_DEV_ROUTES");
  if (blocked) return blocked;
  const authErr = requireAdminApiKey(request);
  if (authErr) return authErr;
  const body = await request.json().catch(() => ({}));
  const limit = Math.min(50, Math.max(1, Number(body.limit) || 20));
  const result = await dispatchDueScheduledOutreach(limit);
  return NextResponse.json({ ok: true, ...result });
}
