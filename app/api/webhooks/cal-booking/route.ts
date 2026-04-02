import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { detectCalBookingEventType, processCalBookingPayload } from "@/services/calBookingService";
import { requireAdminApiKey, requireWebhookSecret } from "@/lib/apiRouteSecurity";

function isProduction() { return process.env.NODE_ENV === "production"; }

function extractSecretCandidate(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const direct = b.secret ?? b.webhookSecret ?? b.calWebhookSecret;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const payload = b.payload;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const nested = p.secret ?? p.webhookSecret ?? p.calWebhookSecret;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return null;
}

function verifyCalHmac(secret: string, rawBody: string, signatureHeader: string): boolean {
  try {
    if (!signatureHeader || !rawBody) return false;
    const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signatureHeader, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch { return false; }
}

export async function POST(request: Request) {
  const receivedAt = new Date().toISOString();
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let rawBody = "";
  let body: unknown = null;
  try {
    rawBody = await request.text();
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch { body = null; }

  const eventType = detectCalBookingEventType(body);
  const secretFromPayload = extractSecretCandidate(body);
  const calSignatureHeader = (request.headers.get("x-cal-signature-256") ?? "").trim();
  const calSecretConfigured = Boolean(process.env.CAL_WEBHOOK_SECRET?.trim());

  if (calSecretConfigured) {
    const secret = process.env.CAL_WEBHOOK_SECRET!.trim();
    const hmacValid = verifyCalHmac(secret, rawBody, calSignatureHeader);
    if (!hmacValid) {
      const secretErr = requireWebhookSecret(request, "CAL_WEBHOOK_SECRET", {
        headerNames: ["x-cal-webhook-secret", "x-webhook-secret", "x-cal-secret", "webhook-secret"],
        bodyValues: [secretFromPayload ?? ""],
      });
      if (secretErr) {
        const adminErr = requireAdminApiKey(request);
        if (adminErr) return secretErr;
      }
    }
  } else if (isProduction()) {
    const adminErr = requireAdminApiKey(request);
    if (adminErr) return adminErr;
  }

  console.log(`[Cal Webhook] received`, {
    requestId, receivedAt, eventType,
    hasBody: Boolean(body), secretConfigured: calSecretConfigured,
    calSignaturePresent: Boolean(calSignatureHeader), secretValidated: true,
  });
  try { await processCalBookingPayload(body); }
  catch (err) { console.error(`[Cal Webhook] processing error`, { requestId, eventType, error: String(err) }); }
  console.log(`[Cal Webhook] done`, { requestId, eventType });
  return NextResponse.json({ ok: true });
}
