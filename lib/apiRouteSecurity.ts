import { NextResponse } from "next/server";

type SecretSource = {
  headerNames?: string[];
  bodyValues?: string[];
};

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    const s = v?.trim();
    if (s) return s;
  }
  return null;
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization")?.trim() ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim() || null;
}

/** Vercel Cron / external scheduler: Authorization: Bearer CRON_SECRET or x-cron-secret header. */
export function verifyCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim() ?? "";
  if (!secret) return false;
  const auth = request.headers.get("authorization")?.trim() ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const header = request.headers.get("x-cron-secret")?.trim() ?? "";
  return bearer === secret || header === secret;
}

export function requireAdminApiKey(request: Request): NextResponse | null {
  if (!isProduction()) return null;
  const expected = process.env.ADMIN_API_KEY?.trim() ?? "";
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Server misconfiguration: ADMIN_API_KEY is required in production." },
      { status: 503 }
    );
  }

  const provided = firstNonEmpty([extractBearerToken(request), request.headers.get("x-api-key"), request.headers.get("x-admin-key")]);
  if (provided !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  return null;
}

export function blockInProductionUnlessEnabled(envFlag: string): NextResponse | null {
  if (!isProduction()) return null;
  if (String(process.env[envFlag] ?? "").toLowerCase() === "true") return null;
  return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
}

export function requireWebhookSecret(
  request: Request,
  expectedSecretEnv: string,
  source: SecretSource
): NextResponse | null {
  const expected = process.env[expectedSecretEnv]?.trim() ?? "";
  if (!expected) {
    if (!isProduction()) return null;
    return NextResponse.json(
      { ok: false, error: `Server misconfiguration: ${expectedSecretEnv} is required in production.` },
      { status: 503 }
    );
  }

  const headerCandidates = (source.headerNames ?? []).map((h) => request.headers.get(h) ?? "");
  const provided = firstNonEmpty([extractBearerToken(request), ...headerCandidates, ...(source.bodyValues ?? [])]);
  if (provided !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized webhook." }, { status: 401 });
  }
  return null;
}
