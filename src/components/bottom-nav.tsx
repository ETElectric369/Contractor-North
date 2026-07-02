"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCK, activeSection } from "@/lib/dock";

/**
 * The phone bottom dock. Tapping a tile GOES to that section's main page; the section's
 * pages render as SectionSubnav's pinned top strip — the SAME door for every section.
 * (Office's bespoke slide-in drawer is gone: one tile row, one behavior. Its long list
 * scrolls in the strip like Jobs' does.) Hidden on desktop, where the left column runs.
 */
export function BottomNav({ role }: { role?: string }) {
  const pathname = usePathname();
  const isStaff = role === "owner" || role === "admin" || role === "office";
  const sections = DOCK.filter((s) => isStaff || !s.staffOnly);
  // THE shared matcher (src/lib/dock.ts): child detail routes (/quotes/[id], /forms/[id],
  // /purchasing/[id]…) light their owning tile; unmatched routes light nothing — never a lie.
  const active = activeSection(pathname, sections);

  return (
    <nav
      // transform:translateZ(0) keeps the bar from drifting during iOS momentum scroll.
      style={{ transform: "translateZ(0)", WebkitBackfaceVisibility: "hidden" }}
      className="app-bottom-nav glass fixed inset-x-2 bottom-2 z-[70] flex items-center rounded-2xl border-white/40 px-0.5 pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {sections.map((s) => {
        const Icon = s.icon;
        const onRoute = s.key === active?.key;
        return (
          <Link
            key={s.key}
            href={s.href}
            className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[9px] font-medium ${
              onRoute ? "text-[color:rgb(var(--glass-ink))]" : "text-slate-600"
            }`}
            aria-label={s.label}
          >
            <Icon className="h-5 w-5 shrink-0" />
            <span className="whitespace-nowrap leading-none">{s.short ?? s.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
