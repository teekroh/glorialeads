import { NextResponse } from "next/server";
import { markDashboardNotificationsRead } from "@/services/dashboardNotificationService";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.map((x: unknown) => String(x)) : [];
  if (!ids.length) {
    return NextResponse.json({ ok: false, error: "ids array required" }, { status: 400 });
  }
  await markDashboardNotificationsRead(ids);
  return NextResponse.json({ ok: true });
}
