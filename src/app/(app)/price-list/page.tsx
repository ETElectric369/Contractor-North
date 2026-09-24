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
import { VendorsManager } from "./vendors-manager";
import { knownVendorNames, summarizeVendors, type ItemOption, type VendorCard } from "./item-options-math";

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

/** 0282's vendor options, as the screen classifies them. THE PROJECTION LAW: every field the
 *  option row, the modal and the sell-price resolution read has to be named right here, or it is
 *  undefined at runtime with nothing to show for it. */
const OPTION_SELECT = "id, item_id, vendor, label, part_number, unit, buy_price, markup_pct, is_default, archived, sort_order";
/** 0296's vendor cards: how to reach each vendor (the brand), once per name. */
const CARD_SELECT = "id, name, contact_name, phone, email, website, address, notes, archived";

export default async function PriceListPage() {
  const supabase = await createClient();
  const [itemsRes, kitsRes, { data: org }, optionsRes, cardsRes] = await Promise.all([
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
    // 0282 is a whole NEW TABLE, so the same rule the new columns above follow applies harder: a
    // deploy that lands before its migration must degrade, not blank the page. An error here just
    // means "no options yet as far as this deploy can tell", and the tab stays away rather than
    // offering a door that opens onto a database error.
    supabase.from("price_list_item_options").select(OPTION_SELECT).order("item_id").order("sort_order").limit(2000),
    // 0296 is a new table too: absent = no contact cards yet, and the Vendors tab still lists every
    // vendor from the items, with the contact boxes switched off and saying why.
    supabase.from("price_list_vendors").select(CARD_SELECT).order("name").limit(2000),
  ]);
  // 0241: what THIS company can count an item by — every form's playbook, measured number needs.
  // Best-effort: no forms (or a pre-playbook org) just means the two built-in dimensions.
  // Ordered and paged past the old cap of 20 (audit v921): an unordered .limit(20) handed back an
  // ARBITRARY 20 of an org's forms, so a need defined in the 21st vanished from "How It's Counted"
  // — and an item already sized by it read as a plain fixed quantity, differently between requests.
  const { data: formRows } = await supabase
    .from("forms")
    .select("schema, playbook")
    .order("created_at", { ascending: true })
    .limit(500);
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

  // 0282 VENDOR OPTIONS. PostgREST hands `numeric` back as a STRING, and the screen does real
  // arithmetic with these — so the coercion happens once, here at the read boundary, rather than
  // in four components that would each have to remember. markup_pct keeps its NULL: null is "not
  // stated", which falls through to the item and then the org default, and a 0 here would quietly
  // sell at cost forever (that fall-through is the whole point of the nullable column).
  const optionsAvailable = !optionsRes.error;
  const options: ItemOption[] = ((optionsRes.data ?? []) as Record<string, unknown>[]).map((o) => ({
    id: String(o.id),
    item_id: String(o.item_id),
    vendor: String(o.vendor ?? ""),
    label: (o.label as string | null) ?? null,
    part_number: (o.part_number as string | null) ?? null,
    unit: (o.unit as string | null) ?? null,
    buy_price: Number(o.buy_price) || 0,
    markup_pct: o.markup_pct === null || o.markup_pct === undefined ? null : Number(o.markup_pct),
    is_default: Boolean(o.is_default),
    archived: Boolean(o.archived),
    sort_order: Number(o.sort_order) || 0,
  }));
  const optionsByItem: Record<string, ItemOption[]> = {};
  for (const o of options) (optionsByItem[o.item_id] ??= []).push(o);
  // Archived options still ride in optionsByItem so they stay findable (and restorable) on their
  // item's sheet.
  // VENDORS ARE BRANDS (Erik for Justin, 2026-09-24: "vendor means what brand with its own cost and
  // sell price"). One per name across every item, with its card when it has one.
  const cardsAvailable = !cardsRes.error;
  const cards: VendorCard[] = ((cardsRes.data ?? []) as Record<string, unknown>[]).map((c) => ({
    id: String(c.id),
    name: String(c.name ?? ""),
    contact_name: (c.contact_name as string | null) ?? null,
    phone: (c.phone as string | null) ?? null,
    email: (c.email as string | null) ?? null,
    website: (c.website as string | null) ?? null,
    address: (c.address as string | null) ?? null,
    notes: (c.notes as string | null) ?? null,
    archived: Boolean(c.archived),
  }));
  const vendors = summarizeVendors(options, allItems, cards, defaultMarkupPct);
  const knownVendors = knownVendorNames(options, cards);

  return (
    <div>
      <PageHeader
        title="Price List"
        description={
          "Your priced catalog and reusable kits — cost, markup and sell, ready for estimates. Import a supplier list (e.g. CED) via CSV." +
          // Only said when the tab is actually there — copy never names a control that doesn't exist.
          (optionsAvailable ? " Click any item to give it vendors (the brand, e.g. Andersen), each with its own cost and sell." : "")
        }
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
                optionsByItem={optionsAvailable ? optionsByItem : null}
                knownVendors={knownVendors}
              />
            ),
          },
          // VENDORS (0282 + 0296), next to the book they belong to. The tab id stays "options" so a
          // link to the old "Vendor Options" tab still lands here.
          ...(optionsAvailable
            ? [
                {
                  id: "options",
                  label: "Vendors",
                  count: vendors.length,
                  content: (
                    <VendorsManager
                      vendors={vendors}
                      items={activeItems}
                      optionsByItem={optionsByItem}
                      knownVendors={knownVendors}
                      defaultMarkupPct={defaultMarkupPct}
                      cardsAvailable={cardsAvailable}
                    />
                  ),
                },
              ]
            : []),
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
