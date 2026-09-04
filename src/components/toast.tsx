"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "info";
/** An optional button inside the toast — THE undo trail for inline edits (the price list's
 *  click-to-edit cells save on blur, so "Saved · Undo" is the only save game they need). */
export type ToastAction = { label: string; onClick: () => void };
type ToastItem = { id: number; message: string; kind: ToastKind; action?: ToastAction };

type ToastFn = (message: string, kind?: ToastKind, action?: ToastAction) => void;

/** Call to show a toast: `const toast = useToast(); toast("Saved", "success")`.
 *  With an action: `toast("Saved", "success", { label: "Undo", onClick })` — stays 6s. */
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
    (message, kind = "info", action) => {
      if (!message) return;
      const id = ++_id;
      setToasts((t) => [...t, { id, message, kind, action }]);
      // An action toast lingers long enough to be tapped; an error long enough to be read.
      const ttl = action ? 6000 : kind === "error" ? 5000 : 2800;
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
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  dismiss(t.id);
                  t.action?.onClick();
                }}
                className="shrink-0 rounded-md border border-white/40 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide hover:bg-white/15"
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
