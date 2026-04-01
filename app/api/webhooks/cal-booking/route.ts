import { NextResponse } from "next/server";
import { detectCalBookingEventType, processCalBookingPayload } from "@/services/calBookingService";
import { requireAdminApiKey, requireWebhookSecret } from "@/lib/apiRouteSecurity";

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function getHeader(request: Request, name: string): string | undefined {
  const v = request.headers.get(name);
  const s = v?.toString().trim();
  return s ? s : undefined;
}

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

/**
 * Cal.com booking webhook endpoint.
 *
 * Configure in Cal.com:
 * - URL: https://<your-host>/api/webhooks/cal-booking
 * - Event types: booking.created / booking.rescheduled / booking.cancelled
 *
 * Secret:
 * - Set `CAL_WEBHOOK_SECRET` in env.
 * - This endpoint checks common Cal/Scheduling webhook secret header names and also payload fields.
 *
 * For now:
 * - Logs full payload.
 * - Returns HTTP 200 with `{ ok: true }`.
 */
export async function POST(request: Request) {
  const receivedAt = new Date().toISOString();
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const eventType = detectCalBookingEventType(body);

  const secretFromHeader =
    getHeader(request, "x-cal-webhook-secret") ||
    getHeader(request, "x-webhook-secret") ||
    getHeader(request, "x-cal-secret") ||
    getHeader(request, "webhook-secret") ||
    getHeader(request, "webhook-signature");

  const secretFromPayload = extractSecretCandidate(body);
  const calSecretConfigured = Boolean(process.env.CAL_WEBHOOK_SECRET?.trim());
  if (calSecretConfigured) {
    const secretErr = requireWebhookSecret(request, "CAL_WEBHOOK_SECRET", {
      headerNames: ["x-cal-webhook-secret", "x-webhook-secret", "x-cal-secret", "webhook-secret", "webhook-signature"],
      bodyValues: [secretFromPayload ?? "", secretFromHeader ?? ""]
    });
    if (secretErr) {
      const adminErr = requireAdminApiKey(request);
      if (adminErr) return secretErr;
    }
  } else if (isProduction()) {
    const adminErr = requireAdminApiKey(request);
    if (adminErr) return adminErr;
  }

  // Clear logs for receipt + validation + event type.
  console.log(`[Cal Webhook] received`, {
    requestId,
    receivedAt,
    eventType,
    hasBody: Boolean(body),
    secretConfigured: calSecretConfigured,
    secretHeaderPresent: Boolean(secretFromHeader),
    secretPayloadPresent: Boolean(secretFromPayload),
    secretValidated: true
  });

  // Process booking.created/rescheduled/cancelled if we can match to a lead/campaign.
  try {
    await processCalBookingPayload(body);
  } catch (err) {
    // Requirement: for now, return { ok: true } even if internal processing fails.
    console.error(`[Cal Webhook] processing error`, { requestId, eventType, error: String(err) });
  }

  console.log(`[Cal Webhook] done`, { requestId, eventType });
  return NextResponse.json({ ok: true });
}
