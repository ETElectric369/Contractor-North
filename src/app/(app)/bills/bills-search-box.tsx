"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { matchingKeys, searchBills, type BillsSearchRow } from "./bills-search";

type BillsSearch = {
  query: string;
  setQuery: (q: string) => void;
  /** Every row the page can find, the supplier's own papers included. */
  rows: BillsSearchRow[];
  /** The All Bills rows the query keeps, by key; null = no filter (the list shows everything). */
  keys: Set<string> | null;
};

/** Outside a provider: nothing typed and no filter. One object, so a hook that depends on it is stable. */
const NO_SEARCH: BillsSearch = { query: "", setQuery: () => {}, rows: [], keys: null };
const BillsSearchCtx = createContext<BillsSearch | null>(null);

/**
 * ONE QUERY FOR THE PAGE (W1-32): the box at the top and All Bills below read the same words, so
 * typing in the box filters the list in place. The rows are handed over once, here.
 */
export function BillsSearchProvider({
  rows,
  children,
  initialQuery = "",
}: {
  rows: BillsSearchRow[];
  children: ReactNode;
  /**
   * WHAT A DOOR SOMEWHERE ELSE ASKED TO HAVE LOOKED UP (`/bills?q=...`). /reconcile's rows name a
   * spelling and then send him here to answer that paper; linking to `#bills-search` alone scrolled
   * him to an empty box, so the door's own words had to be retyped from the screen he had just left.
   * It is a STARTING POINT and nothing more: he clears or retypes it like anything he typed himself,
   * and the URL is not rewritten behind him.
   */
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const listRows = useMemo(() => rows.filter((r) => r.kind !== "paper"), [rows]);
  const keys = useMemo(() => matchingKeys(listRows, query), [listRows, query]);
  const value = useMemo(() => ({ query, setQuery, rows, keys }), [query, rows, keys]);
  return <BillsSearchCtx.Provider value={value}>{children}</BillsSearchCtx.Provider>;
}

/** The page's query. Outside a provider (a list drawn on its own): nothing typed, no filter. */
export function useBillsSearch(): BillsSearch {
  return useContext(BillsSearchCtx) ?? NO_SEARCH;
}

/**
 * THE SEARCH BOX AT THE TOP OF /bills: number, street, job, supplier, bucket, or $. Typing filters
 * All Bills below in place (a bill, an order, a file); "business cost" or "fuel" keeps just those.
 * A supplier's own paper lives on its card, so it is a hit here that lands there. A hit with
 * nowhere to go says so rather than being a dead link.
 */
export function BillsSearchBox() {
  const { query, setQuery, rows, keys } = useBillsSearch();
  const papers = useMemo(() => rows.filter((r) => r.kind === "paper"), [rows]);
  const { hits, more } = useMemo(() => searchBills(papers, query), [papers, query]);
  const typed = keys !== null;
  const inList = keys?.size ?? 0;

  return (
    <div className="mb-4">
      <label htmlFor="bills-search" className="sr-only">
        Find a bill
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <Input
          id="bills-search"
          type="search"
          inputMode="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Bill number, street, job, supplier or $"
          className="h-11 pl-9 pr-11"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear The Search"
            className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-slate-400 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {typed && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-white" role="region" aria-live="polite" aria-label="What matched">
          {/* The list below is filtered in place: say how many it kept, with the way to them. */}
          {inList > 0 ? (
            <a href="#all-bills" className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50">
              <span className="text-slate-700">
                {inList} in All Bills {inList === 1 ? "matches" : "match"}
              </span>
              <span className="shrink-0 font-medium text-brand">Show Them</span>
            </a>
          ) : (
            <p className="px-3 py-3 text-sm text-slate-500">
              {hits.length ? "Nothing in All Bills matches" : "Nothing here matches"} &ldquo;{query.trim()}&rdquo;.
            </p>
          )}
          {hits.length > 0 && (
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {hits.map((h) => {
                const body = (
                  <>
                    <span className="block text-sm font-medium text-slate-900">
                      <span className="mr-1.5 text-xs font-normal text-slate-400">Supplier Paper</span>
                      {h.title}
                    </span>
                    <span className="block text-xs text-slate-500">{h.sub}</span>
                  </>
                );
                return (
                  <li key={h.key}>
                    {h.href ? (
                      h.href.startsWith("#") ? (
                        // Its card is on this page: FoldOpener opens the folds around it.
                        <a href={h.href} className="block min-h-11 px-3 py-2 hover:bg-slate-50">
                          {body}
                        </a>
                      ) : (
                        <Link href={h.href} className="block min-h-11 px-3 py-2 hover:bg-slate-50">
                          {body}
                        </Link>
                      )
                    ) : (
                      <div className="min-h-11 px-3 py-2">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {more > 0 && <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">{more} more supplier papers match. Type more to narrow it.</p>}
        </div>
      )}
    </div>
  );
}
