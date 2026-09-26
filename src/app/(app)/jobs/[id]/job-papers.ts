import "server-only";

/**
 * NAMED ON A PAPER, NOT RECORDED YET (Erik, 2026-09-25, 85 Whitney / INV-081).
 *
 * "i think theres a bill missing from this": there was. CED invoice 8802-1107820 ($187.64, job name
 * "85 WHITNEY") was in the app as a supplier document and in nobody's books as a bill, so it was on
 * no cost list and no invoice. The /bills page already knew - it sits under Purchases Not In Your
 * Books - but nothing on the job said so.
 *
 * NO NEW RULE HERE, THREE OLD ONES:
 *   · WHICH PAPERS HAVE NO BILL: invoicesNeedingBill (supplier-reconcile), per supplier account,
 *     over rows whose billCount is counted the /bills way - a Record link (bill_supplier_invoices)
 *     or a live bill carrying the number (billsCarryingNumber). A statement, a credit memo, late
 *     interest and a purchase a credit memo took straight back are never on it.
 *   · WHICH OF THOSE ARE THIS JOB'S: filed on it by a person (job_id), or, filed nowhere, CED's job
 *     name read as the PO box the paperwork tray reads (jobFromPaperMarks): exact, one open job or
 *     nothing, never a likeness. A paper filed on ANOTHER job stays there: a person decided.
 *   · THE DOOR: Record It As A Bill, the /bills action, pressed by a person (JobPaperRow).
 */

import { invoicesNeedingBill, supplierPaperNeeds, type SupplierInvoiceKind, type SupplierInvoiceRow } from "@/app/(app)/bills/supplier-reconcile";
import { booksBeginOn } from "@/app/(app)/bills/supplier-papers";
import { loadMarkContext, type MarkContext } from "@/app/(app)/organize/paperwork-core";
import { jobFromPaperMarks } from "@/lib/paperwork";
import { billsCarryingNumber, namedNumbersOf, type LedgerBill } from "@/lib/same-purchase";
import { indexSupplierAliases } from "@/lib/supplier-identity";

/** A supplier document, as the job's list needs it: the reconcile row plus its account.
 *  `onNeedsYou`: /bills has it on a Needs You card (onNeedsYouIds), so a link to it goes there;
 *  otherwise the link goes to the supplier's own line. */
export type PaperDoc = SupplierInvoiceRow & { accountId: string | null; onNeedsYou?: boolean };

/**
 * WHICH PAPERS /bills HAS ON A NEEDS YOU CARD, by the cards' own rule (supplierPaperNeeds), never
 * a copy of it: the books line is one of its reasons, but a paper a credit memo reversed, a $0.00
 * paper and a STOCK paper with no job are on no card either, and a link that lands on Needs You
 * for one of those lands where the paper is not. `since` is booksBeginOn, the line /bills draws.
 */
export function onNeedsYouIds(docs: readonly PaperDoc[], since: string | null): Set<string> {
  const rows = docs.map((d) => ({ ...d, supplierAccountId: d.accountId }));
  return new Set(supplierPaperNeeds(rows, [], { since }).map((c) => c.invoiceId));
}

const KINDS: SupplierInvoiceKind[] = ["invoice", "credit_memo", "service_charge", "statement"];

/** Does the paper name this job? Filed on it, or filed nowhere and its printed job name (the PO box
 *  on CED's paper) names exactly this open job. */
export function paperNamesJob(doc: Pick<PaperDoc, "jobId" | "jobNameRaw">, jobId: string, mark: MarkContext): boolean {
  if (doc.jobId) return doc.jobId === jobId;
  if (!doc.jobNameRaw) return false;
  const m = jobFromPaperMarks({ po: doc.jobNameRaw }, mark.markJobs, mark.pos, mark.selfNames);
  return m.kind === "one" && m.jobId === jobId;
}

/**
 * The papers that name this job and have no bill, newest first. `docs` is every document on the
 * org (the credit-memo pairing needs the whole account, exactly as /bills hands it over).
 */
export function papersNamingJob(jobId: string, docs: readonly PaperDoc[], mark: MarkContext): PaperDoc[] {
  const byAccount = new Map<string, PaperDoc[]>();
  for (const d of docs) {
    const k = d.accountId ?? "";
    byAccount.set(k, [...(byAccount.get(k) ?? []), d]);
  }
  const out: PaperDoc[] = [];
  for (const group of byAccount.values()) {
    for (const row of invoicesNeedingBill(group, { since: null }).rows) {
      const d = row as PaperDoc;
      if (paperNamesJob(d, jobId, mark)) out.push(d);
    }
  }
  return out.sort(
    (a, b) => String(b.invoiceDate ?? "").localeCompare(String(a.invoiceDate ?? "")) || (Number(b.total) || 0) - (Number(a.total) || 0),
  );
}

/**
 * The reader. Staff only (RLS: supplier_invoices and bills are office tables). The bills are read
 * only when a paper naming this job has no Record link, which is the one case the number search
 * can change the answer; every other job opens with three small reads.
 */
export async function readJobPapers(supabase: any, orgId: string, jobId: string): Promise<PaperDoc[]> {
  const [docsRes, linksRes, mark] = await Promise.all([
    supabase
      .from("supplier_invoices")
      .select("id, supplier_account_id, invoice_number, kind, invoice_date, due_date, job_name_raw, job_id, total, open_balance, closed, discount_amount, discount_by")
      .eq("org_id", orgId)
      .order("invoice_date", { ascending: false })
      .limit(2000),
    supabase.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id").eq("org_id", orgId).limit(5000),
    // strict: a lost jobs read would match no paper and read as "nothing missing"; it throws, and
    // the page says it couldn't check.
    loadMarkContext(supabase, orgId, { strict: true }),
  ]);
  if (docsRes.error) throw docsRes.error;
  if (linksRes.error) throw linksRes.error;
  const linked = new Map<string, Set<string>>();
  for (const l of (linksRes.data ?? []) as { bill_id: string | null; supplier_invoice_id: string | null }[]) {
    if (!l?.bill_id || !l?.supplier_invoice_id) continue;
    const set = linked.get(String(l.supplier_invoice_id)) ?? new Set<string>();
    set.add(String(l.bill_id));
    linked.set(String(l.supplier_invoice_id), set);
  }
  const docs: PaperDoc[] = ((docsRes.data ?? []) as any[]).map((r) => {
    const kind = String(r.kind ?? "invoice") as SupplierInvoiceKind;
    return {
      id: String(r.id),
      accountId: r.supplier_account_id ?? null,
      invoiceNumber: String(r.invoice_number ?? ""),
      kind: KINDS.includes(kind) ? kind : "invoice",
      invoiceDate: r.invoice_date ?? null,
      dueDate: r.due_date ?? null,
      jobNameRaw: r.job_name_raw ?? null,
      jobId: r.job_id ?? null,
      total: Number(r.total) || 0,
      openBalance: r.open_balance == null ? null : Number(r.open_balance),
      closed: r.closed === true,
      discountAmount: r.discount_amount == null ? null : Number(r.discount_amount),
      discountBy: r.discount_by ?? null,
      jobName: null,
      billCount: linked.get(String(r.id))?.size ?? 0,
    };
  });

  // Only a paper that names this job and has no link can still turn out to be in the books by its
  // number. None: nothing more to read.
  const unlinked = docs.filter((d) => d.kind === "invoice" && d.billCount === 0 && paperNamesJob(d, jobId, mark));
  if (!unlinked.length) return [];

  const [billsRes, aliasRes] = await Promise.all([
    supabase
      .from("bills")
      .select("id, supplier, bill_number, supplier_invoice_number, supplier_account_id, superseded_by_bill_id, amount, bill_date, job_id, is_statement, notes, bill_line_items(description)")
      .eq("org_id", orgId)
      .is("superseded_by_bill_id", null)
      .limit(5000),
    supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", orgId).limit(5000),
  ]);
  // A lost read is not "no bill": saying a paper is unrecorded when it may be in the books would
  // offer a second bill for the same money.
  if (billsRes.error) throw billsRes.error;
  if (aliasRes.error) throw aliasRes.error;
  const aliases = indexSupplierAliases((aliasRes.data ?? []) as any[]);
  const ledger: LedgerBill[] = ((billsRes.data ?? []) as any[]).map((b) => {
    const named = namedNumbersOf({ notes: b.notes ?? null, bill_line_items: b.bill_line_items ?? [] });
    return {
      id: String(b.id),
      supplier: b.supplier ?? null,
      supplier_account_id: b.supplier_account_id ?? null,
      bill_number: b.bill_number ?? null,
      supplier_invoice_number: b.supplier_invoice_number ?? null,
      amount: b.amount ?? null,
      bill_date: b.bill_date ?? null,
      job_id: b.job_id ?? null,
      superseded_by_bill_id: b.superseded_by_bill_id ?? null,
      is_statement: !!b.is_statement || named.isStatement,
      named_numbers: named.numbers,
    };
  });
  for (const d of unlinked) {
    d.billCount = billsCarryingNumber(d.invoiceNumber, { accountId: d.accountId }, ledger, aliases).length;
  }
  const since = booksBeginOn(orgId, (billsRes.data ?? []) as { bill_date?: string | null }[]);
  const onCards = onNeedsYouIds(docs, since);
  return papersNamingJob(jobId, docs, mark).map((d) => ({ ...d, onNeedsYou: onCards.has(d.id) }));
}
