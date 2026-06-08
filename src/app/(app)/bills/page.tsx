import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { BillsReceipts } from "./bills-receipts";

export const dynamic = "force-dynamic";

export default async function BillsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  const orgId = profile?.org_id ?? "";

  const [{ data: pos }, { data: bills }, { data: docRows }, { data: jobs }, { data: lists }] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id, po_number, vendor, status, total, jobs(name)")
      .order("created_at", { ascending: false }),
    supabase
      .from("bills")
      .select("id, supplier, bill_number, amount, status, bill_date, job_id, jobs(job_number, name)")
      .order("created_at", { ascending: false }),
    supabase
      .from("documents")
      .select("id, name, category, file_url, size_bytes, created_at, job_id, jobs(name)")
      .in("category", ["Receipt", "Bill"])
      .order("created_at", { ascending: false }),
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
    supabase.from("material_lists").select("id, name").order("created_at", { ascending: false }).limit(100),
  ]);

  // Sign the receipt/bill document URLs.
  const docs = await Promise.all(
    (docRows ?? []).map(async (d: any) => {
      const { data } = await supabase.storage.from("documents").createSignedUrl(d.file_url, 3600);
      return { ...d, signedUrl: data?.signedUrl ?? null };
    }),
  );

  return (
    <div>
      <PageHeader
        title="Bills & Purchasing"
        description="Purchase orders, supplier bills, and receipts across every job."
      />

      <BillsReceipts
        orgId={orgId}
        jobs={jobs ?? []}
        lists={lists ?? []}
        pos={(pos ?? []) as any}
        bills={(bills ?? []) as any}
        docs={docs as any}
      />
    </div>
  );
}
