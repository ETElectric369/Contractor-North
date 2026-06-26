"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { DOCK, type DockNode } from "@/lib/dock";

const basePath = (href: string) => href.split("?")[0];
// Pages that render their OWN tab strip (Jobs status pills, Schedule's view tabs) — skip
// by PATH so there aren't two stacked tab bars (Schedule now lives under Clock, so a
// group-key skip would wrongly hide Clock's sub-nav too).
const SKIP_PATHS = new Set(["/jobs", "/schedule"]);

type Group = { key: string; staffOnly?: boolean; children: DockNode[] };

/** Every navigable group whose siblings should show as a sub-nav: a top-level section's
 *  leaf children (Today, Jobs, Clock, Money), AND each nested hub inside More (Schedule,
 *  Sales, Money admin, Office) — so a demoted page still gets its own sibling tabs. */
function navGroups(): Group[] {
  const out: Group[] = [];
  for (const s of DOCK) {
    const leaves = s.children.filter((c) => c.href && !c.children?.length);
    if (leaves.length) out.push({ key: s.key, staffOnly: s.staffOnly, children: leaves });
    for (const c of s.children) {
      if (c.children?.length) out.push({ key: c.id, staffOnly: s.staffOnly || c.staffOnly, children: c.children });
    }
  }
  return out;
}

/** A persistent horizontal sub-nav at the top of a section's pages — the siblings of the
 *  current page, pinned in place (like the Jobs status pills). It figures out which group
 *  the current page belongs to (top-level section OR a nested More hub) and renders its
 *  siblings as tabs. Detail pages (no exact match) get none, so they keep their own tabs. */
export function SectionSubnav({ isStaff }: { isStaff?: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const current = pathname + (search.toString() ? `?${search.toString()}` : "");

  if (SKIP_PATHS.has(pathname)) return null;
  const group = navGroups().find(
    (g) =>
      (isStaff || !g.staffOnly) &&
      g.children.some((c) => c.href && basePath(c.href) === pathname),
  );
  if (!group) return null;
  const tabs = group.children.filter((c) => c.href && (isStaff || !c.staffOnly));
  if (tabs.length < 2) return null;

  const exact = tabs.find((c) => c.href === current);
  const activeHref =
    exact?.href ?? tabs.find((c) => c.href && basePath(c.href) === pathname && !c.href.includes("?"))?.href;

  return (
    <div className="mb-4 -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
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
