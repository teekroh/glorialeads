"use client";

import { useMemo, useState } from "react";
import type { DashboardNotificationDTO } from "@/services/dashboardNotificationService";

export function NotificationsPanel({
  items,
  onMarkRead
}: {
  items: DashboardNotificationDTO[];
  onMarkRead: (ids: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const unread = useMemo(() => items.filter((n) => !n.readAt), [items]);
  const unreadCount = unread.length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-brand-ink shadow-sm hover:bg-slate-50"
      >
        Notifications
        {unreadCount > 0 ? (
          <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-semibold text-white">{unreadCount}</span>
        ) : null}
      </button>
      {open ? (
        <>
          <button type="button" className="fixed inset-0 z-40 cursor-default bg-transparent" aria-label="Close" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-[min(100vw-2rem,380px)] max-h-[min(70vh,420px)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <p className="text-xs font-semibold text-slate-700">Activity</p>
              {unreadCount > 0 ? (
                <button
                  type="button"
                  className="text-[11px] font-medium text-violet-700 hover:underline"
                  onClick={() => void onMarkRead(unread.map((n) => n.id))}
                >
                  Mark all read
                </button>
              ) : null}
            </div>
            <ul className="max-h-[min(60vh,360px)] overflow-y-auto divide-y divide-slate-100">
              {!items.length ? (
                <li className="px-3 py-6 text-center text-xs text-slate-500">No notifications yet.</li>
              ) : (
                items.map((n) => (
                  <li key={n.id} className={`px-3 py-2 text-left ${n.readAt ? "bg-white" : "bg-amber-50/60"}`}>
                    <p className="text-xs font-semibold text-brand-ink">{n.title}</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-[11px] text-slate-600">{n.body}</p>
                    <p className="mt-1 text-[10px] text-slate-400">
                      {new Date(n.createdAt).toLocaleString()}{" "}
                      {!n.readAt ? (
                        <button
                          type="button"
                          className="ml-1 font-medium text-violet-700 hover:underline"
                          onClick={() => void onMarkRead([n.id])}
                        >
                          Mark read
                        </button>
                      ) : null}
                    </p>
                  </li>
                ))
              )}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
