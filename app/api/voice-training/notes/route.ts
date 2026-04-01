import { NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/apiRouteSecurity";
import { saveVoiceTrainingNote } from "@/services/voiceTrainingStorage";

export async function POST(request: Request) {
  const authErr = requireAdminApiKey(request);
  if (authErr) return authErr;

  const body = await request.json().catch(() => ({}));
  const scenarioKind = String(body.scenarioKind ?? "").trim();
  const mockClaudeReply = String(body.mockClaudeReply ?? "");
  const userCorrection = String(body.userCorrection ?? "");

  const result = await saveVoiceTrainingNote({ scenarioKind, mockClaudeReply, userCorrection });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
