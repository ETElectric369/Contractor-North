/**
 * THE SUPPLIER'S PAPERS, READ ONE WAY FOR EVERY SCREEN (Bills plan, Wave A, 2026-09-25).
 *
 * "Hey you, here's a bill, what's it for?" The app brings the paper to Erik on My Day and on
 * /bills, and both screens have to agree, paper for paper, about which ones are waiting. Whether a
 * paper is waiting turns on one fact above all: does a bill in his books already cover it? That
 * used to be worked out inline on the /bills page, so My Day could only have had a second copy.
 * It lives here now, and the page and the My Day feeder both call it:
 *
 *   supplierDocumentRows  pure: the database rows in, the reconcile rows out (billCount and all)
 *   loadSupplierPapers    the My Day read: the same five reads /bills makes, org-filtered, then
 *                         supplierDocumentRows, then supplierPaperNeeds (supplier-reconcile.ts)
 *
 * A BILL COVERS A PAPER TWO WAYS, and both count: it is LINKED to it (bill_supplier_invoices, the
 * Record button's write), or it CARRIES its number (billsCarryingNumber, same-purchase.ts: a
 * scanned statement names the invoices inside it). Held as a set of bill ids per paper, so a bill
 * that is both linked and named counts once.
 */

import {
  billsCarryingNumber,
  billsCoveredByDocuments,
  namedNumbersOf,
  samePurchaseCandidates,
  samePurchaseSentence,
  type LedgerBill,
  type SupplierDoc,
} from "@/lib/same-purchase";
import { indexSupplierAliases, type SupplierAliasIndex } from "@/lib/supplier-identity";
import {
  shortSupplierName,
  supplierPaperLine,
  supplierPaperNeeds,
  paperJob,
  type PaperJob,
  type ReconcileJob,
  type SupplierInvoiceKind,
  type SupplierInvoiceRow,
  type SupplierPaperCard,
} from "./supplier-reconcile";
import { supplierPayDue, type SupplierPayDue } from "./supplier-pay-due";

/** The four kinds migration 0273's check constraint allows. A fifth could only arrive from a
 *  later migration, and showing it as an invoice is a far smaller wrong than a crashed page. */
export const SUPPLIER_INVOICE_KINDS: SupplierInvoiceKind[] = ["invoice", "credit_memo", "service_charge", "statement"];

/** The columns every reader of supplier_invoices asks for. One list, so no reader is short one. */
export const SUPPLIER_INVOICE_COLUMNS =
  "id, supplier_account_id, invoice_number, kind, invoice_date, due_date, job_name_raw, job_id, total, open_balance, closed, discount_amount, discount_by, source_file, jobs(name)";

export interface SupplierDocumentCoverage {
  /** One reconcile row per supplier document, billCount and samePurchase filled in. */
  rows: SupplierInvoiceRow[];
  /** Bills LINKED to each document (bill_supplier_invoices), by document id. */
  coveringBills: Map<string, Set<string>>;
  /** Bills CARRYING each document's number, by document id. */
  billsCarrying: Map<string, string[]>;
  aliasIndex: SupplierAliasIndex;
}

/**
 * THE DATABASE ROWS IN, THE RECONCILE ROWS OUT. Pure.
 *
 * `bills` are the LIVE bills (a copy set aside as a duplicate, 0271, is not in anybody's books),
 * each with its notes and its lines (as `line_items` or `bill_line_items`, descriptions at least):
 * a scanned statement names the invoices inside it on its own lines.
 */
export function supplierDocumentRows(input: {
  documents: any[];
  bills: any[];
  links: { bill_id?: string | null; supplier_invoice_id?: string | null }[];
  aliasRows: any[];
}): SupplierDocumentCoverage {
  const documents = (input.documents ?? []) as any[];
  const coveringBills = new Map<string, Set<string>>();
  const cover = (invoiceKey: string, billId: string) => {
    if (!invoiceKey || !billId) return;
    const set = coveringBills.get(invoiceKey) ?? new Set<string>();
    set.add(billId);
    coveringBills.set(invoiceKey, set);
  };
  for (const l of (input.links ?? []) as any[]) cover(String(l.supplier_invoice_id ?? ""), String(l.bill_id ?? ""));

  /**
   * WHICH BILLS CARRY A DOCUMENT'S NUMBER: the ONE reading every door uses (same-purchase.ts,
   * audit v994 DB1): bill_number, supplier_invoice_number, or named on the bill's own lines, and
   * only on the document's own account.
   */
  const aliasIndex = indexSupplierAliases((input.aliasRows ?? []) as any[]);
  const ledgerBills: LedgerBill[] = ((input.bills ?? []) as any[]).map((b: any) => {
    const named = namedNumbersOf({ notes: b.notes ?? null, line_items: b.line_items ?? b.bill_line_items ?? [] });
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
      jobs: b.jobs ?? null,
      named_numbers: named.numbers,
    };
  });
  const ledgerDocs: SupplierDoc[] = documents.map((r) => ({
    id: String(r.id),
    invoice_number: r.invoice_number ?? null,
    supplier_account_id: r.supplier_account_id ?? null,
    job_id: r.job_id ?? null,
    total: r.total ?? null,
    invoice_date: r.invoice_date ?? null,
  }));
  const billsCarrying = new Map<string, string[]>(
    ledgerDocs.map((d) => [d.id, billsCarryingNumber(d.invoice_number, { accountId: d.supplier_account_id }, ledgerBills, aliasIndex).map((b) => b.id)]),
  );
  // Bills a supplier document already covers, by a link or by carrying its number: they are
  // never offered as "maybe the same purchase" for a different document.
  const coveredByDocs = billsCoveredByDocuments(ledgerBills, ledgerDocs, (input.links ?? []) as any[], aliasIndex);

  const rows: SupplierInvoiceRow[] = documents.map((r) => {
    const id = String(r.id);
    const kind = String(r.kind ?? "invoice") as SupplierInvoiceKind;
    const row: SupplierInvoiceRow = {
      id,
      invoiceNumber: String(r.invoice_number ?? ""),
      kind: SUPPLIER_INVOICE_KINDS.includes(kind) ? kind : "invoice",
      invoiceDate: r.invoice_date ?? null,
      dueDate: r.due_date ?? null,
      // RAW, AND RESOLVED BY A PERSON. See 0273's header: one road, four spellings, five jobs.
      jobNameRaw: r.job_name_raw ?? null,
      jobId: r.job_id ?? null,
      total: Number(r.total) || 0,
      // Nullable in the schema. openBalanceOf() falls back to the total, and says out loud how
      // many documents it had to do that for - never a silent zero, which would read as settled.
      openBalance: r.open_balance == null ? null : Number(r.open_balance),
      closed: r.closed === true,
      discountAmount: r.discount_amount == null ? null : Number(r.discount_amount),
      discountBy: r.discount_by ?? null,
      sourceFile: r.source_file ?? null,
      jobName: r.jobs?.name ?? null,
      supplierAccountId: r.supplier_account_id ?? null,
      // Zero covering bills means the app has no record of the purchase at all. A bill covers it
      // by being LINKED to it, or by naming its number on its own lines.
      billCount: (() => {
        const bills = new Set(coveringBills.get(id) ?? []);
        for (const b of billsCarrying.get(id) ?? []) bills.add(b);
        return bills.size;
      })(),
    };
    // NOT IN HIS BOOKS BY NUMBER, BUT MAYBE BY MONEY (audit v994, DB1). A counter ticket carries a
    // sales-order number CED's invoice never prints, so the bills on this account (and job) that
    // no document covers yet, within a few dollars and days, are offered beside it: Same Purchase:
    // Tie Them. Only offered. Nothing is tied until a person presses it, and the server re-checks.
    if (row.billCount === 0 && row.kind === "invoice") {
      const doc = ledgerDocs.find((d) => d.id === id);
      const candidates = doc ? samePurchaseCandidates(doc, ledgerBills, coveredByDocs, aliasIndex) : [];
      if (candidates.length)
        row.samePurchase = candidates.slice(0, 3).map((c) => ({ billId: c.billId, exact: c.exact, sentence: samePurchaseSentence(c) }));
    }
    return row;
  });

  return { rows, coveringBills, billsCarrying, aliasIndex };
}

/** His jobs as the matcher and the card picker read them: enough to tell five Rhodesias apart. */
export function reconcileJobsOf(rows: any[]): ReconcileJob[] {
  return ((rows ?? []) as any[]).map((j) => ({
    id: String(j.id),
    jobNumber: j.job_number ?? null,
    name: String(j.name ?? ""),
    status: j.status ?? null,
    address: j.address ?? null,
    createdAt: j.created_at ?? null,
  }));
}

/** What a card set needs to be drawn: the cards, and every job for Another Job / Pick A Job. */
export interface SupplierPaperFeed {
  cards: SupplierPaperCard[];
  jobs: PaperJob[];
}

/**
 * THE DAY HIS BOOKS BEGIN: the line an org named (supplierPaperLine: ET's June 8, "june 8 is
 * good"), or, for an org that has not named one, its earliest scanned bill. A supplier paper dated
 * before it could not have been recorded here, so it never needs a person. /bills and My Day both
 * read this, so a paper cannot be a card on one screen and "from before your books" on the other.
 */
export function booksBeginOn(orgId: string | null | undefined, liveBills: { bill_date?: string | null }[]): string | null {
  return (
    supplierPaperLine(orgId) ??
    (liveBills ?? [])
      .map((b) => String(b?.bill_date ?? "").slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()[0] ??
    null
  );
}

/** The cards, from rows already read. The ONE call My Day and /bills both make. */
export function supplierPaperFeed(input: {
  /** booksBeginOn: nothing dated before it is a card. */
  since: string | null;
  rows: SupplierInvoiceRow[];
  jobs: ReconcileJob[];
  accounts: { id: string; name: string | null }[];
}): SupplierPaperFeed {
  const names = new Map((input.accounts ?? []).map((a) => [String(a.id), shortSupplierName(a.name)]));
  const cards = supplierPaperNeeds(input.rows, input.jobs, {
    since: input.since,
    supplierName: (accountId) => (accountId && names.get(accountId)) || "The Supplier",
  });
  // Cancelled jobs are never offered in a picker; the matcher still sees them, as /bills's does.
  const jobs = (input.jobs ?? []).filter((j) => j.status !== "cancelled").map(paperJob);
  return { cards, jobs };
}

/** What My Day brings from the supplier's own papers: the cards, and the Pay By lines. */
export interface SupplierDesk {
  /** "Hey you, here's a bill": null when nothing is waiting (or a read it needs failed). */
  papers: SupplierPaperFeed | null;
  /** "Pay CED $X By Oct 10": supplierPayDue over the same rows. Empty when nothing is due soon. */
  payDue: SupplierPayDue[];
}

/**
 * THE MY DAY READ. Staff only (the caller gates it: these cards carry prices, and a tech never
 * sees a price). Every read filters org_id as well as leaning on RLS: a rule at one read path is a
 * convention, not a boundary. A read that fails is "no cards" (or "no pay lines"), never a crash of
 * the inbox; the same papers and the same discount are still on /bills.
 *
 * ONE READ, TWO LINES. The Pay By line (supplier-pay-due.ts) is worked out from the same document
 * rows the cards are, so the two never hold different copies of CED's papers. `today` is the
 * ORG's today: it decides whether a discount is still alive. The seventh read is his live payments:
 * one dated inside this deadline's cycle is what clears the line (supplier-pay-due.ts,
 * sentThisCycle), keyed to the cheque, never to when a paper landed.
 */
export async function loadSupplierDesk(supabase: any, userId: string, today: string): Promise<SupplierDesk | null> {
  if (!userId) return null;
  const { data: me, error: meErr } = await supabase.from("profiles").select("org_id").eq("id", userId).maybeSingle();
  const orgId = String((me as { org_id?: string } | null)?.org_id ?? "");
  if (meErr || !orgId) return null;
  const [docsRes, billsRes, linksRes, aliasRes, jobsRes, acctRes, payRes] = await Promise.all([
    supabase.from("supplier_invoices").select(SUPPLIER_INVOICE_COLUMNS).eq("org_id", orgId).order("invoice_date", { ascending: false }).limit(2000),
    supabase
      .from("bills")
      .select("id, supplier, supplier_account_id, bill_number, supplier_invoice_number, amount, bill_date, job_id, is_statement, superseded_by_bill_id, notes, jobs(job_number, name), bill_line_items(description)")
      .eq("org_id", orgId)
      .is("superseded_by_bill_id", null)
      .limit(5000),
    supabase.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id").eq("org_id", orgId).limit(5000),
    supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", orgId).limit(2000),
    supabase.from("jobs").select("id, job_number, name, status, address, created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(500),
    supabase.from("supplier_accounts").select("id, name, on_account").eq("org_id", orgId).limit(500),
    supabase
      .from("supplier_payments")
      .select("supplier_account_id, amount, paid_on, voided_at")
      .eq("org_id", orgId)
      .is("voided_at", null)
      .order("paid_on", { ascending: false })
      .limit(500),
  ]);
  // No supplier documents (or a database without 0273): nothing to bring him.
  if (docsRes?.error || !(docsRes?.data ?? []).length) return null;
  const accounts = acctRes?.error ? [] : ((acctRes?.data ?? []) as any[]);
  // A failed bills, links or aliases read would make covered papers look uncovered: false cards.
  const papersReadable = !(billsRes?.error || linksRes?.error || aliasRes?.error || jobsRes?.error);
  const { rows } = supplierDocumentRows({
    documents: docsRes.data ?? [],
    bills: papersReadable ? (billsRes.data ?? []) : [],
    links: papersReadable ? (linksRes.data ?? []) : [],
    aliasRows: papersReadable ? (aliasRes?.data ?? []) : [],
  });
  const papers = papersReadable
    ? supplierPaperFeed({
        since: booksBeginOn(orgId, (billsRes.data ?? []) as any[]),
        rows,
        jobs: reconcileJobsOf(jobsRes.data ?? []),
        accounts,
      })
    : null;
  // The pay line reads only the documents' own money (open balance, discount, its date), none of
  // which a bill or a link changes. It needs the accounts read: without the name and the on-account
  // flag there is no door to open (the /bills sheet is not drawn when that read fails either).
  // A failed payments read is no pay line rather than a line that ignores a payment he made: the
  // nag this read exists to end. The same discount is still on /bills.
  const payDue = acctRes?.error || payRes?.error ? [] : supplierPayDue({ rows, accounts, today, payments: payRes?.data ?? [] });
  return { papers, payDue };
}
