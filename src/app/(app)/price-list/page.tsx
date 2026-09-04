import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Tabs } from "@/components/tabs";
import { getOrgSettings } from "@/lib/org-settings";
import { measurementOptions } from "@/lib/playbook/measurements";
import { playbookForForm } from "@/lib/playbook/parse";
import { UNIT_DATALIST_ID, UNIT_SUGGESTIONS } from "@/lib/pricing/units";
import { firstThatWorks, kitsSelectRungs, type KitLineRaw } from "@/lib/kit-line";
import type { PriceItem } from "./price-list-math";
import { PriceListManager } from "./price-list-manager";
import { KitsManager } from "./kits-manager";
import { PaidPrices } from "./paid-prices";

export const dynamic = "force-dynamic";

// Every NEW column (0240) is requested FIRST and the query RETRIED without it — a deploy lands
// before its migration, and naming an absent column fails the whole query rather than degrading,
// which would empty the page until the migration ran. Same pattern the kits query used for 0166.
const ITEM_BASE = "id, code, description, category, supplier, unit, buy_price, markup_pct, updated_at, archived";
const ITEM_SIZING = "qty_per_sqft, qty_per_lf, qty_min, qty_round";
// 0241: the generic "counted per" pair — tried first, retried without.
const ITEM_SIZING_V2 = `${ITEM_SIZING}, sized_by, qty_per`;

/** A kit as THE SHARED SELECT SHAPE (lib/kit-line.ts) hands it over — the same three-rung select
 *  the quote pages run, so a kit line prices identically here and on an estimate. */
type KitRow = { id: string; name: string; category: string | null; kit_items: (KitLineRaw & { id: string })[] };

export default async function PriceListPage() {
  const supabase = await createClient();
  const [itemsRes, kitsRes, { data: org }] = await Promise.all([
    (async () => {
      // Active rows first so the cap trims archived ones, never live ones.
      const withV2 = await supabase
        .from("price_list_items")
        .select(`${ITEM_BASE}, ${ITEM_SIZING_V2}`)
        .order("archived")
        .order("description")
        .limit(2000);
      if (!withV2.error) return { data: withV2.data, sizingAvailable: true };
      const withSizing = await supabase
        .from("price_list_items")
        .select(`${ITEM_BASE}, ${ITEM_SIZING}`)
        .order("archived")
        .order("description")
        .limit(2000);
      if (!withSizing.error) return { data: withSizing.data, sizingAvailable: true };
      const base = await supabase.from("price_list_items").select(ITEM_BASE).order("archived").order("description").limit(2000);
      return { data: base.data, sizingAvailable: false };
    })(),
    // Three rungs of tolerance: (1) full, (2) without the 0240 link, (3) the pre-0166 base.
    firstThatWorks(kitsSelectRungs("id, name, category").map((sel) => () => supabase.from("kits").select(sel).order("name"))),
    // default_markup_pct rides to both tabs so a row's Sell and a kit line picked from the book
    // price through THE markup rule (item → org default), not the item's raw markup alone.
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  // 0241: what THIS company can count an item by — every form's playbook, measured number needs.
  // Best-effort: no forms (or a pre-playbook org) just means the two built-in dimensions.
  const { data: formRows } = await supabase.from("forms").select("schema, playbook").limit(20);
  const measurements = measurementOptions(((formRows ?? []) as { schema?: unknown; playbook?: unknown }[]).map((f) => playbookForForm(f)));
  const defaultMarkupPct = getOrgSettings((org as { settings?: unknown } | null)?.settings).default_markup_pct;

  const allItems = ((itemsRes.data ?? []) as unknown) as PriceItem[];
  const activeItems = allItems.filter((i) => !i.archived);
  const kits = ((kitsRes.data ?? []) as unknown) as KitRow[];

  // itemId → the kits that link to it, so a row can say where it's used.
  const kitsByItem: Record<string, string[]> = {};
  for (const k of kits) {
    for (const line of k.kit_items ?? []) {
      const id = line.price_list_item_id;
      if (!id) continue;
      (kitsByItem[id] ??= []).push(k.name);
    }
  }
  for (const id of Object.keys(kitsByItem)) kitsByItem[id] = [...new Set(kitsByItem[id])].sort();

  return (
    <div>
      <PageHeader
        title="Price List"
        description="Your priced catalog and reusable kits — cost, markup and sell, ready for estimates. Import a supplier list (e.g. CED) via CSV."
      />
      {/* ONE unit vocabulary, one list: every unit input on the page points at this datalist. */}
      <datalist id={UNIT_DATALIST_ID}>
        {UNIT_SUGGESTIONS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
      <Tabs
        tabs={[
          {
            id: "items",
            label: "Price List",
            count: activeItems.length,
            content: (
              <PriceListManager
                items={allItems}
                defaultMarkupPct={defaultMarkupPct}
                kitsByItem={kitsByItem}
                kits={kits.map((k) => ({ id: k.id, name: k.name }))}
                measurements={measurements}
                sizingAvailable={itemsRes.sizingAvailable}
              />
            ),
          },
          {
            id: "kits",
            label: "Kits",
            count: kits.length,
            content: <KitsManager kits={kits} priceItems={activeItems} defaultMarkupPct={defaultMarkupPct} measurements={measurements} />,
          },
          {
            id: "paid",
            label: "What I've Paid",
            content: <PaidPrices />,
          },
        ]}
      />
    </div>
  );
}
