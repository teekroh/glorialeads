import Anthropic from "@anthropic-ai/sdk";
import { anthropicApiKey, claudeModelId, isClaudeCopyConfigured } from "@/config/claudeConfig";
import type { LeadType } from "@/types/lead";
import { createManualLead } from "@/services/persistenceService";

const MAX_PAGE_CHARS = 120_000;
const FETCH_TIMEOUT_MS = 14_000;

/** Same-origin paths only — no arbitrary crawling off the pasted URL. */
const WELL_KNOWN_CONTACT_PATHS = [
  "/",
  "/contact",
  "/contact-us",
  "/contactus",
  "/inquiry",
  "/get-in-touch",
  "/getintouch",
  "/reach-us",
  "/about"
] as const;

const MAX_IMPORT_URL_ATTEMPTS = 8;
const IMPORT_PER_PAGE_CHARS = 16_000;
const IMPORT_COMBINED_MAX_CHARS = 65_000;

function canonicalSiteUrlKey(href: string): string {
  const u = new URL(href);
  u.hash = "";
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.origin}${path}`.toLowerCase();
}

export function buildWebsiteImportCandidateUrls(seedUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(seedUrl);
  } catch {
    return [];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
  if (isBlockedHostname(parsed.hostname)) return [];

  const origin = parsed.origin;
  const seen = new Set<string>();
  const ordered: string[] = [];

  const push = (href: string) => {
    const k = canonicalSiteUrlKey(href);
    if (seen.has(k)) return;
    seen.add(k);
    const u = new URL(href);
    u.hash = "";
    ordered.push(u.toString());
  };

  push(seedUrl);
  for (const p of WELL_KNOWN_CONTACT_PATHS) {
    push(p === "/" ? `${origin}/` : `${origin}${p}`);
  }
  return ordered.slice(0, MAX_IMPORT_URL_ATTEMPTS);
}

export async function gatherWebsiteImportPlainText(seedUrl: string): Promise<
  | { ok: true; combinedText: string; successfulUrls: string[] }
  | { ok: false; error: string }
> {
  const urls = buildWebsiteImportCandidateUrls(seedUrl);
  if (!urls.length) return { ok: false, error: "Invalid or disallowed URL." };

  const parts: string[] = [];
  const successful: string[] = [];
  let lastError = "Could not load any page.";

  for (const url of urls) {
    const joinedSoFar = parts.join("\n\n");
    if (joinedSoFar.length >= IMPORT_COMBINED_MAX_CHARS) break;

    const r = await fetchPublicPageAsText(url);
    if (!r.ok) {
      lastError = r.error;
      continue;
    }
    successful.push(url);
    parts.push(`--- Page: ${url} ---\n${r.text.slice(0, IMPORT_PER_PAGE_CHARS)}`);
  }

  if (successful.length === 0) {
    return { ok: false, error: lastError };
  }

  const combinedText = parts.join("\n\n").slice(0, IMPORT_COMBINED_MAX_CHARS);
  return { ok: true, combinedText, successfulUrls: successful };
}

const LEAD_TYPES: LeadType[] = [
  "homeowner",
  "designer",
  "architect",
  "builder",
  "cabinet shop",
  "commercial builder"
];

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h.endsWith(".localhost")) return true;
  if (h.includes("metadata.google.internal")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

export function extractPrimaryUrl(message: string): string | null {
  const t = message.trim();
  const urls = t.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  if (urls.length !== 1) return null;
  const u = urls[0]!;
  const rest = t
    .replace(u, "")
    .trim()
    .replace(/^[,;:\s]+|[,;:\s]+$/g, "")
    .replace(/^(please|add|import|fetch|pull|from|this|the|lead|website|site)\b[,.\s]*/gi, "")
    .trim();
  if (rest.length > 0 && rest.length > 40) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (isBlockedHostname(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function htmlToPlainText(html: string): string {
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const stripped = noScript.replace(/<[^>]+>/g, " ");
  return stripped.replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_CHARS);
}

export async function fetchPublicPageAsText(url: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "Only http(s) URLs are allowed." };
    }
    if (isBlockedHostname(parsed.hostname)) {
      return { ok: false, error: "That host is not allowed." };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent": "GloriaDashboardBot/1.0 (+https://github.com/teekroh/glorialeads)",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
      },
      redirect: "follow"
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `Fetch failed (${res.status}). The site may block automated requests.` };
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      return { ok: false, error: "Expected an HTML page." };
    }
    const raw = await res.text();
    const text = htmlToPlainText(raw);
    if (text.length < 80) {
      return { ok: false, error: "Page had very little readable text (blocked or empty)." };
    }
    return { ok: true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch_error";
    return { ok: false, error: msg.includes("abort") ? "Request timed out." : `Could not load page: ${msg}` };
  }
}

async function claudeText(system: string, user: string): Promise<string | null> {
  if (!isClaudeCopyConfigured()) return null;
  const key = anthropicApiKey();
  if (!key) return null;
  try {
    const client = new Anthropic({ apiKey: key });
    const msg = await client.messages.create({
      model: claudeModelId(),
      max_tokens: 2_048,
      system: system,
      messages: [{ role: "user", content: user }]
    });
    const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const t = block?.text?.trim();
    return t || null;
  } catch (e) {
    console.warn("[Gloria] dashboard assistant Claude error:", e);
    return null;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let t = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/im.exec(t);
  if (fence) t = fence[1]!.trim();
  try {
    const o = JSON.parse(t) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type ExtractedLead = {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  phone: string;
  city: string;
  state: string;
  zip: string;
  leadType: LeadType;
};

function normalizeExtracted(o: Record<string, unknown>): ExtractedLead | null {
  const str = (k: string) => (typeof o[k] === "string" ? o[k].trim() : "");
  const email = str("email").toLowerCase();
  if (!email || !email.includes("@")) return null;

  let firstName = str("firstName");
  let lastName = str("lastName");
  const full = str("fullName");
  if ((!firstName || !lastName) && full) {
    const idx = full.indexOf(" ");
    if (idx === -1) {
      firstName = firstName || full;
      lastName = lastName || "Contact";
    } else {
      firstName = firstName || full.slice(0, idx).trim();
      lastName = lastName || full.slice(idx + 1).trim() || "Contact";
    }
  }
  if (!firstName) firstName = "Contact";
  if (!lastName) lastName = "Unknown";

  let leadType = str("leadType") as LeadType;
  if (!LEAD_TYPES.includes(leadType)) leadType = "builder";

  return {
    firstName,
    lastName,
    email,
    company: str("company"),
    phone: str("phone"),
    city: str("city"),
    state: str("state"),
    zip: str("zip"),
    leadType
  };
}

export async function importLeadFromWebsiteUrl(pageUrl: string): Promise<
  | { ok: true; mode: "lead_created"; id: string; summary: string }
  | { ok: false; error: string }
> {
  const gathered = await gatherWebsiteImportPlainText(pageUrl);
  if (!gathered.ok) return { ok: false, error: gathered.error };

  const system = `You extract structured contact data from noisy webpage text for a B2B CRM. Output ONLY valid JSON, no markdown.
Keys: firstName, lastName, fullName (optional), email, company, phone, city, state, zip, leadType.
leadType must be one of: ${LEAD_TYPES.join(", ")} — infer from business (design firm→designer, architect→architect, builder/GC→builder, cabinet→cabinet shop).
Rules: Never invent an email. If multiple emails, prefer a human contact (not noreply@, not generic info@ if a named person email exists). If no email in text, set email to empty string. Text may combine several pages from the same site — prefer contact / team / about sections.`;

  const user = `Primary URL: ${pageUrl}

Merged plain text from ${gathered.successfulUrls.length} page(s): ${gathered.successfulUrls.join(", ")}

(truncated)
---
${gathered.combinedText}
---

Return one JSON object only.`;

  const raw = await claudeText(system, user);
  if (!raw) {
    return { ok: false, error: "Claude is not configured (ANTHROPIC_API_KEY) or the request failed." };
  }

  const obj = parseJsonObject(raw);
  if (!obj) {
    return { ok: false, error: "Could not parse extraction JSON from Claude." };
  }

  const ex = normalizeExtracted(obj);
  if (!ex) {
    return { ok: false, error: "No usable contact email found on that page (or Claude could not identify one)." };
  }

  const result = await createManualLead({
    firstName: ex.firstName,
    lastName: ex.lastName,
    company: ex.company,
    email: ex.email,
    phone: ex.phone,
    city: ex.city,
    state: ex.state,
    zip: ex.zip,
    leadType: ex.leadType,
    amountSpent: 0,
    distanceMinutes: 30,
    notes: `Imported from website via dashboard assistant.`,
    sourceDetail: `Website import: ${pageUrl}`,
    websiteUri: pageUrl
  });

  if (!result.ok) {
    if (result.error === "duplicate_email") {
      return { ok: false, error: "A lead with that email already exists." };
    }
    return { ok: false, error: result.error };
  }

  const summary = `Added lead ${ex.firstName} ${ex.lastName} <${ex.email}> (${ex.company || "no company"}) — appears in Verify pending.`;
  return { ok: true, mode: "lead_created", id: result.id, summary };
}

export async function answerDashboardQuestion(
  userMessage: string,
  pageContext: string
): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  const system = `You are a concise assistant for the Gloria lead operations dashboard (custom cabinetry outreach).
Answer the user's question in plain language. If you lack data, say what you'd need. Keep answers short (under ~250 words) unless they ask for detail.
Do not invent specific numbers about their database — the context below is a snapshot only.`;

  const user = `Dashboard snapshot (may be incomplete):
${pageContext}

User question:
${userMessage}`;

  const raw = await claudeText(system, user);
  if (!raw) {
    return { ok: false, error: "Claude is not configured (ANTHROPIC_API_KEY) or the request failed." };
  }
  return { ok: true, answer: raw };
}
