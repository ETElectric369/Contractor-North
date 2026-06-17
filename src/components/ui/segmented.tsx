"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

export interface SegmentItem {
  id: string;
  label: string;
  href?: string;
}

/**
 * The compact segmented control — the inline-pill analogue of <TabBar>. One
 * source of truth for the `rounded-lg bg-slate-100` pill used across the app for
 * sub-toggles (calendar month/week/day, board week/month, set-time/propose).
 * Each segment is a <Link> when it has an href (server/bidirectional switchers),
 * else a button driven by onSelect (client switchers).
 */
export function SegmentedControl({
  items,
  activeId,
  onSelect,
  stretch = false,
  className,
}: {
  items: SegmentItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  /** Segments fill the width equally (e.g. inside a modal). */
  stretch?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 gap-0.5 rounded-lg bg-slate-100 p-0.5 text-sm", stretch && "w-full", className)}>
      {items.map((s) => {
        const active = s.id === activeId;
        const cls = cn(
          "whitespace-nowrap rounded-md px-3 py-1.5 font-medium transition-colors",
          stretch && "flex-1 text-center",
          active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700",
        );
        return s.href ? (
          <Link key={s.id} href={s.href} scroll={false} className={cls}>
            {s.label}
          </Link>
        ) : (
          <button key={s.id} type="button" onClick={() => onSelect?.(s.id)} className={cls}>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
