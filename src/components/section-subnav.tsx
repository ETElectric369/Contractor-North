"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { DOCK, activeSection, basePath } from "@/lib/dock";
import { SectionSheet } from "./section-sheet";

/** The mobile sibling nav at the top of a section's pages. It figures out which section the
 *  current page belongs to (via the ONE shared matcher in src/lib/dock.ts) and renders its
 *  siblings — in one of TWO shapes, by how many there are:
 *
 *  ≤4 pages (Today, Clock, Sales…): the horizontal pill strip, flex-1 filling the full phone
 *  width — 2–4 pills share it evenly with no horizontal scroll, so they stay glanceable.
 *
 *  >4 pages (Jobs' 13, Office's 12, Money's 9): the strip died as a blind sideways scroll,
 *  so it's replaced 1:1 by <SectionSheet> — a slim left-edge handle (the one lit "where am
 *  I" chip) opening a vertical slide-over of the same pages, headers as dividers. Never
 *  both: when the handle renders, no strip does (zero duplication).
 *
 *  MOBILE-ONLY (lg:hidden): on desktop the dock's inside-left rail now lists every section's
 *  pages, so either shape would just double it. On phones (no left rail) it's the only
 *  sibling nav, so it stays — and it persists on detail/sub-routes too (/quotes/[id],
 *  /forms/[id], /purchasing/[id]…), not just on a section's exact landing pages. */
export function SectionSubnav({ isStaff }: { isStaff?: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const current = pathname + (search.toString() ? `?${search.toString()}` : "");

  const sections = DOCK.filter((s) => isStaff || !s.staffOnly);
  // THE shared matcher — the same section the dock tiles light, so the strip can never
  // vanish-by-accident on detail routes again (it did on /quotes/[id] but not /billing/[id]).
  const group = activeSection(pathname, sections);
  if (!group) return null;
  // The Jobs strip IS the mobile status filter on /jobs itself (the page's own pill copy is
  // gone) — but on a job's page (/jobs/[id]) it must NOT stack a second look-alike pill row
  // above the hub's own tabs, where tapping "In progress" silently ejected you off the job.
  // Scoped to the jobs group only so /billing/[id], /work-orders/[id] etc. keep their strips.
  if (group.key === "jobs" && pathname.startsWith("/jobs/")) return null;
  const tabs = group.children.filter((c) => c.href && (isStaff || !c.staffOnly));
  if (tabs.length < 2) return null;

  const exact = tabs.find((c) => c.href === current);
  const activeHref =
    exact?.href ?? tabs.find((c) => c.href && basePath(c.href) === pathname && !c.href.includes("?"))?.href;

  // The ADHD principle, doubled down responsively: past 4 pages the strip stops fitting a
  // phone width, so the long sections swap it for the left-edge handle + vertical sheet
  // (Erik: "if more than 4 side tab nav, looks great btw"). Headers ride along here (the
  // sheet renders them as dividers, like the desktop rail) — the strip below flattens them.
  if (tabs.length > 4) {
    return (
      <SectionSheet
        group={group}
        items={group.children.filter((c) => isStaff || !c.staffOnly)}
        activeHref={activeHref}
      />
    );
  }

  // 2–4 pages: a flex-1 row that fills the phone width evenly — no horizontal scroll (Erik:
  // "shrink to width of page so all of them fit, not have horizontal scroll"). Each pill grows
  // to an equal share; the label truncates while the icon stays put so nothing overflows.
  // The strip is now ONE sea-glass bar — the same glass/tint/gloss recipe as the
  // left-edge dock handle — so the responsive top nav matches the side nav (Erik).
  // Ink-teal text for the resting pills (visible + inviting on the tint); the active
  // page is a solid brand chip. `relative z-10` keeps the pills above the gloss sheen.
  return (
    <div className="glass glass-tint glass-gloss mb-4 flex w-full gap-1 rounded-2xl p-1 text-[color:rgb(var(--glass-ink))] lg:hidden">
      {tabs.map((c) => {
        const active = c.href === activeHref;
        const Icon = c.icon;
        return (
          <Link
            key={c.id}
            href={c.href!}
            className={`relative z-10 inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-brand text-white shadow-sm"
                : "hover:bg-white/60"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{c.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
