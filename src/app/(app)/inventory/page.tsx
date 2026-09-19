import Link from "next/link";
import { Boxes, AlertTriangle, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { NewItemButton } from "./new-item-button";
import { QtyControl } from "./qty-control";
import { ItemActions } from "./item-actions";
import { sanitizeSearch } from "@/lib/utils";
import type { InventoryItem } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * WHAT IS ON HAND, WHAT IT COST, WHERE IT CAME FROM, AND WHAT IS RUNNING OUT.
 *
 * This page had zero rows to show for the whole life of the app, because nothing ever put a row
 * in it. cn-v964 changed that: stock ARRIVES from a receipt line marked as the company's own
 * container (lib/stock-flow.ts, migration 0272) and LEAVES when it goes on a job, so the count
 * moves when the money moves and there is no separate list to remember to keep.
 *
 * So the page had to earn its keep. Erik reads it on a phone, in a truck, usually to answer one
 * of two questions: "have I got any of these" and "what am I about to run out of". Hence the
 * reorder filter, the count as the biggest thing in the row, and the provenance line under the
 * name saying what the last box cost.
 *
 * THE FOOTNOTE IS NOT AN APOLOGY, IT IS THE HONEST PART. `unit_cost` is numeric(12,2), so a nut
 * that truly costs $0.21672 is stored as $0.22 and 500 of them multiply back out to $110.00 for a
 * box that cost $108.36. A page that prints a total has to say what the total is made of, or it
 * is a confidently wrong number - which is the one thing a stock list must never be.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; low?: string }>;
}) {
  const { q, low } = await searchParams;
  const lowOnly = low === "1";
  const supabase = await createClient();

  let query = supabase
    .from("inventory_items")
    .select("*")
    .eq("active", true)
    .order("name");

  const term = sanitizeSearch(q);
  if (term) {
    query = query.or(
      `name.ilike.%${term}%,part_number.ilike.%${term}%,category.ilike.%${term}%,vendor.ilike.%${term}%`,
    );
  }

  const { data } = await query;
  // Number() everything the comparisons below touch. These arrive as JSON numbers today, but the
  // Supabase client is untyped and the failure mode is silent rather than loud: "9.00" <= "10.00"
  // is FALSE as strings, which is the item that is nearly out missing off the one list that
  // exists to catch it.
  const items = ((data ?? []) as InventoryItem[]).map((i) => ({
    ...i,
    quantity_on_hand: Number(i.quantity_on_hand ?? 0),
    reorder_point: Number(i.reorder_point ?? 0),
    unit_cost: i.unit_cost == null ? null : Number(i.unit_cost),
  }));

  const isLow = (i: InventoryItem) => i.reorder_point > 0 && i.quantity_on_hand <= i.reorder_point;
  const lowStock = items.filter(isLow);
  const priced = items.filter((i) => i.unit_cost != null);
  const totalValue = priced.reduce((s, i) => s + (i.unit_cost ?? 0) * i.quantity_on_hand, 0);
  const unpriced = items.length - priced.length;

  // What is running out goes first, because that is the half of this page that is urgent.
  const shown = (lowOnly ? lowStock : items)
    .slice()
    .sort((a, b) => Number(isLow(b)) - Number(isLow(a)) || a.name.localeCompare(b.name));

  const linkClass =
    "inline-flex min-h-[44px] items-center rounded-lg border px-4 text-sm font-medium transition-colors";

  return (
    <div>
      <PageHeader
        title="Inventory"
        description="What's on hand, what it cost, and what's running low."
      >
        <NewItemButton />
      </PageHeader>

      {items.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-3 sm:max-w-lg sm:gap-4">
          <Card>
            <CardContent className="py-4">
              <div className="text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">{items.length}</div>
              <div className="text-xs text-slate-500">Items</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">
                {formatCurrency(totalValue)}
              </div>
              <div className="text-xs text-slate-500">Stock value</div>
            </CardContent>
          </Card>
          <Card className={lowStock.length ? "border-amber-200 bg-amber-50" : ""}>
            <CardContent className="py-4">
              <div className="text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">{lowStock.length}</div>
              <div className="text-xs text-slate-500">Need reordering</div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form className="min-w-0 flex-1">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input name="q" defaultValue={q} placeholder="Search inventory…" className="pl-9" />
            {/* Keep the reorder filter on while he searches inside it. */}
            {lowOnly && <input type="hidden" name="low" value="1" />}
          </div>
        </form>
        {(lowStock.length > 0 || lowOnly) && (
          <Link
            href={lowOnly ? withQuery({ q }) : withQuery({ q, low: "1" })}
            className={
              lowOnly
                ? `${linkClass} border-amber-300 bg-amber-100 text-amber-900`
                : `${linkClass} border-slate-200 bg-white text-slate-600 hover:bg-slate-50`
            }
          >
            {lowOnly ? "Show All" : `Need Reordering (${lowStock.length})`}
          </Link>
        )}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={lowOnly ? "Nothing needs reordering" : q ? "No matches" : "Nothing in stock yet"}
          description={
            lowOnly
              ? "Everything with a reorder point set is above it."
              : q
                ? "Try a different search."
                : "Stock lands here from your receipts: a receipt line that's a whole container you'll use across jobs, marked as the company's own, shows up here with what you paid for it. You can also add an item by hand."
          }
        >
          {lowOnly || q ? (
            <Link href={withQuery({})} className={`${linkClass} border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}>
              Show All
            </Link>
          ) : (
            <NewItemButton />
          )}
        </EmptyState>
      ) : (
        <>
          <Card className="overflow-hidden">
            {/* PHONE: one card per item, no sideways scrolling, count on the right where his
                thumb already is. */}
            <ul className="divide-y divide-slate-100 sm:hidden">
              {shown.map((it) => (
                <li key={it.id} className={isLow(it) ? "bg-amber-50/40 px-4 py-3" : "px-4 py-3"}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                        {it.name}
                        {isLow(it) && (
                          <Badge tone="amber" className="gap-1">
                            <AlertTriangle className="h-3 w-3" /> Reorder
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-slate-400">{subtitle(it)}</div>
                    </div>
                    <ItemActions item={it} />
                  </div>
                  {it.description && (
                    <p className="mt-1 text-xs text-slate-500">{it.description}</p>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-500">{costLine(it)}</span>
                    <QtyControl id={it.id} name={it.name} quantity={it.quantity_on_hand} unit={it.unit} />
                  </div>
                </li>
              ))}
            </ul>

            {/* DESK: the same facts, wider. */}
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Item</th>
                    <th className="px-3 py-3 font-semibold">Where it came from</th>
                    <th className="px-3 py-3 text-right font-semibold">Unit cost</th>
                    <th className="px-5 py-3 text-right font-semibold">On hand</th>
                    <th className="px-3 py-3 text-right font-semibold" aria-label="Actions"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shown.map((it) => (
                    <tr key={it.id} className={isLow(it) ? "bg-amber-50/40" : ""}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2 font-medium text-slate-900">
                          {it.name}
                          {isLow(it) && (
                            <Badge tone="amber" className="gap-1">
                              <AlertTriangle className="h-3 w-3" /> Reorder
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-slate-400">{subtitle(it)}</div>
                      </td>
                      <td className="px-3 py-3 text-slate-600">
                        <div>{it.vendor ?? "—"}</div>
                        {it.description && (
                          <div className="max-w-sm text-xs text-slate-400">{it.description}</div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-600">
                        {it.unit_cost != null ? `${formatCurrency(it.unit_cost)} each` : "—"}
                      </td>
                      <td className="px-5 py-3">
                        <QtyControl id={it.id} name={it.name} quantity={it.quantity_on_hand} unit={it.unit} />
                      </td>
                      <td className="px-3 py-3">
                        <ItemActions item={it} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {priced.length > 0 && (
            <p className="mt-3 max-w-2xl text-xs text-slate-400">
              Stock value is each item&rsquo;s unit cost times what&rsquo;s on hand. Unit cost is stored to the
              cent, so a big box of small parts can read a dollar or two high.
              {unpriced > 0 &&
                ` ${unpriced} ${unpriced === 1 ? "item has" : "items have"} no unit cost yet, so ${unpriced === 1 ? "it isn't" : "they aren't"} counted in it.`}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Part number, category and where it lives, in whatever order they exist. */
function subtitle(it: InventoryItem): string {
  return [it.part_number ? `#${it.part_number}` : null, it.category, it.location]
    .filter(Boolean)
    .join(" · ");
}

function costLine(it: InventoryItem): string {
  const cost = it.unit_cost != null ? `${formatCurrency(it.unit_cost)} each` : "No unit cost yet";
  return it.vendor ? `${cost} · ${it.vendor}` : cost;
}

function withQuery(params: { q?: string; low?: string }): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.low) sp.set("low", params.low);
  const s = sp.toString();
  return s ? `/inventory?${s}` : "/inventory";
}
