"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; message: string; kind: ToastKind };

/** Call to show a toast: `const toast = useToast(); toast("Saved", "success")`. */
const ToastCtx = createContext<(message: string, kind?: ToastKind) => void>(() => {});
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
  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    if (!message) return;
    const id = ++_id;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 5000 : 2800);
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      {/* Above the mobile bottom nav; centered, non-blocking. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[200] flex flex-col items-center gap-2 px-4 shell:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto max-w-sm animate-in fade-in slide-in-from-bottom-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-lg ${
              t.kind === "error" ? "bg-red-600" : t.kind === "success" ? "bg-emerald-600" : "bg-slate-800"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
