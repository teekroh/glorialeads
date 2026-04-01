import { NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/apiRouteSecurity";
import { VOICE_TRAIN_SCENARIOS } from "@/config/voiceTrainScenarios";
import { db } from "@/lib/db";
import { mapDbLeadToLead } from "@/lib/mappers";
import { generateVoiceTrainingMock, VOICE_TRAIN_FALLBACK_LEAD } from "@/services/voiceTrainingMockService";

export async function POST(request: Request) {
  const authErr = requireAdminApiKey(request);
  if (authErr) return authErr;

  const body = await request.json().catch(() => ({}));
  const kind = String(body.kind ?? "").trim();
  if (!VOICE_TRAIN_SCENARIOS.includes(kind as (typeof VOICE_TRAIN_SCENARIOS)[number])) {
    return NextResponse.json({ ok: false, error: "invalid_scenario" }, { status: 400 });
  }

  const leadId = String(body.leadId ?? "").trim();
  let lead = VOICE_TRAIN_FALLBACK_LEAD;
  if (leadId) {
    const row = await db.lead.findUnique({ where: { id: leadId } });
    if (!row) {
      return NextResponse.json({ ok: false, error: "lead_not_found" }, { status: 404 });
    }
    lead = mapDbLeadToLead(row);
  }

  const text = await generateVoiceTrainingMock(kind as (typeof VOICE_TRAIN_SCENARIOS)[number], lead);
  if (!text) {
    return NextResponse.json({ ok: false, error: "claude_unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, mock: text });
}
