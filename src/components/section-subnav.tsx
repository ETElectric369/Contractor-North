"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { DOCK, activeSection, basePath } from "@/lib/dock";

/** A persistent horizontal sub-nav at the top of a section's pages — the siblings of the
 *  current page, pinned in place. It figures out which section the current page belongs to
 *  (via the ONE shared matcher in src/lib/dock.ts) and renders its siblings as tabs (for
 *  Jobs: All + the 7 lifecycle statuses, cancelled last, then the staff cross-job links —
 *  the ONE mobile copy of that nav). Office gets the same strip as everyone: its group
 *  headers carry no href, so they flatten away and the pages scroll as pills, like Jobs'.
 *
 *  MOBILE-ONLY (lg:hidden): on desktop the dock's inside-left rail now lists every section's
 *  pages, so this strip would just double it. On phones (no left rail) it's the only sibling
 *  nav, so it stays — and it persists on detail/sub-routes too (/quotes/[id], /forms/[id],
 *  /purchasing/[id]…), not just on a section's exact landing pages. */
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

  return (
    <div className="mb-4 -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden">
      {tabs.map((c) => {
        const active = c.href === activeHref;
        const Icon = c.icon;
        return (
          <Link
            key={c.id}
            href={c.href!}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-brand text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            <Icon className="h-4 w-4" />
            {c.label}
          </Link>
        );
      })}
    </div>
  );
}
