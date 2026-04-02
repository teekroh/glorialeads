import { NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/apiRouteSecurity";
import { syncBookingsFromGoogleCalendar } from "@/services/googleCalendarBookingsSyncService";

/** POST: scan configured Google Calendar for guest events and mark eligible CRM leads as Booked. */
export async function POST(request: Request) {
  const authErr = requireAdminApiKey(request);
  if (authErr) return authErr;

  const result = await syncBookingsFromGoogleCalendar();
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
