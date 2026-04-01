import { db } from "@/lib/db";
import { uid } from "@/lib/utils";

export type DashboardNotificationDTO = {
  id: string;
  kind: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

export async function createDashboardNotification(opts: {
  kind: string;
  title: string;
  body: string;
}): Promise<void> {
  try {
    await db.dashboardNotification.create({
      data: {
        id: uid(),
        kind: opts.kind,
        title: opts.title,
        body: opts.body
      }
    });
  } catch (e) {
    console.warn("[Gloria] DashboardNotification create skipped (table missing?):", e);
  }
}

export async function listDashboardNotifications(take = 80): Promise<DashboardNotificationDTO[]> {
  try {
    const rows = await db.dashboardNotification.findMany({
      orderBy: { createdAt: "desc" },
      take
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString()
    }));
  } catch {
    return [];
  }
}

export async function markDashboardNotificationsRead(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await db.dashboardNotification.updateMany({
      where: { id: { in: ids } },
      data: { readAt: new Date() }
    });
  } catch (e) {
    console.warn("[Gloria] markDashboardNotificationsRead failed:", e);
  }
}
