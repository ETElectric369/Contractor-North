import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { PettyCashManager } from "./petty-cash-manager";

export const dynamic = "force-dynamic";

export default async function PettyCashPage() {
  const supabase = await createClient();
  const { data: items } = await supabase
    .from("petty_cash")
    .select("id, tx_date, kind, amount, category, description")
    .order("tx_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);

  const rows = items ?? [];
  const balance = rows.reduce(
    (s: number, i: any) => s + (i.kind === "replenish" ? Number(i.amount) : -Number(i.amount)),
    0,
  );

  return (
    <div>
      <PageHeader title="Petty Cash" description="Track your cash box — add cash, log expenses, see the running balance." />
      <PettyCashManager items={rows as any} balance={balance} />
    </div>
  );
}
