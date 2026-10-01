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
 *   loadSupplierDesk      the My Day read: the same five reads /bills makes, org-filtered, then
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
  indexSupplierIdentity,
  resolveSupplierPapers,
  supplierCoverage,
  type SupplierCoverage,
  type SupplierIdentityIndex,
  type SupplierPaperIdentity,
} from "@/lib/supplier-owed";
import {
  invoicesNeedingBill,
  isBeforeLine,
  shortSupplierName,
  supplierPaperLine,
  supplierPaperNeeds,
  supplierPapersWaitingOnCredit,
  paperJob,
  type PaperJob,
  type ReconcileJob,
  type SupplierInvoiceKind,
  type SupplierInvoiceRow,
  type SupplierPaperCard,
} from "./supplier-reconcile";
import { supplierPayDue, type SupplierPayDue } from "./supplier-pay-due";
import { getOrgSettings } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";
import { todayStrInTz } from "@/lib/tz";
import { readAlreadyBilledReach } from "@/lib/already-billed-read";
import { reportError } from "@/lib/observe";

/** The four kinds migration 0273's check constraint allows. A fifth could only arrive from a
 *  later migration, and showing it as an invoice is a far smaller wrong than a crashed page. */
export const SUPPLIER_INVOICE_KINDS: SupplierInvoiceKind[] = ["invoice", "credit_memo", "service_charge", "statement"];

/** The columns every reader of supplier_invoices asks for. One list, so no reader is short one. */
export const SUPPLIER_INVOICE_COLUMNS =
  "id, supplier_account_id, invoice_number, kind, invoice_date, due_date, job_name_raw, job_id, total, open_balance, closed, discount_amount, discount_by, source_file, jobs(name)";

/** The same list with Waiting On A Credit's stamp (0346). Read first; see readSupplierDocuments. */
export const SUPPLIER_INVOICE_COLUMNS_WITH_WAIT = `${SUPPLIER_INVOICE_COLUMNS}, waiting_credit_since`;

/** What Waiting On A Credit says before 0346 is applied, instead of failing. */
export const WAIT_NEEDS_UPDATE = "Waiting On A Credit needs one database update. Nothing was changed; the bill is still here.";

/** The one error a select naming a not-yet-applied 0346 column fails with, and nothing else. */
export function isMissingWaitColumn(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "42703" || code === "PGRST204" || (msg.includes("waiting_credit") && /does not exist|could not find/i.test(msg));
}

/**
 * EVERY SUPPLIER DOCUMENT IN THE ORG, WITH ITS WAIT STAMP WHEN THE DATABASE HAS ONE. A push deploys
 * before its migration runs: without 0346 the select naming waiting_credit_since fails whole, and
 * that read is every card on My Day and /bills. So it is asked for first and, on exactly that
 * error, asked again without it: nothing is waiting, and every card is where it was yesterday.
 * `waitReady` says which read answered (the card's button says it needs one database update).
 */
export async function readSupplierDocuments(
  supabase: any,
  orgId: string,
): Promise<{ data: any[] | null; error: unknown; waitReady: boolean }> {
  const read = (cols: string) =>
    supabase.from("supplier_invoices").select(cols).eq("org_id", orgId).order("invoice_date", { ascending: false }).limit(2000);
  const first = await read(SUPPLIER_INVOICE_COLUMNS_WITH_WAIT);
  if (!first?.error) return { data: first?.data ?? [], error: null, waitReady: true };
  if (!isMissingWaitColumn(first.error)) return { data: null, error: first.error, waitReady: false };
  const again = await read(SUPPLIER_INVOICE_COLUMNS);
  return { data: again?.error ? null : (again?.data ?? []), error: again?.error ?? null, waitReady: false };
}

export interface SupplierDocumentCoverage {
  /** One reconcile row per supplier document, billCount and samePurchase filled in. */
  rows: SupplierInvoiceRow[];
  /** Bills LINKED to each document (bill_supplier_invoices), by document id. */
  coveringBills: Map<string, Set<string>>;
  /** Bills CARRYING each document's number, by document id. */
  billsCarrying: Map<string, string[]>;
  aliasIndex: SupplierAliasIndex;
  /** WHO EACH PAPER BELONGS TO: bill id -> the account it resolves to and how (lib/supplier-owed).
   *  Handed out so a reader never has to resolve a second time and never has to read the raw
   *  column, which is how two figures on one screen came to be built from two sets of paper. */
  identity: Map<string, SupplierPaperIdentity>;
  identityIndex: SupplierIdentityIndex;
  /** THE ONE COVERING WALK's answer: what the supplier's papers cover, and what they call settled. */
  coverage: SupplierCoverage;
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
  /** The supplier accounts, so a paper can be placed by the account's OWN name as well as by an
   *  alias. Optional: without them identity falls back to filed-or-alias, which is what every
   *  reader did before 8a982483 and is still correct, just narrower. */
  accountRows?: any[];
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

  /**
   * WHO EACH PAPER BELONGS TO, WORKED OUT ONCE (8a982483).
   *
   * Everything below this line reads a RESOLVED account id, never the raw column. That is the one
   * change that makes the covering walk reach: `bills.supplier_account_id` is null on more than
   * half his book, so every earlier walk gated on it was structurally unable to find those papers
   * covered, settled, or anything else. A paper's account is now the one it is filed on, the one an
   * alias names, or the one whose own name it spells - decided in lib/supplier-owed.ts and nowhere
   * else.
   */
  const identityIndex = indexSupplierIdentity({
    accounts: ((input.accountRows ?? []) as any[]).map((a: any) => ({ id: a?.id, name: a?.name })),
    aliases: (input.aliasRows ?? []) as any[],
  });
  const identity = resolveSupplierPapers(
    ((input.bills ?? []) as any[]).map((b: any) => ({
      id: String(b.id),
      supplierAccountId: b.supplier_account_id ?? null,
      supplier: b.supplier ?? null,
    })),
    identityIndex,
  );

  const ledgerBills: LedgerBill[] = ((input.bills ?? []) as any[]).map((b: any) => {
    const named = namedNumbersOf({ notes: b.notes ?? null, line_items: b.line_items ?? b.bill_line_items ?? [] });
    return {
      id: String(b.id),
      supplier: b.supplier ?? null,
      // RESOLVED, not raw. `sameSupplier` decides by account whenever both sides have one, so
      // handing it the resolved id is what lets a paper nobody has filed yet be matched to the
      // supplier's own document by the number printed on it.
      supplier_account_id: identity.get(String(b.id))?.accountId ?? b.supplier_account_id ?? null,
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
      waitingCreditSince: r.waiting_credit_since ?? null,
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

  const coverage = supplierCoverage({
    documents: documents.map((d: any) => ({
      id: String(d.id),
      supplierAccountId: d.supplier_account_id ?? null,
      closed: d.closed === true,
    })),
    identity,
    linked: coveringBills,
    carrying: billsCarrying,
    papers: ((input.bills ?? []) as any[]).map((b: any) => ({
      id: String(b.id),
      supplierAccountId: b.supplier_account_id ?? null,
      supplier: b.supplier ?? null,
      status: b.status ?? null,
      supersededByBillId: b.superseded_by_bill_id ?? null,
    })),
  });

  return { rows, coveringBills, billsCarrying, aliasIndex, identity, identityIndex, coverage };
}

/**
 * THE BILLS THE SUPPLIER'S OWN BOOKS CALL SETTLED (8a982483). Pure.
 *
 * bills.status says HOW a bill was bought (on the account, or paid at the counter), never whether
 * the supplier has since been paid: applying a CED open list closes CED's DOCUMENTS
 * (supplier_invoices.closed) and touches no bill. So every ticket ever bought on account read
 * "Unpaid" under All Bills forever - "$10k Unpaid" over a Suppliers card saying "$5k Owed", the
 * same tickets twice, with the only explanation behind a Why? fold.
 *
 * A live, on-account bill is settled by the supplier when at least one document covering it on
 * ITS OWN account is closed and none covering it is still open. Covering is the same two routes
 * supplierDocumentRows counts (linked, or carrying the number), gated to the document's account
 * exactly as coveredBillIds is on the page. bills.status is never written: this is a reading.
 */
export function billsSettledBySupplier(input: {
  documents: { id: string; supplier_account_id?: string | null; closed?: boolean | null }[];
  bills: { id: string; supplier_account_id?: string | null; supplier?: string | null; status?: string | null; superseded_by_bill_id?: string | null }[];
  coveringBills: ReadonlyMap<string, ReadonlySet<string>>;
  billsCarrying: ReadonlyMap<string, readonly string[]>;
  /** The accounts and aliases, so a paper nobody filed can still be placed. Omitted means
   *  filed-only, which is the pre-8a982483 reach and the reason this reached one reader of four. */
  accountRows?: { id?: unknown; name?: unknown }[];
  aliasRows?: { alias?: unknown; supplier_account_id?: unknown }[];
}): Set<string> {
  const papers = (input.bills ?? []).map((b) => ({
    id: String(b.id),
    supplierAccountId: b.supplier_account_id ?? null,
    supplier: b.supplier ?? null,
    status: b.status ?? null,
    supersededByBillId: b.superseded_by_bill_id ?? null,
  }));
  const identity = resolveSupplierPapers(
    papers,
    indexSupplierIdentity({ accounts: input.accountRows ?? [], aliases: input.aliasRows ?? [] }),
  );
  return new Set(
    supplierCoverage({
      documents: (input.documents ?? []).map((d) => ({
        id: String(d.id),
        supplierAccountId: d.supplier_account_id ?? null,
        closed: d.closed === true,
      })),
      identity,
      linked: input.coveringBills,
      carrying: input.billsCarrying,
      papers,
    }).settledBySupplier,
  );
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
  /** Papers a person said wait on a credit, not back yet (0346): folded under their supplier on
   *  /bills, never a card. Absent on a feed built by hand (My Day never draws them). */
  waiting?: SupplierPaperCard[];
  /** false = Shop Stock is switched off (0352): no card offers the shelf. Absent = on, so a feed
   *  built without the switch is exactly today's. */
  shopStock?: false;
}

/**
 * THE DAY A COMPANY'S BOOKS BEGIN: the day it named (settings.books_begin, supplierPaperLine), or,
 * for a company that has not named one, its earliest scanned bill. A supplier paper dated before it
 * could not have been recorded here, so it never needs a person. /bills, My Day, Shop Stock and the
 * job page all read this, so a paper cannot be a card on one screen and "from before your books" on
 * another. `settings` is the org's settings object (or just `{ books_begin }`, readPaperSettings).
 */
export function booksBeginOn(settings: unknown, liveBills: { bill_date?: string | null }[]): string | null {
  return (
    supplierPaperLine(settings) ??
    (liveBills ?? [])
      .map((b) => String(b?.bill_date ?? "").slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()[0] ??
    null
  );
}

/**
 * THE TWO SETTINGS A SUPPLIER-PAPER READ NEEDS: the day the company's books begin and its clock,
 * read off the company's settings the way every page reads them (getOrgSettings). Org-filtered;
 * throws on a failed read so the caller says it couldn't check rather than drawing the line in the
 * wrong place.
 */
export async function readPaperSettings(supabase: any, orgId: string): Promise<{ books_begin: string | null; timezone: string }> {
  const { data, error } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  if (error) throw error;
  const settings = getOrgSettings(data && !Array.isArray(data) ? (data as { settings?: unknown }).settings : null);
  return { books_begin: settings.books_begin, timezone: settings.timezone };
}

/**
 * THE DAY A COMPANY'S BOOKS BEGIN, READ ON ITS OWN (NY-feeders, 0366): for a feeder that has no
 * bills read in hand (booksBeginOn takes the rows the supplier desk already read). The same order:
 *   1. the day the company named (settings.books_begin, through readPaperSettings);
 *   2. else its earliest live bill (superseded bills left out, as booksBeginOn's callers do);
 *   3. else the day the company was made (organizations.created_at, as a day on its own clock).
 * `orgId` is the signed-in person's company, from their profile: the org is read by that id, never
 * as "the first organization the session can see". Throws on a failed read (readPaperSettings'
 * rule), so the caller says it couldn't check rather than drawing the line in the wrong place. Null
 * only when the company row itself isn't there.
 */
export async function readBooksStart(supabase: any, orgId: string): Promise<string | null> {
  const settings = await readPaperSettings(supabase, orgId);
  if (settings.books_begin) return settings.books_begin;
  const { data: first, error: billErr } = await supabase
    .from("bills")
    .select("bill_date")
    .eq("org_id", orgId)
    .is("superseded_by_bill_id", null)
    .not("bill_date", "is", null)
    .order("bill_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (billErr) throw billErr;
  const billDay = String((first as { bill_date?: string | null } | null)?.bill_date ?? "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(billDay)) return billDay;
  const { data: org, error: orgErr } = await supabase.from("organizations").select("created_at").eq("id", orgId).maybeSingle();
  if (orgErr) throw orgErr;
  const made = Date.parse(String((org as { created_at?: string | null } | null)?.created_at ?? ""));
  return Number.isFinite(made) ? todayStrInTz(settings.timezone, new Date(made)) : null;
}

/** The cards, from rows already read. The ONE call My Day and /bills both make. */
export function supplierPaperFeed(input: {
  /** booksBeginOn: nothing dated before it is a card. */
  since: string | null;
  rows: SupplierInvoiceRow[];
  jobs: ReconcileJob[];
  accounts: { id: string; name: string | null }[];
  /** The ORG's today: a bill waiting on a credit comes back on its own after 30 days of it. */
  today?: string | null;
  /** The ORG's timezone: the day a wait was stamped is the company's day. */
  tz?: string | null;
  /** The Shop Stock switch (0352). false: the cards don't offer the shelf. Absent = on. */
  shopStock?: boolean;
}): SupplierPaperFeed {
  const names = new Map((input.accounts ?? []).map((a) => [String(a.id), shortSupplierName(a.name)]));
  const opts = {
    since: input.since,
    today: input.today ?? null,
    tz: input.tz ?? null,
    supplierName: (accountId: string | null) => (accountId && names.get(accountId)) || "The Supplier",
  };
  const cards = supplierPaperNeeds(input.rows, input.jobs, opts);
  const waiting = supplierPapersWaitingOnCredit(input.rows, input.jobs, opts);
  // Cancelled jobs are never offered in a picker; the matcher still sees them, as /bills's does.
  const jobs = (input.jobs ?? []).filter((j) => j.status !== "cancelled").map(paperJob);
  return { cards, jobs, waiting, ...(input.shopStock === false ? { shopStock: false as const } : {}) };
}

/** The one job a card would be filed on by a single tap: where it already sits, or the clear guess. */
export function cardJob(c: Pick<SupplierPaperCard, "state" | "onJob" | "suggestion">): PaperJob | null {
  return c.state === "record" ? (c.onJob ?? null) : (c.suggestion ?? null);
}

/**
 * ALREADY BILLED ON THE CARDS (0357, Erik 2026-09-26: "on supplier bills on my day inside needs action
 * should also be a button for already charged"). A card whose paper names or guesses ONE job (the
 * job it sits on, or the matcher's clear guess) gets Already Billed On J-010, but only where the
 * sheet it opens has a line to pick: the job's next New Invoice pulls its actuals and a bill that went
 * out could hold a charge (readAlreadyBilledReach, the same rule as the Costs tab and the sheet). A
 * card with chips, or nothing to go on, has no such door: the job is his to pick first, and the done
 * line then asks Already Billed On INV-x? itself. A lost read draws no door and is logged; every
 * other answer on the card is untouched. Staff only, like the cards.
 */
export async function withAlreadyBilledDoors(supabase: any, orgId: string, feed: SupplierPaperFeed): Promise<SupplierPaperFeed> {
  const jobIds = cardJobIds(feed);
  if (!orgId || !jobIds.length) return feed;
  try {
    const reach = await readAlreadyBilledReach(supabase, orgId, jobIds);
    return reach.ready ? cardsWithAlreadyBilled(feed, reach.jobs) : feed;
  } catch (e) {
    reportError("bills.alreadyBilledDoors", e, { cards: feed.cards.length });
    return feed;
  }
}

/** The jobs the cards would be filed on by one tap (cardJob), once each. */
export function cardJobIds(feed: SupplierPaperFeed | null | undefined): string[] {
  return [...new Set((feed?.cards ?? []).map((c) => cardJob(c)?.id).filter((x): x is string => !!x))];
}

/** Pure: each card whose one job can hold a charge gets Already Billed On that job. */
export function cardsWithAlreadyBilled(feed: SupplierPaperFeed, reach: ReadonlyMap<string, { charge: boolean }>): SupplierPaperFeed {
  const cards = feed.cards.map((c) => {
    const job = cardJob(c);
    return job && reach.get(job.id)?.charge ? { ...c, alreadyBilledOn: job } : c;
  });
  return { ...feed, cards };
}

/**
 * WHERE AN INVOICE STANDS ON /bills, by the rules the page's own lists use (audit v1018, class 14):
 *
 *   covered       a bill already covers it (a Record link, or a bill carrying its number)
 *   taken_back    a credit memo took it back (reversedPurchaseIds, or the credit it waited for)
 *   on_card       a Needs You card (supplierPaperNeeds)
 *   waiting       set aside waiting on a credit, not back yet (its supplier's Waiting On A Credit fold)
 *   not_in_books  listed under its supplier's Not In Your Books, where Record To Shelf is
 *   before_books  from before his books began: counted there, never listed
 *
 * So a door elsewhere (Shop Stock's Record To Shelf) is offered only where the fold will hold the
 * paper, and otherwise says why in words. Invoices only; `rows` are supplierDocumentRows' rows.
 */
export type SupplierPaperHome = "covered" | "taken_back" | "on_card" | "waiting" | "not_in_books" | "before_books";

export function supplierPaperHomes(
  rows: SupplierInvoiceRow[],
  opts: { since: string | null; today?: string | null; tz?: string | null },
): Map<string, SupplierPaperHome> {
  const out = new Map<string, SupplierPaperHome>();
  const cards = new Set(supplierPaperNeeds(rows, [], opts).map((c) => c.invoiceId));
  const waiting = new Set(supplierPapersWaitingOnCredit(rows, [], opts).map((c) => c.invoiceId));
  const byAccount = new Map<string, SupplierInvoiceRow[]>();
  for (const r of rows ?? []) {
    const key = String(r.supplierAccountId ?? "");
    byAccount.set(key, [...(byAccount.get(key) ?? []), r]);
  }
  for (const group of byAccount.values()) {
    const listed = new Set(invoicesNeedingBill(group, { since: opts.since }).rows.map((r) => r.id));
    for (const r of group) {
      if (r.kind !== "invoice") continue;
      const id = String(r.id);
      out.set(
        id,
        (Number(r.billCount) || 0) > 0
          ? "covered"
          : cards.has(id)
            ? "on_card"
            : waiting.has(id)
              ? "waiting"
              : listed.has(id)
                ? "not_in_books"
                : isBeforeLine(r.invoiceDate, opts.since)
                  ? "before_books"
                  : "taken_back",
      );
    }
  }
  return out;
}

/**
 * The same reading, read: the four reads /bills makes for it, org-filtered. Throws on any failed
 * read, so the caller says it couldn't check instead of offering a door to a fold that may not
 * hold the paper.
 */
export async function readSupplierPaperHomes(supabase: any, orgId: string, today: string): Promise<Map<string, SupplierPaperHome>> {
  const [docsRes, billsRes, linksRes, aliasRes, paperSettings] = await Promise.all([
    readSupplierDocuments(supabase, orgId),
    supabase
      .from("bills")
      .select("id, supplier, supplier_account_id, bill_number, supplier_invoice_number, amount, bill_date, job_id, is_statement, superseded_by_bill_id, notes, bill_line_items(description)")
      .eq("org_id", orgId)
      .is("superseded_by_bill_id", null)
      .limit(5000),
    supabase.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id").eq("org_id", orgId).limit(5000),
    supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", orgId).limit(2000),
    readPaperSettings(supabase, orgId),
  ]);
  for (const r of [docsRes, billsRes, linksRes, aliasRes]) if (r?.error) throw r.error;
  const bills = (billsRes.data ?? []) as any[];
  const { rows } = supplierDocumentRows({ documents: docsRes.data ?? [], bills, links: linksRes.data ?? [], aliasRows: aliasRes.data ?? [] });
  return supplierPaperHomes(rows, { since: booksBeginOn(paperSettings, bills), today, tz: paperSettings.timezone });
}

/** What My Day brings from the supplier's own papers: the cards, and the Pay By lines. */
export interface SupplierDesk {
  /** "Hey you, here's a bill": null when nothing is waiting (or a read it needs failed). */
  papers: SupplierPaperFeed | null;
  /** "Pay CED $X By Oct 10": supplierPayDue over the same rows. Empty when nothing is due soon. */
  payDue: SupplierPayDue[];
  /**
   * A READ THIS NEEDS FAILED (audit v1018, class 2), and which half it cost: `papers` (the cards
   * could not be worked out) or `pay` (the Pay By line could not). My Day says so in one line
   * (supplierDeskFailedItem) instead of reading a failed read as "nothing waiting, no discount due".
   */
  failed?: { papers: boolean; pay: boolean };
}

/**
 * THE MY DAY READ. Staff only (the caller gates it: these cards carry prices, and a tech never
 * sees a price). Every read filters org_id as well as leaning on RLS: a rule at one read path is a
 * convention, not a boundary. A read that fails is no cards (or no pay line) AND `failed` saying
 * which, never a crash of the inbox and never a quiet "nothing waiting" (audit v1018, class 2).
 *
 * ONE READ, TWO LINES. The Pay By line (supplier-pay-due.ts) is worked out from the same document
 * rows the cards are, so the two never hold different copies of CED's papers. `today` is the
 * ORG's today: it decides whether a discount is still alive. The seventh read is his live payments:
 * one dated inside this deadline's cycle is what clears the line (supplier-pay-due.ts,
 * sentThisCycle), keyed to the cheque, never to when a paper landed.
 */
export async function loadSupplierDesk(supabase: any, userId: string, today: string): Promise<SupplierDesk | null> {
  if (!userId) return null;
  // The company's settings ride on the same read (the embed follows profiles.org_id): the cards
  // follow the Shop Stock switch (0352) on My Day exactly as on /bills.
  const { data: me, error: meErr } = await supabase.from("profiles").select("org_id, organizations(settings)").eq("id", userId).maybeSingle();
  const orgId = String((me as { org_id?: string } | null)?.org_id ?? "");
  const orgRow = (me as { organizations?: { settings?: unknown } | { settings?: unknown }[] | null } | null)?.organizations;
  const shopStock = featureOn(getOrgSettings((Array.isArray(orgRow) ? orgRow[0] : orgRow)?.settings).features, "shop_stock");
  if (meErr) return { papers: null, payDue: [], failed: { papers: true, pay: true } };
  if (!orgId) return null;
  const [docsRes, billsRes, linksRes, aliasRes, jobsRes, acctRes, payRes, settingsRes] = await Promise.all([
    readSupplierDocuments(supabase, orgId),
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
    // The company's own line (books_begin); a lost read is no cards, never the line in the wrong place.
    readPaperSettings(supabase, orgId).then(
      (data) => ({ data, error: null }),
      (error: unknown) => ({ data: null, error }),
    ),
  ]);
  // The supplier's papers unread: neither the cards nor the pay line can be worked out, and saying
  // nothing would read as "nothing waiting". No supplier documents at all: nothing to bring him.
  if (docsRes?.error) return { papers: null, payDue: [], failed: { papers: true, pay: true } };
  if (!(docsRes?.data ?? []).length) return null;
  const accounts = acctRes?.error ? [] : ((acctRes?.data ?? []) as any[]);
  // A failed bills, links or aliases read would make covered papers look uncovered: false cards.
  const papersReadable = !(billsRes?.error || linksRes?.error || aliasRes?.error || jobsRes?.error || settingsRes?.error);
  const { rows } = supplierDocumentRows({
    documents: docsRes.data ?? [],
    bills: papersReadable ? (billsRes.data ?? []) : [],
    links: papersReadable ? (linksRes.data ?? []) : [],
    aliasRows: papersReadable ? (aliasRes?.data ?? []) : [],
  });
  const feed = papersReadable
    ? supplierPaperFeed({
        since: booksBeginOn(settingsRes.data, (billsRes.data ?? []) as any[]),
        rows,
        jobs: reconcileJobsOf(jobsRes.data ?? []),
        accounts,
        today,
        tz: settingsRes.data?.timezone ?? null,
        shopStock,
      })
    : null;
  // Already Billed On J-010 (0357) on the cards whose one job could hold it: one more breath, only
  // when a card waits (and only for the jobs the cards name).
  const papers = feed && feed.cards.length ? await withAlreadyBilledDoors(supabase, orgId, feed) : feed;
  // The pay line reads only the documents' own money (open balance, discount, its date), none of
  // which a bill or a link changes. It needs the accounts read: without the name and the on-account
  // flag there is no door to open (the /bills sheet is not drawn when that read fails either).
  // A failed payments read is no pay line rather than a line that ignores a payment he made: the
  // nag this read exists to end. The same discount is still on /bills.
  const payUnread = !!(acctRes?.error || payRes?.error);
  const payDue = payUnread ? [] : supplierPayDue({ rows, accounts, today, payments: payRes?.data ?? [] });
  const papersUnread = !papersReadable;
  return {
    papers,
    payDue,
    ...(papersUnread || payUnread ? { failed: { papers: papersUnread, pay: payUnread } } : {}),
  };
}
