import { NextResponse } from "next/server";
import { launchCampaign } from "@/services/persistenceService";
import type { LaunchCampaignOptions } from "@/services/addressConfidencePolicy";
import { requireAdminApiKey } from "@/lib/apiRouteSecurity";

export async function POST(request: Request) {
  const authErr = requireAdminApiKey(request);
  if (authErr) return authErr;
  const payload = await request.json();
  const name = String(payload.name || "Campaign");
  const leadIds = Array.isArray(payload.leadIds) ? payload.leadIds : [];
  const options: LaunchCampaignOptions = {
    includeUnverifiedHighScore: Boolean(payload.includeUnverifiedHighScore)
  };
  const result = await launchCampaign(name, leadIds, options);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, result, error: result.error, errorCode: result.errorCode },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true, result });
}
