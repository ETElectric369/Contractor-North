/**
 * THE ONE READ BEHIND THE ONE ANSWER (8a982483).
 *
 * Every screen that says what the company owes its suppliers now calls `whatISupplierOwed`, and
 * this is how a reader that is NOT a page gets the same figure: Nort, and anything else that has a
 * Supabase client and a question rather than a rendered page.
 *
 * WHY THIS FILE HAD TO EXIST. Nort was the worst reader in the tree. `list_bills` advertised itself
 * for "how much do I owe suppliers" and answered it with at most twenty rows of a hundred and
 * nineteen, newest first, free-text supplier, no account join, no supplier documents, no
 * aggregation - so he added up a truncated list of spellings and said the total out loud. A wrong
 * card is bad; a wrong sentence from the assistant Erik asks and then acts on is worse, because
 * there is nothing on screen beside it to argue with.
 *
 * `src/lib/assistant-tools.ts` reads no supplier_accounts, supplier_aliases, supplier_invoices or
 * supplier_payments table anywhere, so Nort had no route to the question at all. He has one now,
 * and it is the same one.
 *
 * EVERY READ IS ORG-FILTERED. My SQL bypasses RLS, so `org_id` is on every query here: three
 * companies share this database and a balance that reached across them would be the worst bug in
 * the app.
 */

import { supplierBalance, type SupplierAccountRow } from "@/app/(app)/bills/supplier-balance";
import { todayStrInTz } from "@/lib/tz";
import {
  indexSupplierIdentity,
  resolveSupplierPapers,
  supplierCoverage,
  whatIBoughtNotSettled,
  whatISupplierOwed,
  type BoughtNotSettled,
  type WhatISupplierOwed,
} from "@/lib/supplier-owed";

export interface SupplierOwedRead {
  /** (a) What the company owes its suppliers. THE one-number answer. */
  owed: WhatISupplierOwed;
  /** (b) What it bought on account and has not squared up. A purchasing figure, not a debt. */
  bought: BoughtNotSettled;
  /** The day the figures were worked out against, in the company's own timezone. */
  today: string;
  /** Which reads failed, by name. A figure is never quoted off a failed read: the caller says so. */
  failed: string[];
}

/**
 * BOTH FIGURES FOR ONE COMPANY, from the same functions every screen reads.
 *
 * It returns the whole answer rather than a number, so a caller can say which question it is
 * quoting and name the papers that are not on an account yet - the two things the screens were
 * getting wrong.
 */
export async function readSupplierOwed(supabase: any, orgId: string): Promise<SupplierOwedRead | null> {
  if (!orgId) return null;

  const [orgRes, acctRes, aliasRes, billsRes, docsRes, linksRes, payRes] = await Promise.all([
    supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle(),
    supabase.from("supplier_accounts").select("id, name, account_number, branch_code, on_account").eq("org_id", orgId).limit(500),
    supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", orgId).limit(2000),
    supabase
      .from("bills")
      .select("id, supplier, supplier_account_id, amount, status, bill_date, is_statement, superseded_by_bill_id")
      .eq("org_id", orgId)
      .is("superseded_by_bill_id", null)
      .limit(5000),
    supabase
      .from("supplier_invoices")
      .select("id, supplier_account_id, invoice_number, kind, invoice_date, total, open_balance, closed, discount_amount, discount_by")
      .eq("org_id", orgId)
      .limit(5000),
    supabase.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id").eq("org_id", orgId).limit(5000),
    supabase.from("supplier_payments").select("id, supplier_account_id, amount, paid_on, method, voided_at").eq("org_id", orgId).limit(2000),
  ]);

  const failed: string[] = [];
  const rowsOf = (res: any, name: string): any[] => {
    if (res?.error) {
      failed.push(name);
      return [];
    }
    return (res?.data ?? []) as any[];
  };

  const accounts = rowsOf(acctRes, "supplier accounts");
  const aliases = rowsOf(aliasRes, "supplier names");
  const bills = rowsOf(billsRes, "bills");
  const documents = rowsOf(docsRes, "the suppliers' own papers");
  const links = rowsOf(linksRes, "which paper covers which bill");
  const payments = rowsOf(payRes, "payments you have sent");

  const tz = (orgRes?.data as { settings?: { timezone?: string } } | null)?.settings?.timezone ?? "America/Los_Angeles";
  const today = todayStrInTz(tz);

  // ── IDENTITY, THEN THE ONE COVERING WALK ───────────────────────────────────────────────────
  const index = indexSupplierIdentity({
    accounts: accounts.map((a) => ({ id: a?.id, name: a?.name })),
    aliases,
  });
  const papers = bills.map((b) => ({
    id: String(b.id),
    supplierAccountId: b.supplier_account_id ?? null,
    supplier: b.supplier ?? null,
    amount: b.amount,
    status: b.status ?? null,
  }));
  const identity = resolveSupplierPapers(papers, index);

  const linked = new Map<string, Set<string>>();
  for (const l of links) {
    const doc = String(l?.supplier_invoice_id ?? "");
    const bill = String(l?.bill_id ?? "");
    if (!doc || !bill) continue;
    linked.set(doc, (linked.get(doc) ?? new Set<string>()).add(bill));
  }
  const coverage = supplierCoverage({
    documents: documents.map((d) => ({
      id: String(d.id),
      supplierAccountId: d.supplier_account_id ?? null,
      closed: d.closed === true,
    })),
    identity,
    linked,
    // THE NUMBER-CARRYING ROUTE IS NOT READ HERE, and this is said out loud rather than left to be
    // discovered: it needs the bills' notes and line descriptions, which is a far heavier read, and
    // leaving it out can only make a ticket look STILL OWED that a supplier's closed paper covers.
    // Nort's figure leans the way every figure in this app leans - toward money he may still owe -
    // and /bills, which does read it, is the screen he checks against.
    carrying: null,
    papers,
  });

  // ── EACH ACCOUNT'S OWN FIGURE, by the one function /bills reads ────────────────────────────
  const docsOf = new Map<string, any[]>();
  for (const d of documents) {
    const id = String(d?.supplier_account_id ?? "");
    if (!id) continue;
    docsOf.set(id, [...(docsOf.get(id) ?? []), d]);
  }

  const figures = accounts.map((a) => {
    const id = String(a.id);
    const own = docsOf.get(id) ?? [];
    const row: SupplierAccountRow = {
      id,
      name: String(a.name ?? "").trim() || "a supplier",
      accountNumber: a.account_number ?? null,
      branchCode: a.branch_code ?? null,
      onAccount: a.on_account !== false,
      note: null,
      aliases: [],
      bills: bills
        .filter((b) => identity.get(String(b.id))?.accountId === id)
        .map((b) => ({
          id: String(b.id),
          supplier: String(b.supplier ?? ""),
          billDate: b.bill_date ?? null,
          amount: Number(b.amount) || 0,
          status: String(b.status ?? ""),
          jobId: null,
          jobName: null,
          invoiceNumber: null,
          isStatement: !!b.is_statement,
          settledBySupplier: coverage.settledBySupplier.has(String(b.id)),
        })),
      payments: payments
        .filter((p) => String(p?.supplier_account_id ?? "") === id)
        .map((p) => ({
          id: String(p.id ?? ""),
          amount: Number(p.amount) || 0,
          paidOn: String(p.paid_on ?? ""),
          method: String(p.method ?? "other"),
          reference: null,
          note: null,
          voided: !!p.voided_at,
        })),
      // ABSENT, NOT EMPTY, when we hold none: one row is what switches an account to model B.
      ...(own.length
        ? {
            supplierInvoices: own.map((d) => ({
              id: String(d.id),
              invoiceNumber: String(d.invoice_number ?? ""),
              kind: String(d.kind ?? "invoice"),
              invoiceDate: d.invoice_date ?? null,
              dueDate: null,
              jobNameRaw: null,
              jobId: null,
              total: Number(d.total) || 0,
              openBalance: d.open_balance == null ? null : Number(d.open_balance),
              closed: d.closed === true,
              discountAmount: d.discount_amount == null ? null : Number(d.discount_amount),
              discountBy: d.discount_by ?? null,
            })),
          }
        : {}),
    };
    const balance = supplierBalance(row, today);
    return {
      accountId: id,
      name: row.name,
      onAccount: row.onAccount,
      owed: balance.owed,
      model: balance.model,
      openPapers: balance.chargedBills,
      // A model-A figure with its bills or payments unread is named, never guessed at.
      unread: row.onAccount && balance.model !== "supplier-invoices" && (failed.includes("bills") || failed.includes("payments you have sent")),
    };
  });

  const withSettled = papers.map((p) => ({ ...p, settledBySupplier: coverage.settledBySupplier.has(p.id) }));

  return {
    owed: whatISupplierOwed({ accounts: figures, papers: withSettled, identity, settledBySupplier: coverage.settledBySupplier }),
    bought: whatIBoughtNotSettled({ papers: withSettled, settledBySupplier: coverage.settledBySupplier }),
    today,
    failed,
  };
}
