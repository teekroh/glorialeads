import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseVerifyAddressCorrection } from "@/lib/verifyAddressParse";

const UNKNOWN_SCORE_PENALTY = 20;

function normalizeEmailInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  if (!t) return null;
  if (!t.includes("@")) return null;
  return t;
}

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

  const emailRaw = typeof body.email === "string" ? body.email.trim() : "";
  const emailNew = emailRaw ? normalizeEmailInput(body.email) : null;
  if (emailRaw && !emailNew) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  const addressRaw = typeof body.address === "string" ? body.address.trim() : "";
  const parsedAddress = addressRaw ? parseVerifyAddressCorrection(addressRaw) : null;
  const isoDate = new Date().toISOString().slice(0, 10);

  if (verdict === "unknown") {
    const newScore = Math.max(0, existing.score - UNKNOWN_SCORE_PENALTY);
    const note = `[Verify ${isoDate}] Uncertain — score −${UNKNOWN_SCORE_PENALTY} (not rejected; re-review if score recovers).`;
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

  if (emailNew) {
    const duplicate = await db.lead.findFirst({
      where: { email: { equals: emailNew, mode: "insensitive" }, NOT: { id } }
    });
    if (duplicate) {
      return NextResponse.json({ ok: false, error: "duplicate_email" }, { status: 409 });
    }
  }

  const priorNotes = existing.confidenceNotes?.trim() ?? "";
  let confidenceNotesOut: string | undefined;
  if (addressRaw && !parsedAddress) {
    confidenceNotesOut = [priorNotes, `[Verify ${isoDate}] Address (could not parse as "…, ST 12345"): ${addressRaw}`]
      .filter(Boolean)
      .join(" \n");
  }

  await db.lead.update({
    where: { id },
    data: {
      deployVerifyVerdict: verdict,
      updatedAt: new Date(),
      ...(emailNew ? { email: emailNew } : {}),
      ...(parsedAddress ? { city: parsedAddress.city, state: parsedAddress.state, zip: parsedAddress.zip } : {}),
      ...(confidenceNotesOut !== undefined ? { confidenceNotes: confidenceNotesOut } : {})
    }
  });

  return NextResponse.json({ ok: true, verdict });
}
