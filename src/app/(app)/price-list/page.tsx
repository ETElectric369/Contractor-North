import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { PriceListManager } from "./price-list-manager";

export const dynamic = "force-dynamic";

export default async function PriceListPage() {
  const supabase = await createClient();
  const { data: items } = await supabase
    .from("price_list_items")
    .select("id, code, description, category, supplier, unit, buy_price, markup_pct")
    .eq("archived", false)
    .order("description")
    .limit(2000);

  return (
    <div>
      <PageHeader
        title="Price List"
        description="Your priced catalog for quotes, invoices & POs — import a supplier list (e.g. CED) via CSV."
      />
      <PriceListManager items={(items ?? []) as any} />
    </div>
  );
}
