import { NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/apiRouteSecurity";
import { setAutoDailyFirstTouchEnabled } from "@/services/outreachDryRunService";

export async function POST(request: Request) {
  const authErr = requireAdminApiKey(request);
  if (authErr) return authErr;

  const body = await request.json().catch(() => ({}));
  const enabled = Boolean(body.enabled);
  await setAutoDailyFirstTouchEnabled(enabled);
  return NextResponse.json({ ok: true, enabled });
}
