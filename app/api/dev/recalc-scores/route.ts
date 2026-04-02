import { NextResponse } from "next/server";
import { recalculateAllLeadScores } from "@/services/persistenceService";
import { blockInProductionUnlessEnabled, requireAdminApiKey } from "@/lib/apiRouteSecurity";

/** POST to re-apply `scoreLeadBase` to every row (email, source, enrich status, distance, spend, lead type). Local dev helper. */
export async function POST(request: Request) {
  const blocked = blockInProductionUnlessEnabled("ALLOW_DEV_ROUTES");
  if (blocked) return blocked;
  const authErr = requireAdminApiKey(request);
  if (authErr) return authErr;
  const updated = await recalculateAllLeadScores();
  return NextResponse.json({ ok: true, updated });
}
