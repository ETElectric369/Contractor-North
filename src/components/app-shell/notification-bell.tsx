"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { ToastProvider, useToast } from "@/components/toast";
import { getMyBell, markNotificationsRead, type Notif } from "@/app/(app)/notification-actions";
import { BELL_MORE_LINE, bellBadge, bellWhen } from "@/lib/bell-words";

/**
 * The in-app notification bell — the ALWAYS-WORKS channel (independent of push permission,
 * which is the exact thing that bit Erik when an accepted estimate notified no one). Polls
 * the notifications table every 60s + on tab-focus, shows an unread count, and deep-links to
 * whatever the event points at (a won estimate → its job). Sits above the dock (z-[80]).
 *
 * THE BELL RECORDS EVERY PUSH (Wave 1): every push writes its line here (notifyPeople), so this is
 * where a missed push is found again. Its badge counts only what is unread, as the database counts it
 * (never the length of the 20 lines it shows), 9+ above nine and nothing at zero. Each line says when
 * it came in. A mark-read that fails puts the dot back and says so.
 *
 * ITS OWN TOAST. The top bar sits outside the page's ToastProvider (the (app) layout mounts it inside
 * <main>), so the bell carries one of its own: a refusal said here is seen, not swallowed by the
 * provider's empty default.
 */
export function NotificationBell() {
  return (
    <ToastProvider>
      <BellInner />
    </ToastProvider>
  );
}

const MARK_FAILED = "Couldn't mark that read — try again";

function BellInner() {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<Notif[]>([]);
  // The unread count is the database's (getMyBell), moved by hand only while a mark-read is out.
  const [unread, setUnread] = useState(0);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const badge = bellBadge(unread);

  const load = useCallback(() => {
    getMyBell()
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
        setMore(r.more);
        setFailed(r.failed);
      })
      .catch(() => setFailed(true));
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
      setUnread((u) => Math.max(0, u - 1));
      markNotificationsRead([n.id])
        .catch(() => ({ ok: false }))
        .then((r) => {
          if (r.ok) return;
          // The dot comes back, and it is said: the line is still unread.
          setItems((p) => p.map((x) => (x.id === n.id ? { ...x, read_at: null } : x)));
          setUnread((u) => u + 1);
          toast(MARK_FAILED, "error");
        });
    }
    if (n.url) router.push(n.url);
  }

  function markAll() {
    setItems((p) => p.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
    setUnread(0);
    markNotificationsRead()
      .catch(() => ({ ok: false }))
      .then((r) => {
        if (r.ok) return;
        load(); // the truth, dots and count, from the database
        toast(MARK_FAILED, "error");
      });
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        // `data-upright`: the top bar never rotates in the App Store app, so when the phone is turned
        // this 44px square's face is painted through the same quarter turn and the bell reads upright.
        // ON THE BUTTON — the list below is a SIBLING, and a transform on the wrapper would anchor it
        // to this control instead of the viewport (globals.css says why).
        data-upright
        className="relative flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
        aria-label={badge ? `Notifications, ${unread} unread` : "Notifications"}
        title="Notifications"
      >
        <Bell className="h-5 w-5" />
        {badge && (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[75]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-[80] mt-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-1">
              <span className="text-sm font-semibold text-slate-800">Notifications</span>
              {unread > 0 && (
                <button onClick={markAll} className="min-h-11 px-1 text-xs font-medium text-brand hover:underline">
                  Mark All Read
                </button>
              )}
            </div>
            <div className="max-h-[70vh] overflow-y-auto">
              {failed ? (
                <div className="px-3 py-8 text-center text-sm text-slate-500">Couldn&apos;t load your notifications just now. They&apos;re still there; open this again in a moment.</div>
              ) : items.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-slate-400">You&apos;re all caught up.</div>
              ) : (
                <>
                  {items.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => onItem(n)}
                      className={`block min-h-11 w-full border-b border-slate-50 px-3 py-2.5 text-left hover:bg-slate-50 ${n.read_at ? "" : "bg-blue-50/40"}`}
                    >
                      <div className="flex items-start gap-2">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-blue-500"}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{n.title}</span>
                            <span className="shrink-0 text-[11px] text-slate-400">{bellWhen(n.created_at)}</span>
                          </div>
                          {n.body && <div className="text-xs text-slate-500">{n.body}</div>}
                        </div>
                      </div>
                    </button>
                  ))}
                  {more && <p className="px-3 py-2 text-center text-xs text-slate-400">{BELL_MORE_LINE}</p>}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
