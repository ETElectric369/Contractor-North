"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import type { DockNode, DockSection } from "@/lib/dock";

/**
 * The LONG-menu counterpart to SectionSubnav's pill strip (mobile only, lg:hidden).
 * Past ~6 pages the horizontal strip stops being scannable — Jobs' 13 / Office's 12 /
 * Money's 9 became a blind sideways scroll — so those sections trade it 1:1 for:
 *
 *   1. THE HANDLE — a slim glass chip pinned to the LEFT EDGE at mid-screen (prime
 *      one-thumb territory; same spot on every long section, doctrine law 4). It is
 *      the section's ONE lit indicator: it wears the active tint and names where you
 *      are (the current page, or the section name on detail routes), so the
 *      "where am I" glance survives losing the strip.
 *   2. THE SHEET — tap the handle and a compact glass slide-over lists the section's
 *      pages VERTICALLY: icon + label rows (44px targets), group headers as dividers,
 *      the current page marked. Tap a page → navigate, sheet closes.
 *
 * NOT global chrome: it renders only where the long strip used to (never both), via
 * SectionSubnav's own section matching. Desktop never sees it — the dock's
 * inside-left rail already lists the pages on lg+.
 *
 * Position/transform on the handle are INLINE because .glass-gloss forces
 * position:relative, which beats Tailwind's `fixed` (the known gotcha); ditto the
 * borderLeft resets, since .glass's unlayered border beats layered utilities.
 */
export function SectionSheet({
  group,
  items,
  activeHref,
}: {
  group: DockSection;
  /** The section's children, already staffOnly-filtered (headers included). */
  items: DockNode[];
  activeHref?: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Safety net: any route change (row tap, back-swipe, command bar…) closes it.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // THE MODAL RULE: while a Modal is open, Escape belongs to it, not us.
      if (document.body.classList.contains("modal-open")) return;
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // What the handle names: the current page when one matches (the ?status= children
  // included — activeHref is SectionSubnav's exact-match rule), else the section
  // (detail routes like /billing/[id], where no sibling is "current").
  const active = items.find((c) => c.href && c.href === activeHref);
  const HandleIcon = (active ?? group).icon;
  const handleLabel = active?.label ?? group.label;
  const GroupIcon = group.icon;

  return (
    <>
      {/* The handle. `app-bottom-nav` so body.modal-open hides it like the bottom
          nav — its backdrop-filter + fixed is the exact recipe that beat modal
          z-order on iOS once already. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${group.label} pages`}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${group.label} — ${handleLabel}`}
        style={{ position: "fixed", left: 0, top: "50%", transform: "translateY(-50%)", borderLeft: "none" }}
        className="app-bottom-nav glass glass-tint glass-gloss z-[60] flex w-9 flex-col items-center gap-1.5 rounded-r-2xl py-3 text-[color:rgb(var(--glass-ink))] lg:hidden"
      >
        <HandleIcon className="relative z-10 h-4 w-4 shrink-0" />
        <span
          style={{ writingMode: "vertical-rl" }}
          className="relative z-10 max-h-32 truncate text-[11px] font-semibold leading-none"
        >
          {handleLabel}
        </span>
      </button>

      {/* Scrim — tap anywhere off the sheet to close. Above the bottom nav (70) and
          the ⋯/quick-add menus (90), below Modal (120). */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden="true"
        className={`fixed inset-0 z-[100] touch-none bg-slate-900/30 transition-opacity duration-200 lg:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* The sheet. Kept mounted (it's only links) so it can slide; `invisible`
          when closed so nothing off-screen is tappable or focusable. */}
      <div
        aria-hidden={!open}
        style={{ borderLeft: "none" }}
        className={`glass glass-menu fixed inset-y-0 left-0 z-[100] flex w-[280px] max-w-[82vw] flex-col rounded-r-2xl shadow-xl transition-[transform,visibility] duration-200 ease-out lg:hidden ${
          open ? "visible translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-white/50 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <GroupIcon className="h-5 w-5 shrink-0 text-[rgb(var(--glass-ink))]" />
          <span className="text-sm font-semibold text-slate-900">{group.label}</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-white/60"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {items.map((c) => {
            const CIcon = c.icon;
            // Headers flatten away in the strip, but HERE they earn their keep as
            // dividers — the vertical list is where grouping reads (like the rail).
            if (c.header || !c.href) {
              return (
                <div
                  key={c.id}
                  className="mt-3 flex items-center gap-1.5 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 first:mt-1"
                >
                  <CIcon className="h-3.5 w-3.5 shrink-0" />
                  {c.label}
                </div>
              );
            }
            const cur = c.href === activeHref;
            return (
              <Link
                key={c.id}
                href={c.href}
                onClick={() => setOpen(false)}
                className={`flex min-h-[44px] items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors ${
                  cur ? "bg-brand text-white shadow-sm" : "text-slate-700 hover:bg-white/70"
                }`}
              >
                <CIcon className={`h-4 w-4 shrink-0 ${cur ? "" : "text-[rgb(var(--glass-ink))]"}`} />
                <span className="truncate">{c.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
