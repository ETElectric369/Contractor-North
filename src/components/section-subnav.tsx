"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { DOCK } from "@/lib/dock";

const basePath = (href: string) => href.split("?")[0];
// Jobs already shows its own status pills; skip it so it isn't doubled.
const SKIP = new Set(["jobs"]);

/** A persistent horizontal sub-nav at the top of a section's pages — the same menu
 *  that blooms from the dock, pinned in place (like the Jobs status pills). It figures
 *  out which section the current page belongs to and renders its sibling pages as tabs.
 *  Detail pages (no exact match) get none, so they keep their own tabs. */
export function SectionSubnav({ isStaff }: { isStaff?: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const current = pathname + (search.toString() ? `?${search.toString()}` : "");

  const section = DOCK.find(
    (s) =>
      !SKIP.has(s.key) &&
      (isStaff || !s.staffOnly) &&
      s.children.some((c) => c.href && basePath(c.href) === pathname),
  );
  if (!section) return null;
  const tabs = section.children.filter((c) => c.href && (isStaff || !c.staffOnly));
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
