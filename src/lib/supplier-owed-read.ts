/**
 * THE ONE READ BEHIND THE ONE ANSWER (8a982483).
 *
 * Every screen that says what the company owes its suppliers calls `whatISupplierOwed`, and this is
 * how a reader that is NOT a page gets the same figure: Nort, and anything else that has a Supabase
 * client and a question rather than a rendered page.
 *
 * WHY THIS FILE HAD TO EXIST. Nort was the worst reader in the tree. `list_bills` advertised itself
 * for "how much do I owe suppliers" and answered it with at most twenty rows of a hundred and
 * nineteen, newest first, free-text supplier, no account join, no supplier documents, no
 * aggregation - so he added up a truncated list of spellings and said the total out loud. A wrong
 * card is bad; a wrong sentence from the assistant Erik asks and then ACTS on is worse, because
 * there is nothing on screen beside it to argue with.
 *
 * IT MAKES THE SAME CALL /bills MAKES, deliberately. `supplierDocumentRows` is the reconcile read
 * the page and My Day both go through: it resolves identity, parses the invoice numbers off the
 * bills' own notes and lines, and runs the one covering walk. Reaching the figure a second way -
 * even a careful second way - is exactly how this bug was built, so Nort does not get his own
 * arithmetic, he gets the page's.
 *
 * EVERY READ IS ORG-FILTERED. Three companies share this database and a balance that reached across
 * them would be the worst bug in the app.
 */

import { readSupplierDocuments, supplierDocumentRows } from "@/app/(app)/bills/supplier-papers";
import { supplierBalance, type SupplierAccountRow } from "@/app/(app)/bills/supplier-balance";
import { todayStrInTz } from "@/lib/tz";
import { whatIBoughtNotSettled, whatISupplierOwed, type BoughtNotSettled, type WhatISupplierOwed } from "@/lib/supplier-owed";

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
 * BOTH FIGURES FOR ONE COMPANY, from the same functions and the same reconcile read every screen
 * uses.
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
    // notes AND the line descriptions: the invoice number a ticket carries is parsed out of them
    // (readBillInvoice), because `bills.supplier_invoice_number` is null on every scanned ticket.
    // Without them a statement's number could not mark the tickets inside it covered.
    supabase
      .from("bills")
      .select(
        "id, supplier, supplier_account_id, bill_number, supplier_invoice_number, amount, status, bill_date, job_id, is_statement, superseded_by_bill_id, notes, bill_line_items(description)",
      )
      .eq("org_id", orgId)
      .is("superseded_by_bill_id", null)
      .limit(5000),
    readSupplierDocuments(supabase, orgId).then(
      (r) => r,
      (error: unknown) => ({ data: null, error, waitReady: false }),
    ),
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

  // ── THE PAGE'S OWN RECONCILE READ: identity, the number parse, the one covering walk ────────
  //
  // A LOST LINKS READ MARKS NOTHING SETTLED, the same gate /bills uses: a bill covered only by a
  // Record link would look open again, and the figure would quietly go UP with nothing saying why.
  // Leaning toward money he may still owe is the lean every figure in this app takes.
  const linksUnread = failed.includes("which paper covers which bill");
  const {
    rows: documentRows,
    identity,
    coverage,
  } = supplierDocumentRows({
    documents,
    bills,
    links: linksUnread ? [] : links,
    aliasRows: aliases,
    accountRows: accounts,
  });
  const settledBySupplier = linksUnread ? new Set<string>() : coverage.settledBySupplier;

  // ── EACH ACCOUNT'S OWN FIGURE, by the one function /bills reads ─────────────────────────────
  const docsOf = new Map<string, typeof documentRows>();
  for (const d of documentRows) {
    const id = String(d.supplierAccountId ?? "");
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
          jobId: b.job_id ?? null,
          jobName: null,
          invoiceNumber: b.supplier_invoice_number ?? null,
          isStatement: !!b.is_statement,
          settledBySupplier: settledBySupplier.has(String(b.id)),
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
      ...(own.length ? { supplierInvoices: own } : {}),
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
      unread:
        row.onAccount &&
        balance.model !== "supplier-invoices" &&
        (failed.includes("bills") || failed.includes("payments you have sent")),
    };
  });

  const papers = bills.map((b) => ({
    id: String(b.id),
    supplierAccountId: b.supplier_account_id ?? null,
    supplier: b.supplier ?? null,
    amount: b.amount,
    status: b.status ?? null,
    settledBySupplier: settledBySupplier.has(String(b.id)),
  }));

  return {
    owed: whatISupplierOwed({ accounts: figures, papers, identity, settledBySupplier }),
    bought: whatIBoughtNotSettled({ papers, settledBySupplier }),
    today,
    failed,
  };
}
