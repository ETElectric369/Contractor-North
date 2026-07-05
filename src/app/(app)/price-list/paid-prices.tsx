"use client";

import { useState, useTransition } from "react";
import { Search, Receipt, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { searchMyPrices } from "./actions";
import type { LearnedPrice } from "@/lib/pricing/learned-prices";

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

/**
 * "What I've paid" — the learn-from-bills price book. Search what THIS company has actually paid for
 * a material, derived live from the line items on their entered bills (real net cost, self-updating).
 * Read-only; the data comes from searchMyPrices (staff-gated, RLS-scoped).
 */
export function PaidPrices() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LearnedPrice[] | null>(null);
  const [pending, start] = useTransition();

  function run(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    start(async () => {
      const res = await searchMyPrices(q);
      setResults(res.items);
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Your <strong>real</strong> material costs — learned from the bills you enter. Search a part to see what you last
        paid, your average, and the range. It updates itself every time you record a bill; nothing to import.
      </p>

      <form onSubmit={run} className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. 200A panel, romex 12-2, EV charger"
            className="pl-9"
          />
        </div>
        <Button type="submit" disabled={pending || !query.trim()}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
        </Button>
      </form>

      {results === null ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
          Search a material above to see what you&apos;ve paid.
        </p>
      ) : results.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
          <Receipt className="mx-auto mb-2 h-6 w-6 text-slate-300" />
          No purchase history yet for that. As you enter bills with this item, it&apos;ll show up here automatically.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                <th className="py-2 pr-3">Item</th>
                <th className="py-2 px-3 text-right">Last paid</th>
                <th className="py-2 px-3 text-right">Average</th>
                <th className="py-2 px-3 text-right">Range</th>
                <th className="py-2 px-3 text-right">Times</th>
                <th className="py-2 pl-3">Last purchase</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-medium text-slate-800">{r.item}</td>
                  <td className="py-2 px-3 text-right font-semibold text-slate-900">{usd(r.lastPrice)}</td>
                  <td className="py-2 px-3 text-right text-slate-600">{usd(r.avgPrice)}</td>
                  <td className="py-2 px-3 text-right text-slate-500">
                    {r.lowPrice === r.highPrice ? "—" : `${usd(r.lowPrice)}–${usd(r.highPrice)}`}
                  </td>
                  <td className="py-2 px-3 text-right text-slate-500">{r.timesBought}</td>
                  <td className="py-2 pl-3 text-slate-500">
                    {r.lastDate ?? "—"}
                    {r.lastSupplier ? <span className="text-slate-400"> · {r.lastSupplier}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
