import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Tabs } from "@/components/tabs";
import { PriceListManager } from "./price-list-manager";
import { KitsManager } from "./kits-manager";

export const dynamic = "force-dynamic";

export default async function PriceListPage() {
  const supabase = await createClient();
  const [{ data: items }, { data: kits }] = await Promise.all([
    supabase
      .from("price_list_items")
      .select("id, code, description, category, supplier, unit, buy_price, markup_pct")
      .eq("archived", false)
      .order("description")
      .limit(2000),
    supabase
      .from("kits")
      .select("id, name, category, kit_items(id, description, quantity, unit, unit_price, sort_order)")
      .order("name"),
  ]);

  const priceItems = items ?? [];

  return (
    <div>
      <PageHeader
        title="Price List & Kits"
        description="Your priced catalog and reusable bundles — drop them onto quotes. Import a supplier list (e.g. CED) via CSV."
      />
      <Tabs
        tabs={[
          {
            id: "items",
            label: "Price List",
            count: priceItems.length,
            content: <PriceListManager items={priceItems as any} />,
          },
          {
            id: "kits",
            label: "Kits",
            count: (kits ?? []).length,
            content: <KitsManager kits={(kits ?? []) as any} priceItems={priceItems as any} />,
          },
        ]}
      />
    </div>
  );
}
