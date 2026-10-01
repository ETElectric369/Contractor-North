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
import {
  supplierBalancesUnread,
  supplierFigureUnread,
  whatIBoughtNotSettled,
  whatISupplierOwed,
  type BoughtNotSettled,
  type SupplierAccountFigure,
  type SupplierPaperIdentity,
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
  /**
   * ── WHAT RECONCILE NEEDS, AND WHY IT COMES OUT OF THIS READ RATHER THAN A SECOND ONE ────────
   *
   * /reconcile draws the two figures AGAINST EACH OTHER, per supplier: their own open papers beside
   * our own open tickets. Doing that needed four things this read already works out and used to
   * keep to itself — each account's figure, each account's own slice of question (b), who each
   * paper belongs to, and which papers the suppliers' own closed papers cover.
   *
   * Handing them back is the whole defence against a fourth disagreeing door (supplier-owed-
   * parity.test.ts). The alternative was Reconcile resolving identity a second time and totalling
   * an account's papers itself, which is 8a982483 with a new file name.
   */
  /** Each account's figure, exactly as `supplierBalance` produced it. Never re-totalled. */
  accounts: SupplierAccountFigure[];
  /**
   * Question (b) for ONE account: its own open tickets, by `whatIBoughtNotSettled`, over the papers
   * the resolver placed on it. Keyed by account id; an account with no open tickets is absent.
   */
  boughtByAccount: Record<string, BoughtNotSettled>;
  /** From `resolveSupplierPapers`: which supplier each paper belongs to, keyed by paper id. */
  identity: ReadonlyMap<string, SupplierPaperIdentity>;
  /** From `supplierCoverage`: the papers their own closed papers call settled. Empty if unchecked. */
  settledBySupplier: ReadonlySet<string>;
}

/**
 * WHAT THE SUPPLIER'S OWN BOOKS SAY ABOUT A HANDFUL OF TICKETS, for a screen that is not /bills.
 *
 * WHY: `billSettledLabel` is one expression and both screens draw it, but the job's Costs tab had
 * never been handed the FACT - so the same ticket read "Settled · CED Says" on /bills and
 * "On Account" on the job, and nothing on the job said the money had already left the supplier's
 * balance. One ticket described two ways on two screens is the small, visible version of two figures
 * disagreeing about one pile of money, which is the whole reason this module exists.
 *
 * It is the SAME covering walk, through `supplierDocumentRows`, never a second careful copy.
 *
 * SCOPED TO THE TICKETS ASKED ABOUT. `settledBySupplier` is a property of one paper - every document
 * of its own supplier that reaches it calls it closed, and none calls it open - and a document
 * reaches a paper through a link on that paper or a number printed on that paper's own lines. So the
 * answer for these tickets does not change if other jobs' tickets are left out, and a job page does
 * not have to read the whole book to draw a row honestly.
 *
 * IT STILL READS THE SUPPLIERS' DOCUMENTS WHOLE, through `readSupplierDocuments` and its one column
 * list, and that is deliberate: a narrower select here would be a second projection of the same table
 * feeding the same walk, and the projection law in this repository says the failure is always a
 * `select` list one reader is short of. Four queries, issued inside a caller's existing wave, cost
 * the page rows rather than a round trip.
 */
export interface SettledBySupplierRead {
  /** Ticket id -> the name of the account whose papers say so. Only the settled ones are in it. */
  settled: ReadonlyMap<string, string>;
  /**
   * A read behind this failed, so nothing is claimed either way. The caller must SAY it could not
   * check rather than drawing "On Account", which would be a sentence the app cannot stand behind.
   */
  unread: boolean;
  /** Which reads failed, by name, for that sentence. */
  failed: string[];
}

/** The columns the covering walk reads off a ticket. Named in the database's own shape, because the
 *  caller holds PostgREST rows; a camelCase copy here would be one more place to get wrong. */
export interface SettledBySupplierBill {
  id: string;
  supplier?: string | null;
  supplier_account_id?: string | null;
  bill_number?: string | null;
  supplier_invoice_number?: string | null;
  is_statement?: boolean | null;
  superseded_by_bill_id?: string | null;
  notes?: string | null;
  bill_line_items?: { description?: string | null }[] | null;
  status?: string | null;
  amount?: unknown;
  bill_date?: string | null;
  job_id?: string | null;
}

export async function readSettledBySupplier(
  supabase: any,
  orgId: string,
  bills: readonly SettledBySupplierBill[],
): Promise<SettledBySupplierRead> {
  const live = (bills ?? []).filter((b) => b?.id && !b.superseded_by_bill_id);
  if (!orgId || !live.length) return { settled: new Map(), unread: false, failed: [] };
  const ids = live.map((b) => String(b.id));

  const [acctRes, aliasRes, docsRes, linksRes] = await Promise.all([
    supabase.from("supplier_accounts").select("id, name").eq("org_id", orgId).limit(500),
    supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", orgId).limit(2000),
    readSupplierDocuments(supabase, orgId).then(
      (r) => r,
      (error: unknown) => ({ data: null, error, waitReady: false }),
    ),
    supabase.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id").eq("org_id", orgId).in("bill_id", ids).limit(5000),
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
  const documents = rowsOf(docsRes, "the suppliers' own papers");
  const links = rowsOf(linksRes, "which paper covers which bill");

  // ANY ONE OF THESE MISSING AND NOTHING IS CLAIMED. Without the accounts or the names a ticket
  // cannot be placed on its supplier, so a closed paper of theirs could not be found covering it and
  // the row would quietly read "On Account" - money he may not owe, with nothing saying so.
  if (failed.length) return { settled: new Map(), unread: true, failed };

  const { identity, coverage } = supplierDocumentRows({
    documents,
    bills: live,
    links,
    aliasRows: aliases,
    accountRows: accounts,
  });

  const nameOf = new Map<string, string>(accounts.map((a) => [String(a.id), String(a.name ?? "").trim()]));
  const settled = new Map<string, string>();
  for (const id of coverage.settledBySupplier) {
    const accountId = identity.get(String(id))?.accountId ?? "";
    settled.set(String(id), nameOf.get(accountId) ?? "");
  }
  return { settled, unread: false, failed };
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

  // WHICH OF THE THREE READS A SUPPLIER BALANCE STANDS ON FAILED, named one at a time so that none
  // of them can be left out: the record's type is what makes a fourth read impossible to forget.
  const balancesUnread = supplierBalancesUnread({
    bills: failed.includes("bills"),
    payments: failed.includes("payments you have sent"),
    theirOwnPapers: failed.includes("the suppliers' own papers"),
  });

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
      // A model-A figure built on a read that failed is NAMED, never guessed at - by the one
      // function /bills' page and the Suppliers card both ask. This spelled the rule out itself and
      // left the supplier's own papers off the list, which does not read as a gap: with those
      // unread an account holds no documents, so it drops from model B to model A, and model A
      // subtracts payments that are already inside what the supplier closed. /bills said it could
      // not total while Nort quoted that very number, and Erik acts on Nort's answers.
      unread: supplierFigureUnread({ onAccount: row.onAccount, model: balance.model, balancesUnread }),
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

  // ── QUESTION (b), ONE ACCOUNT AT A TIME ─────────────────────────────────────────────────────
  // The SAME function, handed only that account's papers — never a sum written here. Which papers
  // are "that account's" is the resolver's answer (`identity`), never the stored column: gating a
  // figure on `bills.supplier_account_id` is specifically what the tripwire in
  // supplier-owed-one-place.test.ts bans, and it is null on more than half a real book.
  const papersOfAccount = new Map<string, typeof papers>();
  for (const p of papers) {
    const accountId = identity.get(p.id)?.accountId ?? "";
    if (!accountId) continue;
    papersOfAccount.set(accountId, [...(papersOfAccount.get(accountId) ?? []), p]);
  }
  const boughtByAccount: Record<string, BoughtNotSettled> = {};
  for (const [accountId, own] of papersOfAccount) {
    boughtByAccount[accountId] = whatIBoughtNotSettled({ papers: own, settledBySupplier });
  }

  return {
    owed: whatISupplierOwed({ accounts: figures, papers, identity, settledBySupplier }),
    bought: whatIBoughtNotSettled({ papers, settledBySupplier }),
    today,
    failed,
    accounts: figures,
    boughtByAccount,
    identity,
    settledBySupplier,
  };
}
