/**
 * Lightweight HMAC-signed session cookie.
 *
 * No external dependencies — uses Node.js crypto built-in.
 *
 * Cookie name : GLORIA_SESSION
 * Cookie value: base64url(payload_json) + "." + base64url(hmac_sha256)
 *
 * Required env:
 *   AUTH_SECRET  — at least 32 random chars; used as HMAC key.
 *                  Generate: openssl rand -base64 32
 */

import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE = "GLORIA_SESSION";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  sub: string; // user identifier
  iat: number; // issued-at (unix seconds)
  exp: number; // expires-at (unix seconds)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmacSign(data: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

// ─── public API ──────────────────────────────────────────────────────────────

/** Encode and sign a session. Returns the raw cookie value (not the cookie header). */
export function encodeSession(sub: string): string {
  const secret = process.env.AUTH_SECRET ?? "";
  if (!secret) throw new Error("AUTH_SECRET is not set.");
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { sub, iat: now, exp: now + SESSION_MAX_AGE_SECONDS };
  const encoded = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = hmacSign(encoded, secret);
  return `${encoded}.${sig}`;
}

/** Verify and decode a session cookie value. Returns null if invalid or expired. */
export function decodeSession(cookieValue: string): SessionPayload | null {
  try {
    const secret = process.env.AUTH_SECRET ?? "";
    if (!secret) return null;
    const dot = cookieValue.lastIndexOf(".");
    if (dot < 0) return null;
    const encoded = cookieValue.slice(0, dot);
    const sig = cookieValue.slice(dot + 1);
    const expectedSig = hmacSign(encoded, secret);
    // Constant-time comparison to prevent timing attacks.
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Read the session from a Next.js request. Returns null if missing or invalid. */
export function getSession(request: NextRequest | Request): SessionPayload | null {
  const cookie =
    "cookies" in request && typeof (request as NextRequest).cookies?.get === "function"
      ? (request as NextRequest).cookies.get(SESSION_COOKIE)?.value
      : request.headers.get("cookie")
          ?.split(";")
          .map((c) => c.trim())
          .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
          ?.slice(SESSION_COOKIE.length + 1);
  if (!cookie) return null;
  return decodeSession(cookie);
}

/** Set the session cookie on a response. Mutates and returns the response. */
export function setSessionCookie(response: NextResponse, sub: string): NextResponse {
  const value = encodeSession(sub);
  response.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/"
  });
  return response;
}

/** Clear the session cookie on a response. */
export function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/"
  });
  return response;
}
