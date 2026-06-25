"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Loader2 } from "lucide-react";
import type { NavTree } from "@/lib/nav-tree";
import { resolveNavTree, type BloomNode } from "./app-shell/glass-bloom";
import { executeAction } from "@/lib/actions/execute";

/**
 * The "⋯" actions menu — a clean kebab button + glass dropdown that matches the
 * global + menu (no bloom, no noodles). Lists an entity's actions: descriptor
 * verbs run via executeAction (then navigate/refresh), links navigate. Replaces
 * the glass-bloom SectionMapButton on detail pages.
 */
export function SectionActionsMenu({
  tree,
  isStaff = true,
  label = "Actions",
}: {
  tree: NavTree;
  isStaff?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const { nodes } = resolveNavTree(tree);
  const shown = nodes.filter((n) => !n.staffOnly || isStaff);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function pick(n: BloomNode) {
    setErr(null);
    if (n.action) {
      setBusy(n.id);
      try {
        const res = await executeAction(n.action.name, n.action.input ?? {});
        setBusy(null);
        if (res.ok) {
          setOpen(false);
          if (n.href) router.push(n.href);
          else router.refresh();
          return;
        }
        setErr(res.error ?? "Couldn't do that.");
      } catch {
        setBusy(null);
        setErr("Couldn't do that.");
      }
      return;
    }
    if (n.href) {
      setOpen(false);
      router.push(n.href);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
      {open && (
        // position set inline because .glass-gloss forces position:relative, which
        // would override a Tailwind `absolute`. Left-aligned (the kebab is the leftmost
        // control, so right-anchoring pushed the panel off-screen to the left).
        <div
          style={{ position: "absolute", left: 0, top: "calc(100% + 0.25rem)" }}
          className="glass glass-gloss glass-menu z-[90] w-56 overflow-hidden rounded-lg py-1.5 shadow-xl"
        >
          {shown.map((n) => {
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                onClick={() => pick(n)}
                disabled={busy === n.id}
                className="relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15 disabled:opacity-50"
              >
                {busy === n.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[rgb(var(--glass-ink))]" />
                ) : (
                  <Icon className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" />
                )}
                {n.label}
              </button>
            );
          })}
          {err && <div className="px-4 py-1.5 text-xs text-red-600">{err}</div>}
        </div>
      )}
    </div>
  );
}
