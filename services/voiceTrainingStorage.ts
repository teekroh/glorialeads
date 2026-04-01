import { db } from "@/lib/db";
import { uid } from "@/lib/utils";

export type VoiceTrainingNoteDTO = {
  id: string;
  scenarioKind: string;
  mockClaudeReply: string;
  userCorrection: string;
  createdAt: string;
};

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Appended to Claude system prompts so your corrections steer future generations. */
export async function fetchVoiceTrainingPromptAppendix(limit: number): Promise<string> {
  try {
    const rows = await db.voiceTrainingNote.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.min(40, Math.max(1, limit))
    });
    if (!rows.length) return "";
    const bullets = rows.map(
      (r, i) =>
        `${i + 1}. [${r.scenarioKind}] Draft: ${clip(r.mockClaudeReply, 220)} — Prefer: ${clip(r.userCorrection, 320)}`
    );
    return [
      "Operator voice alignment (honor these patterns when the situation is similar; do not copy verbatim unless fitting):",
      ...bullets
    ].join("\n");
  } catch {
    return "";
  }
}

export async function saveVoiceTrainingNote(input: {
  scenarioKind: string;
  mockClaudeReply: string;
  userCorrection: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const mockClaudeReply = input.mockClaudeReply.trim();
  const userCorrection = input.userCorrection.trim();
  const scenarioKind = input.scenarioKind.trim();
  if (!scenarioKind || !mockClaudeReply || !userCorrection) {
    return { ok: false, error: "scenario, mock reply, and your correction are required." };
  }
  try {
    await db.voiceTrainingNote.create({
      data: {
        id: uid(),
        scenarioKind,
        mockClaudeReply,
        userCorrection
      }
    });
    return { ok: true };
  } catch (e) {
    console.warn("[Gloria] VoiceTrainingNote save failed:", e);
    return { ok: false, error: "Could not save (is the database table created?)" };
  }
}

export async function listVoiceTrainingNotes(take = 50): Promise<VoiceTrainingNoteDTO[]> {
  try {
    const rows = await db.voiceTrainingNote.findMany({
      orderBy: { createdAt: "desc" },
      take
    });
    return rows.map((r) => ({
      id: r.id,
      scenarioKind: r.scenarioKind,
      mockClaudeReply: r.mockClaudeReply,
      userCorrection: r.userCorrection,
      createdAt: r.createdAt.toISOString()
    }));
  } catch {
    return [];
  }
}
