import { NextResponse } from "next/server";
import { blockInProductionUnlessEnabled, requireAdminApiKey } from "@/lib/apiRouteSecurity";
import {
  discoverAndCreatePlacesLeads,
  type PlacesDiscoverBody
} from "@/services/placesLeadDiscoveryService";

/**
 * POST: run Google Places API (New) Text Search and insert up to `limit` leads (default 5).
 * Dev: ALLOW_DEV_ROUTES + optional admin key (local). Production: same flags as other /api/dev/* routes.
 *
 * Billing: Text Search requests are paid Google Maps Platform usage — see response `pricingNote`
 * and https://developers.google.com/maps/documentation/places/web-service/usage-and-billing
 */
export async function GET() {
  const blocked = blockInProductionUnlessEnabled("ALLOW_DEV_ROUTES");
  if (blocked) return blocked;
  return NextResponse.json({
    hint: "POST JSON body: { textQuery?, limit? (default 5, max 20), latitude?, longitude?, radiusMeters?, defaultLeadType?: 'designer'|'builder' }. Requires GOOGLE_PLACES_API_KEY. Sets source Scraped / External; sourceDetail Google Places: {query}. Dedupes by place id, website host, phone (last 10 digits)."
  });
}

export async function POST(request: Request) {
  const blocked = blockInProductionUnlessEnabled("ALLOW_DEV_ROUTES");
  if (blocked) return blocked;
  const authErr = requireAdminApiKey(request);
  if (authErr) return authErr;

  let body: PlacesDiscoverBody = {};
  try {
    body = (await request.json()) as PlacesDiscoverBody;
  } catch {
    body = {};
  }

  try {
    const result = await discoverAndCreatePlacesLeads(body);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "places_discover_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
