"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { searchBills, type BillsSearchRow } from "./bills-search";

const KIND_WORD: Record<BillsSearchRow["kind"], string> = {
  paper: "Supplier Paper",
  bill: "Bill",
  file: "File",
};

/**
 * THE SEARCH BOX AT THE TOP OF /bills: number, street, job, what CED wrote, or $. Answers as he
 * types, over the papers the page already holds (bills-search.ts), and every hit says where it is
 * and taps through to it. A hit with nowhere to go says so rather than being a dead link.
 */
export function BillsSearchBox({ rows }: { rows: BillsSearchRow[] }) {
  const [query, setQuery] = useState("");
  const { hits, more } = useMemo(() => searchBills(rows, query), [rows, query]);
  const typed = query.trim().length >= 2;

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
          placeholder="Bill number, street, job or $"
          className="h-11 pl-9"
        />
      </div>
      {typed && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-white" role="region" aria-live="polite" aria-label="What matched">
          {hits.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-500">Nothing here matches &ldquo;{query.trim()}&rdquo;.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {hits.map((h) => {
                const body = (
                  <>
                    <span className="block text-sm font-medium text-slate-900">
                      <span className="mr-1.5 text-xs font-normal text-slate-400">{KIND_WORD[h.kind]}</span>
                      {h.title}
                    </span>
                    <span className="block text-xs text-slate-500">{h.sub}</span>
                  </>
                );
                return (
                  <li key={h.key}>
                    {h.href ? (
                      h.href.startsWith("http") ? (
                        <a href={h.href} target="_blank" rel="noopener noreferrer" className="block min-h-11 px-3 py-2 hover:bg-slate-50">
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
          {more > 0 && <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">{more} more match. Type more to narrow it.</p>}
        </div>
      )}
    </div>
  );
}
