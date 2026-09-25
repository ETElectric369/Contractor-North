import Link from "next/link";
import { redirect } from "next/navigation";
import { Boxes, AlertTriangle, Search } from "lucide-react";
import { requireStaff } from "@/lib/staff-guard";
import { isMissingShelf } from "@/lib/job-cost";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { ItemActions } from "./item-actions";
import { sanitizeSearch } from "@/lib/utils";
import type { InventoryItem } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * WHAT IS ON HAND, WHAT IT COST, WHERE IT CAME FROM, AND WHAT IS RUNNING OUT.
 *
 * This page had zero rows to show for the whole life of the app, because nothing ever put a row
 * in it. The shelf is a ledger now (lib/stock-ledger.ts, 0303): a roll ARRIVES from a receipt line
 * with what it cost, and pieces LEAVE onto a job at what they cost, so the count moves when the
 * money moves and there is no separate list to remember to keep.
 *
 * So the page had to earn its keep. Erik reads it on a phone, in a truck, usually to answer one
 * of two questions: "have I got any of these" and "what am I about to run out of". Hence the
 * reorder filter, the count as the biggest thing in the row, and the provenance line under the
 * name saying what the last box cost.
 *
 * OFFICE ONLY, ON THE SERVER (Shop Stock, 0302). The dock hid this page from a tech, and the table
 * behind it let any member read it: a hidden link is a convention, not a refusal. requireStaff is
 * the refusal, and 0302 made the table itself staff-only to read.
 *
 * NO DOOR IN YET, SO NO BUTTON THAT PRETENDS ONE (review of Shop Stock Phase 1). Until Phase 2 ships
 * Put On The Shelf, nothing in the app can move an item's count, so New Item is not offered: an item
 * made now would sit at 0 on hand (and read "Reorder" forever if it had a reorder point). The page
 * says the limit in words instead. new-item-button.tsx comes back with the Phase 2 door.
 *
 * WHAT IT IS WORTH COMES FROM THE SHELF'S RECORD (0303). On hand is the ledger's (rolls in, pieces
 * out) and never typed; value is every live roll's dollars left, to the cent, straight off the
 * paper - not a rounded unit cost times a count, which read a 500-count box of nuts $1.64 high.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; low?: string }>;
}) {
  const { q, low } = await searchParams;
  const lowOnly = low === "1";
  const ctx = await requireStaff();
  if ("error" in ctx) redirect("/planner");
  const { supabase } = ctx;

  // Named columns, never "*": the projection law, and a cost column added later must not reach a
  // page by default.
  let query = supabase
    .from("inventory_items")
    .select("id, name, part_number, description, category, unit, quantity_on_hand, reorder_point, vendor, location, active, created_at, updated_at, org_id")
    .eq("active", true)
    .order("name");

  const term = sanitizeSearch(q);
  if (term) {
    query = query.or(
      `name.ilike.%${term}%,part_number.ilike.%${term}%,category.ilike.%${term}%,vendor.ilike.%${term}%`,
    );
  }

  const [{ data }, lots] = await Promise.all([
    query,
    supabase.from("stock_lot_balance").select("item_id, cost_left").eq("live", true).limit(50000),
  ]);
  // No shelf ledger yet (a database before 0303) means no rolls; any other failure is said, never
  // read as a shelf worth $0.
  const lotsReadFailed = !!lots.error && !isMissingShelf(lots.error);
  const valueByItem = new Map<string, number>();
  for (const l of ((lots.error ? [] : lots.data) ?? []) as { item_id: string; cost_left: unknown }[]) {
    valueByItem.set(l.item_id, Math.round(((valueByItem.get(l.item_id) ?? 0) + (Number(l.cost_left) || 0)) * 100) / 100);
  }
  // Number() everything the comparisons below touch. These arrive as JSON numbers today, but the
  // Supabase client is untyped and the failure mode is silent rather than loud: "9.00" <= "10.00"
  // is FALSE as strings, which is the item that is nearly out missing off the one list that
  // exists to catch it.
  const items = ((data ?? []) as unknown as InventoryItem[]).map((i) => ({
    ...i,
    quantity_on_hand: Number(i.quantity_on_hand ?? 0),
    reorder_point: Number(i.reorder_point ?? 0),
    unit_cost: null,
  }));

  const isLow = (i: InventoryItem) => i.reorder_point > 0 && i.quantity_on_hand <= i.reorder_point;
  const lowStock = items.filter(isLow);
  const totalValue = items.reduce((s, i) => s + (valueByItem.get(i.id) ?? 0), 0);

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
      />

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
                {lotsReadFailed ? "—" : formatCurrency(totalValue)}
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
                : "Rolls and boxes you keep for more than one job will live here, with what they cost. Putting a roll on the shelf from a receipt comes in the next update; until then there is nothing to add here."
          }
        >
          {(lowOnly || q) && (
            <Link href={withQuery({})} className={`${linkClass} border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}>
              Show All
            </Link>
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
                    <span className="text-xs text-slate-500">{costLine(it, valueByItem.get(it.id))}</span>
                    <OnHand quantity={it.quantity_on_hand} unit={it.unit} />
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
                    <th className="px-3 py-3 text-right font-semibold">Value</th>
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
                        {valueByItem.has(it.id) ? formatCurrency(valueByItem.get(it.id) ?? 0) : "—"}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <OnHand quantity={it.quantity_on_hand} unit={it.unit} />
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

          <p className="mt-3 max-w-2xl text-xs text-slate-400">
            {lotsReadFailed
              ? "The value of what is on the shelf couldn't be read just now, so none is shown. Reload to try again."
              : "Stock value is what the rolls and boxes on the shelf cost, off their receipts to the cent, less what has been taken off them. Putting rolls on the shelf and taking pieces off it come in the next update; until then these counts don't move."}
          </p>
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

function costLine(it: InventoryItem, value: number | undefined): string {
  const cost = value != null ? `${formatCurrency(value)} on the shelf` : "Nothing on the shelf's record";
  return it.vendor ? `${cost} · ${it.vendor}` : cost;
}

/** How many are on hand: the shelf's record, read only. Counting it is a recount move (Phase 2). */
function OnHand({ quantity, unit }: { quantity: number; unit: string }) {
  return (
    <span className="text-base font-semibold tabular-nums text-slate-900">
      {Number.isInteger(quantity) ? quantity : Math.round(quantity * 1000) / 1000} <span className="text-xs font-normal text-slate-500">{unit}</span>
    </span>
  );
}

function withQuery(params: { q?: string; low?: string }): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.low) sp.set("low", params.low);
  const s = sp.toString();
  return s ? `/inventory?${s}` : "/inventory";
}
