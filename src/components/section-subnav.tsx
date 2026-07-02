"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { DOCK, type DockNode } from "@/lib/dock";

const basePath = (href: string) => href.split("?")[0];

type Group = { key: string; href: string; staffOnly?: boolean; children: DockNode[] };

/** The dock is flat now — each section is its own group, its pages are the sibling tabs. */
function navGroups(): Group[] {
  return DOCK.map((s) => ({ key: s.key, href: s.href, staffOnly: s.staffOnly, children: s.children }));
}

/** A persistent horizontal sub-nav at the top of a section's pages — the siblings of the
 *  current page, pinned in place. It figures out which group the current page belongs to
 *  and renders its siblings as tabs (for Jobs: All + the 7 lifecycle statuses, cancelled
 *  last, then the staff cross-job links — the ONE mobile copy of that nav).
 *
 *  MOBILE-ONLY (lg:hidden): on desktop the dock's inside-left rail now lists every section's
 *  pages, so this strip would just double it. On phones (no left rail) it's the only sibling
 *  nav, so it stays — and it now persists on detail/sub-routes too (href-prefix match, like the
 *  dock), not just on a section's exact landing pages. */
export function SectionSubnav({ isStaff }: { isStaff?: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const current = pathname + (search.toString() ? `?${search.toString()}` : "");

  const groups = navGroups().filter((g) => isStaff || !g.staffOnly);
  // Prefer an exact child-landing match; fall back to the owning section (href / prefix) so the
  // strip persists on a section's detail pages too.
  const group =
    groups.find((g) => g.children.some((c) => c.href && basePath(c.href) === pathname)) ??
    groups.find((g) => pathname === g.href || pathname.startsWith(g.href + "/"));
  if (!group) return null;
  // Office uses the phone bottom-nav slide-in drawer (its list is long), not a top strip.
  if (group.key === "office") return null;
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
