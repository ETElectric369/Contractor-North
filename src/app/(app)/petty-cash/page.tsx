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

  // OFF THE MENU (W1-34), NEVER OFF THE BOOKS: every entry here still counts wherever it always did
  // (job profit, Analytics, Owner Money, the Fuel card, Nort's list_petty_cash). A company that has
  // entries finds this page in Search Or Ask; a job's Petty Cash figure links here.
  return (
    <div>
      <PageHeader title="Petty Cash" description="Cash you took out, and older cash entries. A new cash purchase goes in through Snap Or Note or Add By Hand." />
      <PettyCashManager items={rows as any} balance={balance} />
    </div>
  );
}
