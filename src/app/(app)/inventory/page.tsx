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

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("inventory_items")
    .select("*")
    .eq("active", true)
    .order("name");

  const term = sanitizeSearch(q);
  if (term) {
    query = query.or(
      `name.ilike.%${term}%,part_number.ilike.%${term}%,category.ilike.%${term}%`,
    );
  }

  const { data } = await query;
  const items = (data ?? []) as InventoryItem[];

  const lowStock = items.filter(
    (i) => i.reorder_point > 0 && i.quantity_on_hand <= i.reorder_point,
  );
  const totalValue = items.reduce(
    (s, i) => s + (i.unit_cost ?? 0) * i.quantity_on_hand,
    0,
  );

  return (
    <div>
      <PageHeader title="Inventory" description="Stock on hand across the shop and trucks.">
        <NewItemButton />
      </PageHeader>

      {items.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-4 sm:max-w-lg">
          <Card>
            <CardContent className="py-4">
              <div className="text-2xl font-bold text-slate-900">{items.length}</div>
              <div className="text-xs text-slate-500">Items</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="text-2xl font-bold text-slate-900">
                {formatCurrency(totalValue)}
              </div>
              <div className="text-xs text-slate-500">Stock value</div>
            </CardContent>
          </Card>
          <Card className={lowStock.length ? "border-amber-200 bg-amber-50" : ""}>
            <CardContent className="py-4">
              <div className="text-2xl font-bold text-slate-900">{lowStock.length}</div>
              <div className="text-xs text-slate-500">Low stock</div>
            </CardContent>
          </Card>
        </div>
      )}

      <form className="mb-4">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input name="q" defaultValue={q} placeholder="Search inventory…" className="pl-9" />
        </div>
      </form>

      {items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={q ? "No matches" : "No inventory yet"}
          description={q ? "Try a different search." : "Add your first stock item."}
        >
          {!q && <NewItemButton />}
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-3 font-semibold">Item</th>
                <th className="px-3 py-3 font-semibold">Category</th>
                <th className="px-3 py-3 font-semibold">Location</th>
                <th className="px-3 py-3 text-right font-semibold">Unit cost</th>
                <th className="px-5 py-3 text-right font-semibold">On hand</th>
                <th className="px-3 py-3 text-right font-semibold" aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((it) => {
                const low =
                  it.reorder_point > 0 && it.quantity_on_hand <= it.reorder_point;
                return (
                  <tr key={it.id} className={low ? "bg-amber-50/40" : ""}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 font-medium text-slate-900">
                        {it.name}
                        {low && (
                          <Badge tone="amber" className="gap-1">
                            <AlertTriangle className="h-3 w-3" /> reorder
                          </Badge>
                        )}
                      </div>
                      {it.part_number && (
                        <div className="text-xs text-slate-400">#{it.part_number}</div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-slate-600">{it.category ?? "—"}</td>
                    <td className="px-3 py-3 text-slate-500">{it.location ?? "—"}</td>
                    <td className="px-3 py-3 text-right text-slate-600">
                      {it.unit_cost != null ? formatCurrency(it.unit_cost) : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <QtyControl id={it.id} name={it.name} quantity={it.quantity_on_hand} unit={it.unit} />
                    </td>
                    <td className="px-3 py-3">
                      <ItemActions item={it} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </Card>
      )}
    </div>
  );
}
