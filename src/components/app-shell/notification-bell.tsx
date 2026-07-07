"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { getMyNotifications, markNotificationsRead, type Notif } from "@/app/(app)/notification-actions";

/**
 * The in-app notification bell — the ALWAYS-WORKS channel (independent of push permission,
 * which is the exact thing that bit Erik when an accepted estimate notified no one). Polls
 * the notifications table every 60s + on tab-focus, shows an unread count, and deep-links to
 * whatever the event points at (a won estimate → its job). Sits above the dock (z-[80]).
 */
export function NotificationBell() {
  const router = useRouter();
  const [items, setItems] = useState<Notif[]>([]);
  const [open, setOpen] = useState(false);
  const unread = items.filter((n) => !n.read_at).length;

  const load = useCallback(() => {
    getMyNotifications().then(setItems).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  function onItem(n: Notif) {
    setOpen(false);
    if (!n.read_at) {
      setItems((p) => p.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      markNotificationsRead([n.id]).catch(() => {});
    }
    if (n.url) router.push(n.url);
  }

  function markAll() {
    setItems((p) => p.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
    markNotificationsRead().catch(() => {});
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        title="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[75]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-[80] mt-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <span className="text-sm font-semibold text-slate-800">Notifications</span>
              {unread > 0 && (
                <button onClick={markAll} className="text-xs font-medium text-brand hover:underline">
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-[70vh] overflow-y-auto">
              {items.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-slate-400">You&apos;re all caught up.</div>
              ) : (
                items.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => onItem(n)}
                    className={`block w-full border-b border-slate-50 px-3 py-2.5 text-left hover:bg-slate-50 ${n.read_at ? "" : "bg-blue-50/40"}`}
                  >
                    <div className="flex items-start gap-2">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-blue-500"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-800">{n.title}</div>
                        {n.body && <div className="text-xs text-slate-500">{n.body}</div>}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
