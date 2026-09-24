"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "info";
/** An optional button inside the toast — THE undo trail for inline edits (the price list's
 *  click-to-edit cells save on blur, so "Saved · Undo" is the only save game they need). */
export type ToastAction = { label: string; onClick: () => void };
/** `sticky`: the toast stays until someone taps Got It. For a sentence that has to be READ, not
 *  glimpsed: a money warning (an invoice that keeps its old figure, a lunch or a pay rate that landed
 *  somewhere else) used to go out as a 2.8-second info toast on a page refreshing underneath it. */
export type ToastOptions = { sticky?: boolean };
type ToastItem = { id: number; message: string; kind: ToastKind; action?: ToastAction; sticky?: boolean };

type ToastFn = (message: string, kind?: ToastKind, action?: ToastAction, opts?: ToastOptions) => void;

/** Call to show a toast: `const toast = useToast(); toast("Saved", "success")`.
 *  With an action: `toast("Saved", "success", { label: "Undo", onClick })` — stays 10s.
 *  Must be read: `toast(warning, "info", undefined, { sticky: true })` — stays until dismissed. */
const ToastCtx = createContext<ToastFn>(() => {});
export function useToast() {
  return useContext(ToastCtx);
}

let _id = 0;

/**
 * App-wide toast channel — the ONE place actions report success/failure, so a result is never
 * silently swallowed (the old pattern `await action(); router.refresh()` discarded {ok,error},
 * which hid failures and drove duplicate taps/double-sends). Mounted once in the app layout.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback<ToastFn>(
    (message, kind = "info", action, opts) => {
      if (!message) return;
      const id = ++_id;
      const sticky = !!opts?.sticky;
      setToasts((t) => [...t, { id, message, kind, action, sticky }]);
      if (sticky) return;
      // An action toast lingers long enough to be found and tapped with one hand (an Undo that has
      // gone by the time a thumb reaches it is no Undo); an error long enough to be read.
      const ttl = action ? 10000 : kind === "error" ? 5000 : 2800;
      setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      {/* Above the mobile bottom nav; centered, non-blocking. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[200] flex flex-col items-center gap-2 px-4 shell:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex max-w-sm items-center gap-3 animate-in fade-in slide-in-from-bottom-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-lg ${
              t.kind === "error" ? "bg-red-600" : t.kind === "success" ? "bg-emerald-600" : "bg-slate-800"
            }`}
          >
            <span>{t.message}</span>
            {/* 44px: the one Undo after a split lives here, and it is tapped one-handed on a phone. */}
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  dismiss(t.id);
                  t.action?.onClick();
                }}
                className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border border-white/40 px-3 text-sm font-semibold hover:bg-white/15"
              >
                {t.action.label}
              </button>
            )}
            {t.sticky && !t.action && (
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border border-white/40 px-3 text-sm font-semibold hover:bg-white/15"
              >
                Got It
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
