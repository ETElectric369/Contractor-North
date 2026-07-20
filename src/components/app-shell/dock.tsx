"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { DOCK, activeSection, basePath } from "@/lib/dock";

type DockProps = {
  branding?: { name: string | null; logo: string | null };
  role?: string;
  badges?: Record<string, number>;
  /** Dock child ids hidden for this org (e.g. "j-permits" when settings.hide_permits). */
  hiddenIds?: string[];
};

/**
 * ONE dock, two orientations. The same section tiles — from the same `activeSection()`
 * match, with the same `.seaglass-active` highlight — render as a vertical rail on the
 * left for desktop (the `shell:` breakpoint — lg+, or ≥900px with a fine
 * pointer, so the ~900px desktop-PWA window gets it) and as a bar pinned to
 * the bottom on phones. Previously these
 * were TWO components (this file + a separate <BottomNav>) hand-styled in parallel, so
 * the active look kept drifting between them (the bottom bar lagged the desktop dock a
 * whole release). Now the tile lives once; change it and both surfaces move together.
 *
 * useSearchParams (the rail's exact active-match needs the ?status= query) requires a
 * Suspense boundary at prerender — it lives HERE so the layout call-site stays <Dock />.
 */
export function Dock(props: DockProps) {
  return (
    <Suspense fallback={null}>
      <DockInner {...props} />
    </Suspense>
  );
}

function DockInner({ branding, role, badges, hiddenIds = [] }: DockProps) {
  const pathname = usePathname();
  const search = useSearchParams();
  const current = pathname + (search.toString() ? `?${search.toString()}` : "");
  const isStaff = role === "owner" || role === "admin" || role === "office";
  const logo = branding?.logo;
  const sections = DOCK.filter((s) => isStaff || !s.staffOnly);
  // THE shared matcher (src/lib/dock.ts) — child detail routes (/quotes/[id], /forms/[id],
  // /purchasing/[id]…) light their owning section. No match → NOTHING lit and no rail: the
  // old `?? sections[0]` fallback lit "Today" (and railed My day/Tasks/Organize) on every
  // orphan route — an actively wrong map, never a lie again.
  const active = activeSection(pathname, sections);
  const items = (active?.children ?? []).filter((c) => (isStaff || !c.staffOnly) && !hiddenIds.includes(c.id));
  // Exactly ONE rail row lights: prefer the exact href-with-query match (the ?status=
  // children), else the query-less page whose base path matches — SectionSubnav's rule.
  const exact = items.find((c) => c.href === current);
  const activeHref =
    exact?.href ??
    items.find((c) => c.href && basePath(c.href) === pathname && !c.href.includes("?"))?.href;

  return (
    <>
      {/* ── DESKTOP (shell:): the left icon rail + an inside-left nav column for the section's pages ── */}
      <div className="hidden h-full shell:flex">
        <aside className="glass relative z-[70] flex h-full w-[84px] flex-col items-center gap-1 border-r border-white/40 py-3">
          <Link href="/planner" className="mb-1 flex h-11 w-11 items-center justify-center rounded-2xl" aria-label={branding?.name ?? "Home"} title={branding?.name ?? "Contractor North"}>
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" className="h-10 w-10 rounded-xl object-contain" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/cn-logo.svg" alt="" className="h-9 w-9" />
            )}
          </Link>
          <div className="flex flex-1 flex-col items-center gap-0.5 overflow-y-auto">
            {sections.map((s) => {
              const Icon = s.icon;
              const on = s.key === active?.key;
              const badge = s.children.reduce((sum, c) => sum + (c.href ? badges?.[c.href] ?? 0 : 0), 0);
              return (
                <Link
                  key={s.key}
                  href={s.href}
                  title={s.label}
                  className={`group relative flex w-[74px] flex-col items-center gap-0.5 rounded-2xl px-1 py-1.5 transition-transform ${
                    on ? "seaglass-active" : "hover:scale-[1.05]"
                  }`}
                >
                  <span className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-xl ${on ? "" : "text-slate-600"}`}>
                    <Icon className="h-[21px] w-[21px]" />
                  </span>
                  <span className={`relative z-10 text-[10px] font-medium leading-none ${on ? "" : "text-slate-600"}`}>{s.short ?? s.label}</span>
                  {badge > 0 && (
                    <span className="absolute right-1 top-1 z-10 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-amber-900">
                      {/* Display-capped per the badge invariant (action-items/types.ts):
                          past 9 the exact figure is noise — the list is the source of truth. */}
                      {badge > 9 ? "9+" : badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </aside>

        {/* The inside-left nav — shown for EVERY section with more than one page, so the
            section's siblings are always one glance away on desktop. The mobile counterpart
            is SectionSubnav's top strip (which hides itself at shell: to avoid doubling). */}
        {active && items.filter((c) => c.href).length > 1 && (
          <nav className="flex h-full w-[186px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-slate-200/80 bg-white/55 px-2.5 py-3 backdrop-blur-sm">
            <div className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{active.label}</div>
            {items.map((c) => {
              const CIcon = c.icon;
              if (c.header || !c.href) {
                return (
                  <div key={c.id} className="mt-2 flex items-center gap-1.5 px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
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
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                    // Active row IS the section tile's look (sea-glass, never brand blue): the
                    // shared `.seaglass-active` recipe. Resting rows warm to ink-teal on hover.
                    cur
                      ? "seaglass-active"
                      : "text-slate-600 hover:bg-white/70 hover:text-[color:rgb(var(--glass-ink))]"
                  }`}
                >
                  <CIcon className="relative z-10 h-4 w-4 shrink-0" />
                  <span className="relative z-10 truncate">{c.label}</span>
                </Link>
              );
            })}
          </nav>
        )}
      </div>

      {/* ── MOBILE (below shell:): the same section tiles, pinned to the bottom as a glass bar ── */}
      <nav
        // transform:translateZ(0) keeps the bar from drifting during iOS momentum scroll.
        style={{ transform: "translateZ(0)", WebkitBackfaceVisibility: "hidden" }}
        // Cap the home-indicator inset so a big safe-area on some iPhones doesn't
        // make the dock tower over its 9px labels (bug: "dock bigger than other screens").
        // gap-1 SEPARATES the tiles so the lit pill no longer touches its neighbor; the
        // balanced pt-1 / safe-area-floored pb keeps the content vertically centered above
        // the home indicator instead of riding high with dead space below it.
        className="app-bottom-nav glass fixed inset-x-2 bottom-2 z-[70] flex items-center gap-1 rounded-2xl border-white/40 px-1 pt-1 pb-[max(0.25rem,min(env(safe-area-inset-bottom),0.5rem))] shell:hidden"
      >
        {sections.map((s) => {
          const Icon = s.icon;
          const onRoute = s.key === active?.key;
          return (
            <Link
              key={s.key}
              href={s.href}
              // gap-1 (not 0.5) between icon and label for readability; 10px label (not 9px)
              // reads better in the field and still fits all tiles at 375px.
              className={`relative flex flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-[10px] font-medium ${
                // Same `.seaglass-active` fill (tint + gloss + ink) as the desktop rail tile.
                // Icon+label carry `relative z-10` to sit above the gloss sheen.
                onRoute ? "seaglass-active" : "text-slate-600"
              }`}
              aria-label={s.label}
            >
              <Icon className="relative z-10 h-[18px] w-[18px] shrink-0" />
              <span className="relative z-10 whitespace-nowrap leading-none">{s.short ?? s.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
