import { NextResponse } from "next/server";
import { db } from "@/lib/db";

const UNKNOWN_SCORE_PENALTY = 20;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const raw = body.verdict;
  const verdict =
    raw === "rejected" ? "rejected" : raw === "approved" ? "approved" : raw === "unknown" ? "unknown" : null;
  if (!verdict) {
    return NextResponse.json({ ok: false, error: "verdict must be approved, rejected, or unknown" }, { status: 400 });
  }
  const existing = await db.lead.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  if (verdict === "unknown") {
    const newScore = Math.max(0, existing.score - UNKNOWN_SCORE_PENALTY);
    const note = `[Verify ${new Date().toISOString().slice(0, 10)}] Uncertain — score −${UNKNOWN_SCORE_PENALTY} (not rejected; re-review if score recovers).`;
    const confidenceNotes = [existing.confidenceNotes?.trim(), note].filter(Boolean).join(" \n");
    await db.lead.update({
      where: { id },
      data: {
        score: newScore,
        confidenceNotes,
        updatedAt: new Date()
      }
    });
    return NextResponse.json({ ok: true, verdict: "unknown", score: newScore });
  }

  await db.lead.update({
    where: { id },
    data: { deployVerifyVerdict: verdict, updatedAt: new Date() }
  });
  return NextResponse.json({ ok: true, verdict });
}
