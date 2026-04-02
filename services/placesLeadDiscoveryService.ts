import { db } from "@/lib/db";
import { uid } from "@/lib/utils";
import { estimateDistanceMinutesFromLatLng, HATFIELD_ORIGIN } from "@/services/distanceService";
import { pipelineStatusForTier, scoreLeadBase, type ScoreLeadBaseInput } from "@/services/scoringService";
import type { LeadType } from "@/types/lead";

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

/** Minimal field mask to control Places API (New) billing — avoid `*` (see Google Maps Platform pricing). */
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.nationalPhoneNumber,places.websiteUri,places.location,places.types,places.primaryType";

type AddressParts = { city: string; state: string; zip: string };

function localizedText(place: { displayName?: { text?: string } }): string {
  return (place.displayName?.text ?? "").trim() || "Unknown business";
}

function parseAddressComponents(
  components: Array<{ longText?: string; shortText?: string; types?: string[] }> | undefined
): AddressParts {
  let city = "";
  let state = "";
  let zip = "";
  if (!components?.length) return { city, state, zip };
  for (const c of components) {
    const types = c.types ?? [];
    if (types.includes("locality") || types.includes("sublocality")) {
      city = (c.longText ?? c.shortText ?? "").trim();
    }
    if (types.includes("administrative_area_level_1")) {
      state = (c.shortText ?? c.longText ?? "").trim().toUpperCase().slice(0, 2);
    }
    if (types.includes("postal_code")) {
      zip = (c.longText ?? c.shortText ?? "").trim().slice(0, 10);
    }
  }
  return { city, state, zip };
}

/** Fallback parse from formattedAddress when components are thin. */
function fallbackFromFormatted(formatted: string | undefined, parts: AddressParts): AddressParts {
  if (!formatted) return parts;
  const z = formatted.match(/\b(\d{5})(?:-\d{4})?\b/);
  const zip = parts.zip || (z ? z[1]! : "");
  const st = parts.state || (formatted.match(/\b([A-Z]{2})\s+\d{5}\b/i)?.[1]?.toUpperCase() ?? "");
  return { city: parts.city, state: st || parts.state, zip: zip || parts.zip };
}

export function normalizeWebsiteHost(uri: string | undefined | null): string | null {
  if (!uri?.trim()) return null;
  try {
    const u = new URL(uri.startsWith("http") ? uri : `https://${uri}`);
    const h = u.hostname.toLowerCase();
    return h.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function normalizePhoneDigits(phone: string | undefined | null): string {
  return (phone ?? "").replace(/\D/g, "");
}

export function inferLeadTypeFromGoogleTypes(
  types: string[] | undefined,
  primaryType: string | undefined,
  fallback: "designer" | "builder"
): LeadType {
  const all = new Set<string>([...(types ?? []), primaryType].filter(Boolean) as string[]);
  const has = (s: string) => [...all].some((t) => t === s || t.includes(s));

  if (has("interior_designer") || has("furniture_store")) return "designer";
  if (has("architect")) return "architect";
  if (has("general_contractor") || has("home_improvement_store") || has("home_goods_store")) return "builder";
  if (has("electrician") || has("plumber") || has("painter") || has("locksmith")) return "builder";
  if (has("roofing_contractor")) return "builder";
  if (has("carpenter")) return "cabinet shop";
  return fallback === "designer" ? "designer" : "builder";
}

function splitPersonName(display: string): { firstName: string; lastName: string; fullName: string } {
  const fullName = display.replaceAll(/\s+/g, " ").trim() || "Business";
  const tokens = fullName.split(" ");
  if (tokens.length === 1) return { firstName: fullName.slice(0, 40), lastName: "—", fullName };
  return {
    firstName: tokens[0]!.slice(0, 40),
    lastName: tokens.slice(1).join(" ").slice(0, 80),
    fullName
  };
}

export type PlacesDiscoverBody = {
  textQuery?: string;
  limit?: number;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  /** When Google types are ambiguous, prefer this trade shape (default builder = remodel crews). */
  defaultLeadType?: "designer" | "builder";
};

export async function runPlacesTextSearch(apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(PLACES_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK
    },
    body: JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error as { message?: string } | undefined)?.message ?? res.statusText;
    return { ok: false as const, status: res.status, error: err, raw: json };
  }
  return { ok: true as const, data: json as { places?: Record<string, unknown>[] } };
}

/**
 * Creates up to `limit` new leads from Places Text Search.
 * Dedupes by googlePlaceId, websiteHost (Scraped / External), and same-source phone digits.
 */
export async function discoverAndCreatePlacesLeads(input: PlacesDiscoverBody): Promise<{
  ok: true;
  created: number;
  skipped: number;
  skippedReasons: string[];
  createdIds: string[];
  queryUsed: string;
  pricingNote: string;
}> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY is not set");
  }

  const limit = Math.min(20, Math.max(1, Math.round(input.limit ?? 5)));
  const lat = input.latitude ?? HATFIELD_ORIGIN.lat;
  const lng = input.longitude ?? HATFIELD_ORIGIN.lon;
  const radiusMeters = Math.min(50000, Math.max(5000, Math.round(input.radiusMeters ?? 45000)));
  const defaultLeadType = input.defaultLeadType ?? "builder";
  const textQuery =
    (input.textQuery ?? process.env.PLACES_DISCOVER_DEFAULT_QUERY ?? "").trim() ||
    "small remodeling contractor kitchen bath interior designer";

  const searchBody = {
    textQuery: `${textQuery} near ${lat},${lng}`,
    maxResultCount: Math.min(20, Math.max(limit, 10)),
    locationBias: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: radiusMeters
      }
    },
    languageCode: "en"
  };

  const searched = await runPlacesTextSearch(apiKey, searchBody);
  if (!searched.ok) {
    throw new Error(`Places API: ${searched.error}`);
  }

  const places = searched.data.places ?? [];
  const skippedReasons: string[] = [];
  const createdIds: string[] = [];
  let created = 0;
  let skipped = 0;
  const now = new Date();

  const scrapedRows = await db.lead.findMany({
    where: { source: "Scraped / External" },
    select: { phone: true, websiteHost: true }
  });
  const phoneTailsSeen = new Set<string>();
  const hostsSeen = new Set<string>();
  for (const row of scrapedRows) {
    const d = normalizePhoneDigits(row.phone);
    if (d.length >= 10) phoneTailsSeen.add(d.slice(-10));
    if (row.websiteHost) hostsSeen.add(row.websiteHost);
  }

  const pricingNote =
    "Google Places API (New) Text Search is billed per request; use a tight field mask and low maxResultCount. See https://developers.google.com/maps/billing-and-pricing/pricing#places-pricing — enable billing in Google Cloud and monitor usage in the console.";

  for (const p of places) {
    if (created >= limit) break;

    const placeId = typeof p.id === "string" ? p.id : "";
    if (!placeId) {
      skipped += 1;
      skippedReasons.push("missing place id");
      continue;
    }

    const existingPlace = await db.lead.findFirst({ where: { googlePlaceId: placeId } });
    if (existingPlace) {
      skipped += 1;
      skippedReasons.push(`duplicate place_id ${placeId}`);
      continue;
    }

    const display = localizedText(p as { displayName?: { text?: string } });
    const formattedAddress = typeof p.formattedAddress === "string" ? p.formattedAddress : "";
    let { city, state, zip } = parseAddressComponents(
      p.addressComponents as Array<{ longText?: string; shortText?: string; types?: string[] }> | undefined
    );
    ({ city, state, zip } = fallbackFromFormatted(formattedAddress, { city, state, zip }));

    const phone = typeof p.nationalPhoneNumber === "string" ? p.nationalPhoneNumber.trim() : "";
    const phoneDigits = normalizePhoneDigits(phone);
    const websiteUri = typeof p.websiteUri === "string" ? p.websiteUri.trim() : "";
    const websiteHost = normalizeWebsiteHost(websiteUri);

    if (websiteHost && hostsSeen.has(websiteHost)) {
      skipped += 1;
      skippedReasons.push(`duplicate website ${websiteHost}`);
      continue;
    }

    if (phoneDigits.length >= 10) {
      const tail = phoneDigits.slice(-10);
      if (phoneTailsSeen.has(tail)) {
        skipped += 1;
        skippedReasons.push(`duplicate phone (last 10)`);
        continue;
      }
    }

    const loc = p.location as { latitude?: number; longitude?: number } | undefined;
    const latP = typeof loc?.latitude === "number" ? loc.latitude : null;
    const lonP = typeof loc?.longitude === "number" ? loc.longitude : null;
    const distanceMinutes =
      latP !== null && lonP !== null ? estimateDistanceMinutesFromLatLng(latP, lonP) : zip ? 45 : 60;

    const types = Array.isArray(p.types) ? (p.types as string[]) : [];
    const primaryType = typeof p.primaryType === "string" ? p.primaryType : undefined;
    const leadType = inferLeadTypeFromGoogleTypes(types, primaryType, defaultLeadType);

    const { firstName, lastName, fullName } = splitPersonName(display);
    const company = fullName.slice(0, 80);

    const sourceDetail = `Google Places: ${textQuery}`;
    const notes = [
      formattedAddress ? `Address: ${formattedAddress}` : "",
      types.length ? `Google types: ${types.slice(0, 8).join(", ")}` : "",
      websiteUri ? `Web: ${websiteUri}` : ""
    ]
      .filter(Boolean)
      .join(" · ");

    const scoreInput: ScoreLeadBaseInput = {
      email: "",
      source: "Scraped / External",
      enrichmentStatus: "none",
      distanceMinutes,
      amountSpent: 0,
      leadType
    };
    const scored = scoreLeadBase(scoreInput);
    const id = uid();

    if (phoneDigits.length >= 10) phoneTailsSeen.add(phoneDigits.slice(-10));
    if (websiteHost) hostsSeen.add(websiteHost);

    await db.lead.create({
      data: {
        id,
        firstName,
        lastName,
        fullName,
        company,
        email: "",
        phone,
        city: city || "—",
        state: state || "—",
        zip: zip || "",
        leadType,
        source: "Scraped / External",
        sourceDetail,
        enrichmentStatus: "none",
        addressConfidence: null,
        confidenceNotes: "",
        importedFromCsv: false,
        googlePlaceId: placeId,
        websiteUri: websiteUri || null,
        websiteHost,
        amountSpent: 0,
        notes,
        distanceMinutes,
        score: scored.score,
        conversionScore: scored.conversionScore,
        projectFitScore: scored.projectFitScore,
        estimatedProjectTier: scored.estimatedProjectTier,
        priorityTier: scored.priorityTier,
        status: pipelineStatusForTier(scored.priorityTier),
        doNotContact: false,
        deployVerifyVerdict: null,
        scoreBreakdownJson: JSON.stringify(scored.breakdown),
        createdAt: now,
        updatedAt: now
      }
    });

    created += 1;
    createdIds.push(id);
  }

  return {
    ok: true,
    created,
    skipped,
    skippedReasons,
    createdIds,
    queryUsed: textQuery,
    pricingNote
  };
}
