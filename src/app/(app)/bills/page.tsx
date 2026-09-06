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
      .select("id, supplier, bill_number, amount, status, bill_date, job_id, category, jobs(job_number, name), bill_line_items(description, quantity, unit_price, amount, category, sort_order)")
      .order("created_at", { ascending: false }),
    supabase
      .from("documents")
      .select("id, name, category, file_url, size_bytes, created_at, job_id, jobs(name)")
      .in("category", ["Receipt", "Bill"])
      .order("created_at", { ascending: false }),
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
    supabase.from("material_lists").select("id, name").order("created_at", { ascending: false }).limit(100),
  ]);

  // Sort each bill's embedded line items by sort_order for display.
  const billsWithLines = (bills ?? []).map((b: any) => ({
    ...b,
    line_items: [...(b.bill_line_items ?? [])].sort((a: any, c: any) => (a.sort_order ?? 0) - (c.sort_order ?? 0)),
  }));

  // Sign the receipt/bill document URLs — ONE round trip for the whole page (audit v921).
  // This was createSignedUrl per row inside a map: every photographed receipt was its own JWT
  // mint + HTTPS hop, and this list has no ceiling, so the fan-out grew with the shoebox.
  // documents.file_url is nullable (Organize notes have no file) — a null path throws a
  // TypeError that storage-js rethrows, crashing the RSC render, so fileless rows never go in.
  const paths = Array.from(new Set((docRows ?? []).map((d: any) => d.file_url).filter(Boolean))) as string[];
  const signed = new Map<string, string>();
  if (paths.length) {
    try {
      const { data } = await supabase.storage.from("documents").createSignedUrls(paths, 3600);
      for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
    } catch {
      // A signing failure drops the LINKS, never the page — the rows still list what's on file.
    }
  }
  const docs = (docRows ?? []).map((d: any) => ({ ...d, signedUrl: (d.file_url && signed.get(d.file_url)) || null }));

  return (
    <div>
      <PageHeader
        title="Bills & purchasing"
        description="Purchase orders, supplier bills, and receipts across every job."
      />

      <BillsReceipts
        orgId={orgId}
        jobs={jobs ?? []}
        lists={lists ?? []}
        pos={(pos ?? []) as any}
        bills={billsWithLines as any}
        docs={docs as any}
      />
    </div>
  );
}
