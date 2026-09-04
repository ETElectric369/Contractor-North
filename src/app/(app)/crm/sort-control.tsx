"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SortFilterBar, useSortFilter } from "@/components/sort-filter-bar";
import type { SortSpec } from "@/lib/sort-filter";
import {
  CRM_DEFAULT_SORT,
  CRM_SORT_OPTIONS,
  formatCrmSort,
  isCrmSortKey,
  isDefaultCrmSort,
  naturalCrmDir,
  parseCrmSort,
} from "@/lib/crm-order";

/**
 * THE CONTACTS SORT CONTROL (Andrew: "Sorting ABCD or otherwise"). The URL is the truth — the
 * server page orders the query from ?sort=, so the bar reads its state from the URL and every
 * change is a router.push that keeps ?q. localStorage only remembers the last choice so a plain
 * visit to /crm (nav link, no ?sort=) lands on it: ONE router.replace on mount, guarded by a ref,
 * and only when the remembered choice is not already the default. No loops — a URL that carries
 * ?sort= is never rewritten.
 *
 * Leads and jobs will copy this exact shape; the price list applies the same bar in memory.
 */
export function SortControl() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawSort = searchParams.get("sort");
  const current = parseCrmSort(rawSort);
  const { prefs, update, loaded } = useSortFilter("crm", { sort: CRM_DEFAULT_SORT, group: null, chips: [] });

  const go = (spec: SortSpec, mode: "push" | "replace") => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("sort", formatCrmSort(spec));
    const url = `${pathname}?${params.toString()}`;
    if (mode === "push") router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
  };

  // Remembered choice → URL, once. prefs come out of localStorage unconstrained (an old key from a
  // future version, say) so they go through the parser like any other untrusted string.
  const redirected = useRef(false);
  useEffect(() => {
    if (!loaded || redirected.current) return;
    redirected.current = true;
    if (rawSort) return;
    const remembered = parseCrmSort(prefs.sort ? formatCrmSort(prefs.sort) : undefined);
    if (isDefaultCrmSort(remembered)) return;
    go(remembered, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  return (
    <SortFilterBar
      sortOptions={CRM_SORT_OPTIONS}
      prefs={{ sort: current, group: null, chips: [] }}
      className="shrink-0"
      onChange={(patch) => {
        if (!("sort" in patch)) return;
        // "Default" in the bar IS name A→Z here; an unknown key can only come from the bar's own
        // option list, but the parser is the one gate for every spec regardless.
        let next: SortSpec = CRM_DEFAULT_SORT;
        if (patch.sort && isCrmSortKey(patch.sort.key)) {
          // A new KEY lands on that key's natural direction (Recently Added → newest first); the
          // bar carries the old direction across, which is not a choice anyone made. Same key
          // means the toggle was tapped — honour it.
          const dir = patch.sort.key === current.key ? patch.sort.dir : naturalCrmDir(patch.sort.key);
          next = { key: patch.sort.key, dir };
        }
        if (next.key === current.key && next.dir === current.dir) return;
        update({ sort: next });
        go(next, "push");
      }}
    />
  );
}
