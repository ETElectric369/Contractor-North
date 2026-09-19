import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { claimedIdsOfLines } from "@/lib/unbilled-work";
import { BillsReceipts } from "./bills-receipts";
import { ReceiptBillingCard, type ReceiptForBilling } from "./receipt-billing-card";

export const dynamic = "force-dynamic";

/**
 * The bills ledger, with each receipt's lines. `billable` (0268) and the line's own id ride along
 * for the receipt-billing card: it writes one line at a time, so it needs the id, and it shows
 * what the customer is actually charged for a receipt, so it needs the flag. The ledger itself
 * ignores both.
 *
 * AND IT SURVIVES ITS OWN MIGRATION NOT BEING THERE. A push deploys before its migration runs, and
 * PostgREST rejects the WHOLE query for one unknown column — the exact failure that made PO-003
 * render as an empty purchase order under a $3,274 total (bug 7a6b17a8). Here the casualty would
 * be every bill on the page, so the one error shape a missing column makes gets one retry without
 * it. A line that comes back with no flag reads as billed, which is what the column defaults to.
 */
async function readBills(supabase: Awaited<ReturnType<typeof createClient>>) {
  const columns = (withBillable: boolean) =>
    `id, supplier, bill_number, amount, status, bill_date, job_id, category, jobs(job_number, name), bill_line_items(id, description, quantity, unit_price, amount, category${withBillable ? ", billable" : ""}, sort_order)`;
  const read = (withBillable: boolean) =>
    supabase.from("bills").select(columns(withBillable)).order("created_at", { ascending: false });
  const first = await read(true);
  if (!first.error) return first;
  const code = String((first.error as { code?: string }).code ?? "");
  const message = String((first.error as { message?: string }).message ?? "");
  if (code !== "42703" && !/billable/i.test(message)) return first;
  return await read(false);
}

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
    readBills(supabase),
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

  // ── THE RECEIPTS WHOSE LINES ARE STILL A DECISION (0268) ────────────────────────────────────
  // Only bills ON A JOB, and only bills that were actually itemised. An overhead receipt never
  // reaches a customer, so "billed to the customer" is a question it does not have; a bill typed
  // in by hand has no lines to switch. Both would be noise in a card that exists to answer one
  // question: what of this receipt does the homeowner pay for?
  const receiptBills = billsWithLines.filter((b: any) => b.job_id && (b.line_items?.length ?? 0) > 0);
  const receiptJobIds = Array.from(new Set(receiptBills.map((b: any) => String(b.job_id))));

  /**
   * Which of those receipts an invoice already holds. The importer skips a bill that is already
   * claimed, forever after, so a switch on a claimed line could not move a single dollar — and a
   * live control that cannot do anything is the dead end this wave is here to delete. One read
   * covers every job on the page, and it looks at BOTH claim shapes: the `bill:<id>` import key
   * older invoices carry and the `source_ids` array 0255 added. A claim read that fails (0255 not
   * applied yet, a refused query) leaves the map empty, which leaves the switches live: a flip
   * that turns out to be a no-op is a far smaller wrong than a receipt Erik cannot correct.
   */
  // The claimant's STATUS travels with its number, because "already billed" is two different
  // situations wearing one word (review of this wave, 2026-09-18). A receipt claimed by a bill the
  // customer is holding really is settled: the only way to take something off it is a credit. A
  // receipt claimed by a DRAFT is not settled at all — that invoice's lines are still editable, so
  // telling him it is locked would be the same false wall this wave exists to tear down, built one
  // page over.
  const billedOn = new Map<string, { label: string; status: string }>();
  const readClaims = async () => {
    if (!receiptJobIds.length) return;
    const { data: claimRows } = await supabase
      .from("invoice_items")
      .select("import_key, source_ids, invoices!inner(invoice_number, status, created_at, job_id)")
      .in("invoices.job_id", receiptJobIds)
      .neq("invoices.status", "void")
      .limit(5000);
    // Earliest invoice wins a contested bill, so the sentence on the card is stable no matter what
    // order PostgREST hands the rows back.
    const oldestFirst = [...((claimRows ?? []) as any[])].sort((a, b) =>
      String(a.invoices?.created_at ?? "").localeCompare(String(b.invoices?.created_at ?? "")),
    );
    for (const row of oldestFirst) {
      const label = row.invoices?.invoice_number || "an earlier invoice";
      const status = String(row.invoices?.status ?? "");
      for (const id of claimedIdsOfLines([{ import_key: row.import_key, source_ids: row.source_ids }])) {
        if (!billedOn.has(id)) billedOn.set(id, { label, status });
      }
    }
  };

  // Sign the receipt/bill document URLs — ONE round trip for the whole page (audit v921).
  // This was createSignedUrl per row inside a map: every photographed receipt was its own JWT
  // mint + HTTPS hop, and this list has no ceiling, so the fan-out grew with the shoebox.
  // documents.file_url is nullable (Organize notes have no file) — a null path throws a
  // TypeError that storage-js rethrows, crashing the RSC render, so fileless rows never go in.
  const paths = Array.from(new Set((docRows ?? []).map((d: any) => d.file_url).filter(Boolean))) as string[];
  const signed = new Map<string, string>();
  const signPaths = async () => {
    if (!paths.length) return;
    try {
      const { data } = await supabase.storage.from("documents").createSignedUrls(paths, 3600);
      for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
    } catch {
      // A signing failure drops the LINKS, never the page — the rows still list what's on file.
    }
  };
  // The claim read and the signing both depend on the first wave's rows and on nothing else, so
  // they ride together. Adding a second serial hop to this page was the phone-lag class all over
  // again (audit v921) and it is not worth one sentence on a card.
  await Promise.all([signPaths(), readClaims()]);
  const docs = (docRows ?? []).map((d: any) => ({ ...d, signedUrl: (d.file_url && signed.get(d.file_url)) || null }));

  const receiptsForBilling: ReceiptForBilling[] = receiptBills.map((b: any) => ({
    id: String(b.id),
    supplier: b.supplier ?? "Receipt",
    bill_date: b.bill_date ?? null,
    job_id: b.job_id ?? null,
    job_name: b.jobs?.name ?? null,
    amount: Number(b.amount) || 0,
    billedOn: billedOn.get(String(b.id)) ?? null,
    lines: (b.line_items ?? []).map((l: any) => ({
      id: String(l.id),
      description: String(l.description ?? ""),
      quantity: Number(l.quantity) || 0,
      amount: Number(l.amount) || 0,
      category: l.category ?? null,
      // A row written before 0268 ran comes back without the column at all. Reading a missing
      // flag as "not billed" would take money off invoices nobody asked to change, so the
      // absence means billed — the same direction the column's own default takes.
      billable: l.billable !== false,
    })),
  }));

  return (
    <div>
      <PageHeader
        title="Bills & purchasing"
        description="Purchase orders, supplier bills, and receipts across every job."
      />

      <ReceiptBillingCard receipts={receiptsForBilling} />

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
