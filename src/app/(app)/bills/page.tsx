import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { claimedIdsOfLines } from "@/lib/unbilled-work";
import { getOrgSettings } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";
import { todayStrInTz } from "@/lib/tz";
import { readBillInvoice } from "@/lib/supplier-identity";
import { Card } from "@/components/ui/card";
import { BillsReceipts } from "./bills-receipts";
import { AddByHandButton } from "./add-business-cost";
import { bucketOf } from "@/lib/business-cost-buckets";
import { isShelfTicket } from "@/lib/shelf-plan";
import { jobPickLabel } from "@/lib/job-pick-label";
import type { ReceiptForBilling } from "./receipt-billing-card";
// THE PILES, FROM THE ONE MODULE BOTH PAGES READ. The doors that answer them are on /reconcile;
// this page keeps the two readings it still has a sentence for (the Suppliers card's File It line,
// and the Needs You pointer at a ticket filed twice).
import {
  duplicateTicketGroups,
  isOpenDuplicateGroup,
  unassignedTotals,
  unfiledSpellings,
} from "./supplier-name-work";
import { FoldOpener } from "@/components/fold-opener";
import {
  creditWait,
  explainKind,
  isBeforeLine,
  isUsableJobName,
  sayKind,
  shortSupplierName,
  supplierPaperLine,
  type SupplierInvoiceRow as SupplierDocumentRow,
} from "./supplier-reconcile";
import { moneyWords, wordsOf, type BillsSearchRow } from "./bills-search";
import { billsPaperDoor } from "./paper-door";
import { BillsSearchBox, BillsSearchProvider } from "./bills-search-box";
import { SupplierPaperCards } from "@/components/supplier-paper-cards";
import { formatCurrency, formatDateShort } from "@/lib/utils";
import {
  booksBeginOn,
  cardJobIds,
  cardsWithAlreadyBilled,
  readSupplierDocuments,
  reconcileJobsOf,
  supplierDocumentRows,
  supplierPaperFeed,
  withAlreadyBilledDoors,
} from "./supplier-papers";
import { readAlreadyBilledReach, type AlreadyBilledReach } from "@/lib/already-billed-read";
import { billAlreadyBilledDoors } from "@/lib/already-billed";
import { reportError } from "@/lib/observe";
import { BooksBeginLine } from "./books-begin-line";
import { NeedsYou, PaperworkDropZone } from "./bills-drop";
import { SnapOrNoteButton } from "@/components/snap-or-note";
import { openListViews } from "./open-list-core";
import { bankLinesStayHere, bankViews } from "./bank-core";
import type { BankView } from "@/lib/bank-download";
import type { OpenListView } from "@/lib/supplier-open-list";
import type { PaperRowItem } from "@/components/paperwork-row";
import { readinessOf, type NumberMatch } from "@/lib/paperwork";
import { loadBooks, loadMarkContext, matchesOnBooks, PAPER_JOB_STATUSES, rematchTray } from "@/app/(app)/organize/paperwork-core";
import { signDocumentUrls } from "@/lib/signed-docs";
import { billOfTie, billPapers, type PaperTie } from "@/lib/job-photos";
import {
  isOnAccountBill,
  supplierBalance,
  type SupplierAccountRow,
  type SupplierBillRow,
} from "./supplier-balance";
import {
  billSettledLabel,
  supplierBalancesUnread,
  supplierFigureUnread,
  whatIBoughtNotSettled,
  whatISupplierOwed,
} from "@/lib/supplier-owed";
import { SuppliersCard } from "./suppliers-card";
import {
  recordSupplierPayment,
  setSupplierOnAccount,
  voidSupplierPayment,
  setSupplierInvoiceJob,
  recordSupplierInvoiceAsBill,
  recordSupplierInvoiceToShelf,
  supplierInvoiceShelfLines,
  tieSupplierInvoiceToBill,
  updateSupplierAccount,
} from "./supplier-actions";
import { stopWaitingOnCredit } from "./waiting-credit-actions";

export const dynamic = "force-dynamic";
// Read Now and Read Again on a card read a paper inside this page's server actions: a 12-page CED
// PDF gets the reader's own time, not the platform default (audit v994, SI4). A paper put in
// through Snap Or Note is read on its own route (/api/paperwork/read), with the same 60 seconds.
export const maxDuration = 60;

/**
 * The bills ledger, with each receipt's lines. `billable` (0268) and the line's own id ride along
 * for the receipt-billing card: it writes one line at a time, so it needs the id, and it shows
 * what the customer is actually charged for a receipt, so it needs the flag. The ledger itself
 * ignores both. The 0270 trio - which supplier ACCOUNT this bill belongs to, the supplier's own
 * invoice number, and whether the document is a statement covering several invoices - rides along
 * for the supplier card.
 *
 * AND IT SURVIVES ITS OWN MIGRATION NOT BEING THERE. A push deploys before its migration runs, and
 * PostgREST rejects the WHOLE query for one unknown column - the exact failure that made PO-003
 * render as an empty purchase order under a $3,274 total (bug 7a6b17a8). Here the casualty would
 * be every bill on the page, so the one error shape a missing column makes walks DOWN a ladder,
 * dropping the newest columns first and the oldest last. A line that comes back with no flag reads
 * as billed, which is what the column defaults to; a bill that comes back with no account reads as
 * unfiled, which is what every bill was the day before 0270.
 */
type BillColumns = { billable: boolean; supplierAccount: boolean; supersede: boolean };

/** The one error shape a column the database hasn't got yet makes. Matched on the code first,
 *  because the message wording is PostgREST's to change; the names are the fallback for a proxy
 *  that swallows the code. */
function isMissingColumn(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const message = String((err as { message?: string })?.message ?? "");
  return (
    code === "42703" ||
    /does not exist/i.test(message) ||
    /\b(billable|supplier_account_id|supplier_invoice_number|is_statement|superseded_by_bill_id|pricing_provisional)\b/i.test(
      message,
    )
  );
}

/** scope_category sits on the BASE rung on purpose (item C1): it is migration 0105, older than every
 *  column the ladder drops, so a database that has any of those has it too. THE PROJECTION LAW — the
 *  Edit Bill box opens on this value and saves it back, so a row that arrives without it would clear
 *  the part of the job somebody had set. */
async function readBills(supabase: Awaited<ReturnType<typeof createClient>>) {
  const columns = (o: BillColumns) =>
    `id, supplier, bill_number, amount, status, bill_date, job_id, po_id, category, notes, scope_category${o.supplierAccount ? ", supplier_account_id, supplier_invoice_number, is_statement" : ""}${o.supersede ? ", superseded_by_bill_id, pricing_provisional" : ""}, jobs(job_number, name), bill_line_items(id, description, quantity, unit_price, amount, category${o.billable ? ", billable, billed_amount, is_stock" : ""}, sort_order)`;
  const read = (o: BillColumns) =>
    supabase.from("bills").select(columns(o)).order("created_at", { ascending: false });

  // Newest columns fall off first. Four attempts is the worst case and it only happens on a
  // database that is behind the deploy; the normal path is one query, same as before.
  const ladder: BillColumns[] = [
    { billable: true, supplierAccount: true, supersede: true },
    { billable: true, supplierAccount: true, supersede: false },
    { billable: true, supplierAccount: false, supersede: false },
    { billable: false, supplierAccount: false, supersede: false },
  ];
  let attempt = await read(ladder[0]);
  for (let i = 1; i < ladder.length; i++) {
    if (!attempt.error || !isMissingColumn(attempt.error)) return attempt;
    attempt = await read(ladder[i]);
  }
  return attempt;
}


export default async function BillsPage({
  searchParams,
}: {
  /**
   * `pay` is My Day's "Pay CED $X By Oct 10" door (supplier-pay-item.ts): the account whose
   * Record A Payment sheet opens on arrival. The sheet is the one that already exists. (The paste
   * box's `?import=` banner went with the paste box: pasted invoice text is imported from Snap Or
   * Note's note box now, and its line there says what came in.)
   */
  searchParams?: Promise<{ pay?: string }>;
}) {
  const { pay: payOn } = (await searchParams) ?? {};
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id, role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  const orgId = profile?.org_id ?? "";
  // Company settings (books_begin among them) are owner/admin writes (organizations_update).
  const canChangeSettings = profile?.role === "owner" || profile?.role === "admin";

  // EVERYTHING THIS PAGE NEEDS, IN ONE BREATH. The supplier reads (0270) join the existing five
  // rather than hanging off them, because a serial hop added to a page read is the phone-lag class
  // all over again (audit v921: the app was awaiting a ~31-query badge before every page). None of
  // them depends on the others, and a database without 0270 answers them with an error and a null
  // - which reads here as "no accounts yet", exactly the state Erik is in today.
  const [
    { data: pos },
    { data: bills, error: billsErr },
    { data: docRows },
    { data: jobs, error: jobsErr },
    { data: lists },
    { data: accountRows, error: accountsErr },
    { data: aliasRows, error: aliasErr },
    { data: paymentRows, error: paymentsErr },
    { data: orgRow },
    { data: invoiceRows, error: invoicesErr },
    { data: billLinkRows, error: linksErr },
    { data: paperRows, error: trayErr },
    books,
    markCtx,
    shelfLotsRead,
    shelfItemsRead,
    { data: billTieRows, error: billTiesErr },
  ] = await Promise.all([
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
    // status and address ride along for the supplier-invoice job picker (0273): CED's job name is
    // "5659 RHODESIA", "561 RHODESIA", "5661 RHODESIA" and "5659 RODESSIA" for ONE road he has
    // five jobs on, and a picker with nothing but a name on it cannot tell them apart. The limit
    // went from 100 to 500 for the same reason - a job missing from the list is a document he
    // cannot file, which is a dead end wearing a dropdown.
    supabase
      .from("jobs")
      .select("id, job_number, name, status, address, created_at")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("material_lists").select("id, name").order("created_at", { ascending: false }).limit(100),
    supabase
      .from("supplier_accounts")
      .select("id, name, account_number, branch_code, on_account, note")
      .order("name", { ascending: true })
      .limit(500),
    supabase
      .from("supplier_aliases")
      .select("id, supplier_account_id, alias, branch_label")
      .order("alias", { ascending: true })
      .limit(2000),
    // VOIDED PAYMENTS COME BACK TOO. They stop counting and they stay on the screen - that is the
    // whole difference between voiding and deleting, and a list that hid them would leave a
    // balance that moved with nothing on the page to explain it.
    supabase
      .from("supplier_payments")
      .select("id, supplier_account_id, amount, paid_on, method, reference, note, voided_at")
      .order("paid_on", { ascending: false })
      .limit(2000),
    // THE ORG'S TODAY, never the browser's day. It dates a payment and it ages a bill, and a
    // check written at 5pm in Truckee is not tomorrow's check.
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    // ── THE SUPPLIER'S OWN DOCUMENTS (migration 0273) ────────────────────────────────────────
    // They join this breath rather than hanging off it. A serial hop added to a page read is the
    // phone-lag class all over again (audit v921: the shell was awaiting a ~31-query badge before
    // every page), and these depend on nothing above them. A database without 0273 answers both
    // with an error and a null, which reads here as "no supplier documents" - model A, exactly the
    // page he had yesterday.
    // One read for every reader (supplier-papers.ts), so My Day's cards and this page can never be
    // handed different documents. It carries Waiting On A Credit's stamp when 0346 is on, and
    // retries without it when it is not.
    readSupplierDocuments(supabase, orgId),
    // Which scanned bills cover which supplier invoices. A document with no link is a purchase
    // the app has no record of at all, which is $1,765.72 of his tonight.
    //
    // BOTH COLUMNS, AND THE BILL ID IS THE ONE THAT WAS MISSING (review of cn-v966). The read
    // further down does `String(l.bill_id ?? "")` on every one of these 21 rows, and a column
    // left out of a select list does not come back null - it is not there at all, so the `?? ""`
    // never fired and every link collapsed to the nine-letter string "undefined". The set that
    // is meant to hold WHICH BILLS cover an invoice held one sentinel instead, so a bill that is
    // both linked to an invoice and names it on its own lines counted as two, and no filter over
    // those ids (superseded, on a job, on this account) could ever have been written. The failure
    // is always a select list - and `?? ""` cannot defend a column that was never asked for.
    supabase.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id").limit(5000),
    // ── PAPER WAITING FOR FILE IT (0295) ────────────────────────────────────────────────────
    // One inbox with Organize: every receipt or bill that has been read and not filed, whichever
    // door it came in by. `*` so a database without 0295 still answers (the new columns simply
    // are not there), and filtered in code for the same reason.
    supabase
      .from("organized_items")
      .select("*, jobs(job_number, name)")
      .eq("status", "needs_review")
      .order("created_at", { ascending: false })
      .limit(200),
    // Every printed number already on the books, for "Same Purchase: Tie Them".
    loadBooks(supabase, orgId),
    // What a waiting paper names, matched again by today's rules (rematchTray: no model, no write).
    loadMarkContext(supabase, orgId),
    // THE ROLLS ON THE SHELF, by the receipt line each came off (Shop Stock, Phase 2): the receipt
    // card says "220 ft on the shelf ($158.55)" beside the line. Small (one row per roll) and
    // dependent on nothing above, so it rides in this breath. Staff-only by RLS; a database before
    // 0303 answers with an error, which reads as no rolls.
    supabase
      .from("stock_lot_balance")
      .select("lot_id, bill_line_id, item_id, pieces, unit, cost, pieces_left, cost_left, live_moves, cost_stale")
      .eq("live", true)
      .not("bill_line_id", "is", null)
      .limit(5000),
    // The items' names, for the same sentence (a view embed is PostgREST's guess; this is not).
    supabase.from("inventory_items").select("id, name").limit(5000),
    // EACH BILL'S OWN PAPER (Erik, 2026-09-27: bills and job photos kept separate): the links the
    // receipt reader, Add Cost and File It write, so a bill's row opens the receipt it was read from.
    // Small (one row per paper that made or joined a bill) and dependent on nothing above. The
    // document it names rides along too: a receipt file those links hold is on a bill, and All Bills
    // lists only the files no bill holds yet (W1-32).
    supabase
      .from("organized_items")
      .select("id, kind, category, bill_id, tied_bill_id, file_url, document_id")
      .eq("org_id", orgId)
      .or("bill_id.not.is.null,tied_bill_id.not.is.null")
      .not("file_url", "is", null)
      .limit(5000),
  ]);
  const orgSettings = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings);
  const orgTz = orgSettings.timezone;
  const today = todayStrInTz(orgTz);
  // THE SWITCHES (0352): Shop Stock and Purchase Orders hide their doors on this page. Nothing they
  // saved is hidden from the books: open POs count, a roll on the shelf keeps its line. The page
  // already holds the company's settings and the viewer's role, so they need no second read.
  const shopStock = featureOn(orgSettings.features, "shop_stock");
  const switches = { features: orgSettings.features, isOwner: profile?.role === "owner" };

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
  /**
   * A SET-ASIDE DUPLICATE MUST NOT BE OFFERED FOR BILLING (review of cn-v963). `liveBills` is
   * hoisted here from further down the file because this was the first place that needed it and did
   * not have it: receiptBills was built off every bill, so the copy Erik had just marked as the
   * duplicate kept its eight line items, kept its card, and could have its lines imported onto an
   * invoice - charging the homeowner for one CED ticket twice, through the very screen built to
   * stop that happening.
   */
  const liveBills = (billsWithLines as any[]).filter((b) => !b.superseded_by_bill_id);
  const receiptBills = liveBills.filter((b: any) => b.job_id && (b.line_items?.length ?? 0) > 0);
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
  // ONE PAPER DOOR (W1-30): a paper put in through Snap Or Note is source "organize", so one the
  // reader hasn't finished (not read yet, or too big) is drawn here too, with its Read Now, exactly
  // as one dropped on this page always was: it may well be a bill.
  const papers = ((paperRows ?? []) as any[]).filter(
    (i) =>
      i.kind === "receipt" ||
      i.source === "bills_drop" ||
      (i.doc_type && i.doc_type !== "not_a_cost") ||
      (i.kind !== "note" && !!i.file_url && ["not_read", "too_big"].includes(readinessOf(i).state)),
  );
  let paperUrls = new Map<string, string>();
  const signPapers = async () => {
    paperUrls = await signDocumentUrls(supabase, papers.map((i) => i.file_url));
  };
  // A SUPPLIER'S OPEN LIST waiting under Needs You is compared against that supplier's papers as
  // the page loads, so its card is never stale (open-list-core). Nothing waiting, nothing read.
  let listViews: Record<string, OpenListView> = {};
  const viewLists = async () => {
    listViews = await openListViews(supabase, orgId, papers);
  };
  // ALREADY BILLED ON THE BILL'S OWN ROW (0357, Erik: "the Already Billed could connect to the bill on
  // that screen too"). Where each live bill's job could hold it, what the jobs' invoices hold, and
  // which bills a person marked: the same reading the Costs tab and the sheet use
  // (readAlreadyBilledReach). It rides this breath (it needs only the bills). A lost read is logged
  // and draws no door (the Costs tab still has them); nothing else on the page depends on it.
  const abBills = liveBills.filter((b: any) => b.job_id);
  let abReach: AlreadyBilledReach | null = null;
  const readAbReach = async () => {
    if (!abBills.length) return;
    try {
      abReach = await readAlreadyBilledReach(
        supabase,
        orgId,
        abBills.map((b: any) => String(b.job_id)),
        abBills.flatMap((b: any) => [b.id, b.po_id].filter(Boolean).map(String)),
      );
    } catch (e) {
      reportError("bills.alreadyBilledReach", e, { bills: abBills.length });
    }
  };
  // Each bill's own paper, signed in the same breath (never a hop of its own). A lost links read is
  // logged, and the rows draw no paper door, so All Bills says so above them (a bill with a receipt
  // must not look like one that never had any); the Receipts tab below still lists every receipt.
  if (billTiesErr) reportError("bills.paperTies", billTiesErr, {});
  const billTies = (billTieRows ?? []) as PaperTie[];
  let billPaperUrls = new Map<string, string>();
  const signBillPapers = async () => {
    billPaperUrls = await signDocumentUrls(supabase, billTies.map((t) => t.file_url));
  };
  // A BANK DOWNLOAD waiting under Needs You is sorted against the books as the page loads (bank-core),
  // so its card is never stale. Nothing waiting, nothing read.
  let bankCards: Record<string, BankView> = {};
  const viewBanks = async () => {
    bankCards = await bankViews(supabase, orgId, papers);
  };
  await Promise.all([signPaths(), readClaims(), signPapers(), viewLists(), readAbReach(), signBillPapers(), viewBanks()]);
  // A bank download's own lines never go to the browser: its card is `bank` (bankLinesStayHere).
  const paperItems: PaperRowItem[] = rematchTray(papers, markCtx).map((i) => ({
    ...bankLinesStayHere(i, bankCards[i.id]),
    signedUrl: (i.file_url && paperUrls.get(i.file_url)) || null,
    open_list: listViews[i.id] ?? null,
    bank: bankCards[i.id] ?? null,
  }));
  const paperMatches: Record<string, NumberMatch[]> = Object.fromEntries(paperItems.map((i) => [i.id, matchesOnBooks(i, books)]));
  // Open AND finished jobs (audit v994, PR1): a ticket that lands after a job is complete is still
  // that job's cost. Never a cancelled one.
  const paperStatuses = PAPER_JOB_STATUSES as readonly string[];
  const paperJobs = ((jobs ?? []) as { id: string; job_number: string; name: string; status?: string | null }[]).filter(
    (j) => !j.status || paperStatuses.includes(j.status),
  );
  const docs = (docRows ?? []).map((d: any) => ({ ...d, signedUrl: (d.file_url && signed.get(d.file_url)) || null }));
  // THE RECEIPT FILES NO BILL HOLDS YET (W1-32): All Bills lists a file only while it is on no bill;
  // one that made a bill opens from that bill's own row. A link names its document, or its file (the
  // job's Receipts & Papers reads them the same way). With the links unread, every file is listed,
  // under the sentence saying they couldn't be read.
  const tiedDocs = new Set<string>();
  const tiedPaths = new Set<string>();
  for (const t of (billTieRows ?? []) as PaperTie[]) {
    if (!billOfTie(t)) continue;
    if (t.document_id) tiedDocs.add(String(t.document_id));
    if (t.file_url) tiedPaths.add(String(t.file_url));
  }
  const looseDocs = billTiesErr ? docs : docs.filter((d: any) => !tiedDocs.has(String(d.id)) && !(d.file_url && tiedPaths.has(String(d.file_url))));

  // Each live roll by the receipt line it came off. A read that failed leaves this empty, and the
  // card then offers Put The Rest On The Shelf on a line whose roll is already there - which the
  // server refuses in words ("already on the shelf"), so the wrong is a sentence, never a double.
  const itemNames = new Map<string, string>(((shelfItemsRead?.data ?? []) as any[]).map((i) => [String(i.id), String(i.name ?? "")]));
  const shelfByLine = new Map<string, NonNullable<ReceiptForBilling["lines"][number]["shelf"]>>();
  for (const r of ((shelfLotsRead?.error ? [] : shelfLotsRead?.data) ?? []) as any[]) {
    if (!r?.bill_line_id) continue;
    shelfByLine.set(String(r.bill_line_id), {
      lotId: String(r.lot_id),
      itemName: itemNames.get(String(r.item_id)) ?? "In stock",
      pieces: Number(r.pieces) || 0,
      unit: String(r.unit ?? ""),
      cost: Number(r.cost) || 0,
      piecesLeft: Number(r.pieces_left) || 0,
      costLeft: Number(r.cost_left) || 0,
      liveMoves: Number(r.live_moves) || 0,
      stale: r.cost_stale === true,
    });
  }

  const receiptsForBilling: ReceiptForBilling[] = receiptBills.map((b: any) => ({
    id: String(b.id),
    supplier: b.supplier ?? "Receipt",
    bill_date: b.bill_date ?? null,
    job_id: b.job_id ?? null,
    job_name: b.jobs?.name ?? null,
    amount: Number(b.amount) || 0,
    // A receipt whose ORDER is already billed is held too (review of Phase 2): the importer skips
    // it (the customer paid for the delivery through the PO line), so its lines are as settled as
    // a claimed receipt's, and Put The Rest On The Shelf on it would put a paid-for coil on the shelf.
    billedOn: billedOn.get(String(b.id)) ?? (b.po_id ? billedOn.get(String(b.po_id)) ?? null : null),
    lines: (b.line_items ?? []).map((l: any) => ({
      id: String(l.id),
      description: String(l.description ?? ""),
      quantity: Number(l.quantity) || 0,
      amount: Number(l.amount) || 0,
      // THE SELECT ALREADY FETCHES IT AND THIS MAP WAS DROPPING IT (review, 2026-09-19). A line
      // with a $0.00 extension and a real price beside it costs the invoice $38.98 and cost this
      // card $0.00, and because the card's tax share is proportional that skewed every exclusion
      // on the same receipt. The failure is always a select list - or the map right after it.
      unitPrice: l.unit_price == null ? null : Number(l.unit_price),
      category: l.category ?? null,
      // A row written before 0268 ran comes back without the column at all. Reading a missing
      // flag as "not billed" would take money off invoices nobody asked to change, so the
      // absence means billed — the same direction the column's own default takes.
      billable: l.billable !== false,
      // THE THIRD STATE (0272). A container bought whole and used in pieces: a 500ct box of wire
      // nuts at $108.36, of which this job used sixty. `billedAmount` is what THIS job takes, in
      // dollars of cost; null means the whole line, which is what every row written before 0272
      // means and keeps meaning.
      billedAmount: l.billed_amount == null ? null : Number(l.billed_amount),
      isStock: l.is_stock === true,
      shelf: shelfByLine.get(String(l.id)) ?? null,
    })),
  }));

  // ── WHAT HE OWES HIS SUPPLIERS (migration 0270) ─────────────────────────────────────────────
  //
  // Owed = an account's UNPAID bills minus its live payments. The same Earned-minus-Paid shape
  // payroll settled on two nights ago, for the reason he gave for both:
  //
  //   "yes i pay them in chunks that never match the ticckets"
  //
  // THE ARITHMETIC IS NOT DONE HERE. supplierBalance() is a pure function with a test around it and
  // the card calls it on the rows this page hands over. A second copy of a money rule on a page is
  // how two screens end up disagreeing about the same dollar (the 24%-vs-82% budget bug, audit
  // v800), so this file's whole job is to hand over rows, spelled and totalled once. The spelling
  // key itself is `aliasKey`, inside supplier-name-work.ts — what `supplier_aliases` is unique on,
  // what a press actually moves bills by, and what the resolver groups a paper on no account under.

  const supplierPayments = ((paymentRows ?? []) as any[]).map((r) => ({
    id: String(r.id),
    accountId: String(r.supplier_account_id ?? ""),
    amount: Number(r.amount) || 0,
    paidOn: String(r.paid_on ?? ""),
    method: String(r.method ?? "other"),
    reference: r.reference ?? null,
    note: r.note ?? null,
    // A VOIDED PAYMENT IS A FACT, NOT AN ABSENCE. It stays on the list, crossed out, and stops
    // counting - void, never delete, like every other money row in this app.
    voided: !!r.voided_at,
  }));

  const toBillRow = (b: any): SupplierBillRow => ({
    id: String(b.id),
    supplier: String(b.supplier ?? ""),
    billDate: b.bill_date ?? null,
    amount: Number(b.amount) || 0,
    status: String(b.status ?? ""),
    jobId: b.job_id ?? null,
    jobName: b.jobs?.name ?? null,
    // THE NUMBER IS ALREADY IN THE DATA, AND NOTHING WAS READING IT HERE (review, 2026-09-19).
    // `supplier_invoice_number` is a column nothing in the tree writes yet, so it is null on all
    // 21 bills and these rows would have shown no invoice number for the life of the feature -
    // while the duplicate finder further down was reading it perfectly well out of the very same
    // bills. readBillInvoice recovers it from the CED portal filename sitting in `notes`
    // (TR-34426_20260616_32136931_...) or from the numbers OCR captured inside line text
    // ("(Invoice 8802-1101363)"). Persisting it is a later job; reading it costs nothing.
    ...(() => {
      const stored = b.supplier_invoice_number ?? null;
      if (stored) return { invoiceNumber: stored, isStatement: !!b.is_statement };
      const reading = readBillInvoice({
        notes: b.notes ?? null,
        lineDescriptions: (b.line_items ?? []).map((l: any) => l.description),
      });
      return {
        invoiceNumber: reading.invoiceNumber,
        // A document carrying more than one invoice number IS a statement, whatever the column says
        // - which is what arrived in his email import.
        isStatement: !!b.is_statement || reading.isStatement,
      };
    })(),
  });

  // A SUPERSEDED BILL STOPS COUNTING (0271). It keeps its rows and its history and it still shows
  // in the ledger below; it just never lands in a balance, because the bill that replaced it
  // already has. Counting both is the duplicate problem wearing a different hat.

  const aliasesOf = new Map<string, { alias: string; branchLabel: string | null }[]>();
  for (const a of (aliasRows ?? []) as any[]) {
    const key = String(a.supplier_account_id ?? "");
    if (!key) continue;
    aliasesOf.set(key, [
      ...(aliasesOf.get(key) ?? []),
      { alias: String(a.alias ?? ""), branchLabel: a.branch_label ?? null },
    ]);
  }

  // `billsOf` is built further down, AFTER identity is worked out: which account a paper belongs
  // to is not a column on it, and keying this off the raw column is the fault behind 8a982483.

  // ── WHAT THE SUPPLIER ITSELF SAYS (migration 0273) ──────────────────────────────────────────
  //
  // THE BUG THIS EXISTS TO END, in his own figures. The balance shipped as
  //
  //     Owed = unpaid bills - live payments
  //
  // which is right while nobody knows which invoices a cheque settled, and WRONG the moment the
  // supplier tells you. After nine of his bills were marked paid off CED's own documents, that
  // arithmetic read $7,360.93 - $6,000 = $1,360.93 against CED's $3,845.14: his $6,000 of payments
  // is ALREADY inside what CED calls closed, so subtracting it again counts the same money twice,
  // in the other direction. Two models, and they must never be mixed:
  //
  //     A. no supplier data   ->  unpaid bills minus live payments   (still right, still the default)
  //     B. supplier invoices  ->  the sum of what the supplier calls open  (exact, and what CED says)
  //
  // NONE OF THAT ARITHMETIC HAPPENS HERE. supplierBalance() picks the model off the rows this page
  // hands over, and it is pure with a test around it. This file's whole job is to hand over rows,
  // spelled and totalled once: a second copy of a money rule on a page is how two screens end up
  // disagreeing about one dollar (the 24%-vs-82% budget bug, audit v800).
  /**
   * WHICH BILLS ALREADY COVER THIS INVOICE — and a link is only one of the two ways they can.
   *
   * `bill_supplier_invoices` is written by exactly one action, the Record button. Every bill in
   * his books before that was a SCAN, and a scan of a STATEMENT covers several invoices at once:
   * his $3,034.54 is 8802-1105868 plus 8802-1105963, and his $162.32 is 8802-1103059 plus
   * 8802-1103061. Counting links alone said neither of those four was in his books, so the list
   * offered to record all four - and taking that offer would put the money on the job twice, once
   * inside the statement and once beside it (review, 2026-09-19).
   *
   * THE READING LIVES IN supplier-papers.ts NOW (Bills plan, Wave A): My Day brings these same
   * papers to him as cards, and a second copy of "is this paper already in his books?" on the
   * second screen is how the two would come to disagree about which bill is waiting.
   */
  const {
    rows: supplierDocuments,
    coveringBills,
    billsCarrying,
    identity: supplierOf,
    coverage,
  } = supplierDocumentRows({
    documents: (invoiceRows ?? []) as any[],
    bills: liveBills,
    links: (billLinkRows ?? []) as any[],
    aliasRows: (aliasRows ?? []) as any[],
    // THE ACCOUNTS THEMSELVES, so a paper can be placed by the account's OWN name. Without this a
    // ticket scanned under the name on the account it belongs to resolved to nothing, landed in
    // the unfiled pile, and was counted under a heading that said "Owed" - which is the mechanical
    // half of 8a982483.
    accountRows: (accountRows ?? []) as any[],
  });
  const documentsOf = new Map<string, SupplierDocumentRow[]>();
  for (const row of supplierDocuments) {
    const accountId = String(row.supplierAccountId ?? "");
    if (accountId) documentsOf.set(accountId, [...(documentsOf.get(accountId) ?? []), row]);
  }

  // ── THE BILLS THE SUPPLIER HAS NO DOCUMENT FOR (review of cn-v966) ──────────────────────────
  //
  // Model B says "owed is what the supplier still calls open", and that is right for every
  // purchase the supplier issued paper for. It is not right for one they never issued paper for
  // and never will: bill c0535cdb, the $467.87 Sunnyvale counter ticket he bought on his Truckee
  // account. CED Truckee will not be sending a document that covers a Sunnyvale branch ticket,
  // so that money sits in no balance on this page - while the card explained the whole unpaid
  // pile away as "your paperwork rather than theirs", which is true of the other eleven bills on
  // that account and flatly false of this one.
  //
  // THE BALANCE DOES NOT MOVE. Folding it into `owed` would invite a cheque for money CED has
  // not billed him, and the app SUGGESTS while a person DECIDES. All this does is name the slice
  // so it has a home on the screen instead of falling between two figures.
  //
  // A document covers a bill by being LINKED to it, or by having its number read off the bill's
  // own lines - the same two routes `billCount` above counts - and only when the bill is filed
  // on THAT document's account, so a number belonging to another supplier can never mark a bill
  // covered.
  // ONE WALK, NOT FOUR (8a982483). This page built its own, supplier-papers.ts built a second for
  // the settled set, and the P&L card built a third with no alias index - so the P&L and this page
  // could name different bills as covering the same paper on identical rows. `supplierCoverage` in
  // lib/supplier-owed.ts is the walk now, it runs once in supplierDocumentRows above, and it gates
  // on the account a paper RESOLVES to rather than the column it happens to carry.
  const coveredBillIds = coverage.covered;

  // ── THE BILLS THE SUPPLIER'S OWN BOOKS CALL SETTLED (8a982483) ──────────────────────────────
  // Same walk as coverBill, and the document's `closed` (an applied open list) is what the ledger
  // was never told: an on-account bill every covering document from its own account calls closed
  // is settled in the supplier's books, so All Bills stops counting it as Unpaid and its row says
  // "Settled · CED Says". bills.status is not written. A lost links read would make a bill covered
  // only by a Record link look open again, so, like noSupplierDocument, nothing is settled until
  // the links read.
  const settledBySupplierIds: ReadonlySet<string> = linksErr ? new Set<string>() : coverage.settledBySupplier;

  // ── WHO EACH PAPER BELONGS TO, AND THE ROWS THAT HANG OFF IT ────────────────────────────────
  // Built here, after identity, so every pile on this page is cut from the SAME set of paper. The
  // two figures Erik was reading were not disagreeing about a rule, they were looking at different
  // bills: one reached its papers through the stored column and the other grouped the typed-in
  // spelling. There is one road to a supplier now and this is it.
  const accountOfBill = (id: string) => supplierOf.get(String(id))?.accountId ?? null;
  const billsOf = new Map<string, SupplierBillRow[]>();
  for (const b of liveBills) {
    const key = accountOfBill(String(b.id));
    if (!key) continue;
    // THE BALANCE IS TOLD WHAT THE LEDGER ALREADY KNEW. A ticket the supplier's own closed paper
    // covers used to leave the All Bills count and stay inside the figure at the top of the card,
    // because the balance had no way to hear about it. It rides on the row now.
    const row: SupplierBillRow = { ...toBillRow(b), settledBySupplier: settledBySupplierIds.has(String(b.id)) };
    billsOf.set(key, [...(billsOf.get(key) ?? []), row]);
  }

  // ONLY WHERE THE QUESTION EXISTS - an account whose supplier documents we actually hold. Under
  // model A every unpaid bill is already inside the balance, so there is no uncovered slice to
  // name and this map stays empty for every account but CED.
  //
  // A $0.00 ROW IS NOT A SLICE OF MONEY. He has one, and counting it would make the sentence say
  // "2 bills" over a single dollar figure that only one of them is carrying.
  const noSupplierDocument = new Map<string, { total: number; bills: number; ids: string[] }>();
  // A lost links read makes every bill covered only by a Record link look uncovered: "+ $N they
  // never sent paper for" would be false. So the slice is not named at all until the links read.
  if (!linksErr) for (const b of liveBills) {
    const accountId = accountOfBill(String(b.id)) ?? "";
    if (!accountId || !documentsOf.has(accountId)) continue;
    if (!isOnAccountBill({ status: String(b.status ?? ""), settledBySupplier: settledBySupplierIds.has(String(b.id)) })) continue;
    if (coveredBillIds.has(String(b.id))) continue;
    const amount = Number(b.amount) || 0;
    if (amount <= 0.005) continue;
    const g = noSupplierDocument.get(accountId) ?? { total: 0, bills: 0, ids: [] };
    g.total = Math.round((g.total + amount) * 100) / 100;
    g.bills += 1;
    g.ids.push(String(b.id));
    noSupplierDocument.set(accountId, g);
  }

  // ONE ARRAY, TWO READERS. The same row objects go to the balance upstairs and to the reconcile
  // card downstairs, so the two can never be looking at different documents - which is the fault
  // that put a $3,034.54 STATEMENT on his books as a single bill standing for two invoices with
  // two different fates.
  const supplierAccounts: SupplierAccountRow[] = ((accountRows ?? []) as any[]).map((a) => {
    const id = String(a.id);
    const documents = documentsOf.get(id) ?? [];
    return {
      id,
      name: String(a.name ?? ""),
      accountNumber: a.account_number ?? null,
      branchCode: a.branch_code ?? null,
      onAccount: a.on_account !== false,
      note: a.note ?? null,
      aliases: aliasesOf.get(id) ?? [],
      bills: billsOf.get(id) ?? [],
      payments: supplierPayments.filter((p) => p.accountId === id),
      // ABSENT, NOT EMPTY, when we hold none. Every account in this app except CED has no supplier
      // documents, and the presence of even one row is what switches that account to model B.
      ...(documents.length ? { supplierInvoices: documents } : {}),
    };
  });

  // His jobs, with enough on each to tell five Rhodesias apart.
  const reconcileJobs = reconcileJobsOf((jobs ?? []) as any[]);

  // THE DAY THE COMPANY'S BOOKS BEGIN (booksBeginOn): the day it named (settings.books_begin; ET's
  // is June 8, "june 8 is good"), else the earliest scanned bill. Purchases the supplier made
  // before it are counted and named, never nagged about - nothing here could have recorded them.
  // My Day's cards read the same function.
  const orgSettingsRaw = (orgRow as { settings?: unknown } | null)?.settings;
  const recordsSince = booksBeginOn(orgSettingsRaw, liveBills);
  const booksNamed = supplierPaperLine(orgSettingsRaw);

  // ── A READ THAT FAILED SAYS SO (audit v1018, class 2) ───────────────────────────────────────
  // Every read the supplier half of this page leans on. Any one of them failing used to read as
  // "nothing there": Needs You vanished with no sentence, CED's balance quietly switched to the
  // bills-less-payments model its own comments call wrong for CED, the ledger said "No bills here
  // yet", and the search called covered papers "not in your books". Now each says it couldn't.
  const readFailed = new Set<string>(
    (
      [
        ["bills", billsErr],
        ["accounts", accountsErr],
        ["links", linksErr],
        ["aliases", aliasErr],
        ["jobs", jobsErr],
        ["papers", invoicesErr],
      ] as const
    )
      .filter(([, err]) => !!err)
      .map(([name]) => name),
  );
  // What a model-A balance (bills less payments) is built from. With any of these unread its figure
  // would be wrong without a word, so the account says it couldn't total instead (SuppliersCard).
  // The supplier's own papers are one of them: without them an account that is counted from its
  // supplier's papers (CED) would silently fall back to bills-less-payments.
  //
  // NAMED ONE AT A TIME, by the one function every reader of this rule asks (8a982483). This was a
  // bare `||` here, a second copy on the card and a third in Nort's read - and the third left the
  // supplier's own papers out, so /bills said "Couldn't Total Just Now" while Nort answered the
  // same question with the bills-less-payments number.
  const balancesUnread = supplierBalancesUnread({
    bills: !!billsErr,
    payments: !!paymentsErr,
    theirOwnPapers: !!invoicesErr,
  });

  // ── THE TWO QUESTIONS, ASKED ONCE EACH (8a982483) ───────────────────────────────────────────
  //
  //   "at the bottom it says 10k in open bills it at the top it says 5k but online it's saying a
  //    different number that's lower"
  //
  // Three figures, and nothing on the screen said they were answers to different questions. They
  // are computed here, once, by the two functions in lib/supplier-owed.ts, and handed down. Every
  // screen below reads the ANSWER - nothing recomputes it, which is the whole reason this page
  // could show two totals built from two different sets of paper in the first place.
  const owedPapers = liveBills.map((b: any) => ({
    id: String(b.id),
    supplierAccountId: b.supplier_account_id ?? null,
    supplier: b.supplier ?? null,
    amount: b.amount,
    status: b.status ?? null,
    settledBySupplier: settledBySupplierIds.has(String(b.id)),
  }));

  // (a) WHAT HE OWES HIS SUPPLIERS. The one-number answer, and the one the card leads with.
  const owedToSuppliers = whatISupplierOwed({
    accounts: supplierAccounts.map((a) => {
      const b = supplierBalance(a, today);
      return {
        accountId: a.id,
        name: a.name,
        onAccount: a.onAccount,
        owed: b.owed,
        model: b.model,
        openPapers: b.chargedBills,
        // A model-A figure with one of its reads missing is not zero and not a guess: it is named
        // as one we could not total, exactly as the card has always done it.
        unread: supplierFigureUnread({ onAccount: a.onAccount, model: b.model, balancesUnread }),
      };
    }),
    papers: owedPapers,
    identity: supplierOf,
    settledBySupplier: settledBySupplierIds,
  });

  // (b) WHAT HE BOUGHT AND HAS NOT SQUARED UP. A purchasing figure. NOT a debt, and the label it
  // is given below says so - "$10k Unpaid" over "$5k Owed" is the screen telling a man he owes two
  // different amounts.
  const boughtNotSettled = whatIBoughtNotSettled({ papers: owedPapers, settledBySupplier: settledBySupplierIds });

  // "HEY YOU, HERE'S A BILL, WHAT'S IT FOR?" The same cards My Day shows, from the same call
  // (supplierPaperFeed), so the two screens can never disagree about which paper is waiting.
  //
  // AND ONLY WHEN THE BOOKS WERE READ. A failed bills, links, aliases or jobs read makes papers his
  // books already cover look uncovered: false "Needs You" cards on this screen while My Day
  // (loadSupplierDesk, the same gate) shows none. So it says it couldn't check, instead.
  const paperBooksUnread = !!(billsErr || linksErr || aliasErr || jobsErr);
  const bareFeed =
    invoicesErr || accountsErr || paperBooksUnread || !supplierDocuments.length
      ? null
      : supplierPaperFeed({
          since: recordsSince,
          rows: supplierDocuments,
          jobs: reconcileJobs,
          accounts: ((accountRows ?? []) as any[]).map((a) => ({ id: String(a.id), name: a.name ?? null })),
          today,
          tz: orgTz,
          shopStock,
        });
  // Already Billed On J-010 on the cards (0357), from the reading the ledger already made; a card's
  // job with no bill on the page yet is read on its own (only then: one more breath).
  const reachRead = abReach as AlreadyBilledReach | null;
  const cardJobsUnread = cardJobIds(bareFeed).filter((id) => !reachRead?.jobs.has(id));
  const paperFeed = !bareFeed
    ? null
    : reachRead && reachRead.ready && !cardJobsUnread.length
      ? cardsWithAlreadyBilled(bareFeed, reachRead.jobs)
      : await withAlreadyBilledDoors(supabase, orgId, bareFeed);

  // NOT RENDERED AT ALL when there are no supplier documents, and that is the no-dead-ends rule
  // rather than tidiness: every section of the reconcile card is built around documents CED
  // issued, so with none of them the card could only say "nothing here" four times over.
  const reconcile =
    invoicesErr || !supplierDocuments.length
      ? null
      : {
          byAccount: Object.fromEntries(documentsOf) as Record<string, SupplierDocumentRow[]>,
          jobs: reconcileJobs,
          recordsSince,
        };

  // ── THE SPELLINGS NOBODY HAS FILED YET, AND THE TICKETS FILED TWICE ─────────────────────────
  //
  // THE DOORS THAT ANSWER THESE LIVE ON /reconcile NOW (cn-v1037). This page kept the two readings
  // it still needs its own sentence for: the Suppliers card's "$X on N bills with no supplier
  // account · File It" line, which is the unfiled pile totalled, and the Needs You pointer at a
  // ticket filed to two jobs. Both come out of the ONE module both pages read
  // (supplier-name-work.ts) — extracted, never copied, because two pages grouping the same
  // spellings their own way is the fault 8a982483 was.
  const unfiled = unfiledSpellings({
    bills: liveBills,
    // ON NO ACCOUNT AS THE RESOLVER READS IT, not as the column reads it: a paper spelled with the
    // account's own name is ON that account now.
    accountOf: accountOfBill,
    settledBySupplier: settledBySupplierIds,
  });

  // Every dollar on this page is accounted for somewhere. Until a spelling is on an account its
  // money belongs to no balance on the card, and the All Bills list further down is still counting
  // it - saying that out loud is the only thing that keeps the two halves of one screen from
  // arguing.
  const unassigned = unassignedTotals(unfiled);

  // ── THE SAME TICKET, FILED TO TWO JOBS ──────────────────────────────────────────────────────
  // Two receipts that match line for line to the penny mean one of those jobs is carrying a cost
  // that is not its own. WHICH COPY IS THE REAL ONE IS ERIK'S KNOWLEDGE - he was on those jobs - so
  // the pick is made on /reconcile. This page only POINTS at it, from Needs You, which is where he
  // already looks for a decision.
  //
  // The superseded rows ride along on purpose: a group reads as answered because the copy he set
  // aside points at the copy he kept.
  const { groups: duplicates } = duplicateTicketGroups({ bills: billsWithLines as any[] });

  // ── FIND ANY PAPER (Bills plan, Wave A) ─────────────────────────────────────────────────────
  // Over what this page has ALREADY read: the supplier's documents, the bills, and the receipt
  // files. Each row carries every way he might remember it (number, street, job, what CED wrote,
  // the money) and says where it is. A covered paper takes its job from the bill that covers it,
  // because its own job_id is often null and "on no job" would be false.
  const jobById = new Map(((jobs ?? []) as any[]).map((j) => [String(j.id), j]));
  const jobSaid = (id: string | null | undefined) => {
    const j = id ? jobById.get(String(id)) : null;
    return j ? [j.job_number, j.name].filter(Boolean).join(" ") : null;
  };
  const jobWords = (id: string | null | undefined) => {
    const j = id ? jobById.get(String(id)) : null;
    return j ? [j.job_number, j.name, j.address] : [];
  };
  const accountNameOf = new Map(((accountRows ?? []) as any[]).map((a) => [String(a.id), String(a.name ?? "")]));
  const liveBillById = new Map(liveBills.map((b: any) => [String(b.id), b]));
  const waitingPapers = new Set((paperFeed?.cards ?? []).map((c) => c.invoiceId));
  const waitingOnCredit = new Map((paperFeed?.waiting ?? []).map((c) => [c.invoiceId, c]));
  // With the books unread, whether a paper is covered is not known: every paper says so, except one
  // waiting on a credit, which its own stamp answers (creditWait, the same reading the feed makes).
  const booksUnreadForSearch = paperBooksUnread || !!accountsErr;
  const searchRows: BillsSearchRow[] = [];
  for (const d of supplierDocuments) {
    const covering = [...(coveringBills.get(d.id) ?? []), ...(billsCarrying.get(d.id) ?? [])]
      .map((id) => liveBillById.get(id))
      .filter(Boolean) as any[];
    const jobId = d.jobId ?? covering.find((b) => b.job_id)?.job_id ?? null;
    const account = accountNameOf.get(String(d.supplierAccountId ?? "")) ?? "";
    const supplier = shortSupplierName(account);
    const creditWaiting = waitingOnCredit.get(d.id);
    const stampWait = !paperFeed && d.supplierAccountId ? creditWait(d, today, orgTz) : null;
    const waitSince = creditWaiting?.waitingCredit?.since ?? (stampWait && !stampWait.overdue ? stampWait.since : null);
    const where = waitingPapers.has(d.id)
      ? "waiting for you under Needs You"
      : waitSince
        ? `waiting on a credit from ${supplier || "the supplier"} since ${formatDateShort(waitSince)}`
      : booksUnreadForSearch
        ? "couldn't check your books just now"
      : d.billCount > 0
        ? "in your books"
        : d.kind !== "invoice"
          ? (explainKind(d.kind) ?? sayKind(d.kind))
          : isBeforeLine(d.invoiceDate, recordsSince)
            ? "from before your books here began"
            : "not in your books";
    searchRows.push({
      key: `paper:${d.id}`,
      kind: "paper",
      title: `${supplier} ${sayKind(d.kind)} ${d.invoiceNumber}`,
      sub: [
        formatDateShort(d.invoiceDate),
        formatCurrency(d.total),
        isUsableJobName(d.jobNameRaw) ? `it says ${String(d.jobNameRaw).trim()}` : null,
        jobId ? `on ${jobSaid(jobId) ?? "a job"}` : "on no job",
        where,
      ]
        .filter(Boolean)
        .join(" · "),
      words: wordsOf(d.invoiceNumber, d.jobNameRaw, supplier, account, moneyWords(d.total), d.invoiceDate, sayKind(d.kind), ...jobWords(jobId)),
      // Where its own buttons are (billsPaperDoor, the routing the job page's papers use too): its
      // Needs You card, its Waiting On A Credit fold, its job, else its supplier's own lists.
      href: billsPaperDoor({
        onNeedsYou: waitingPapers.has(d.id),
        waitingOnCredit: waitingOnCredit.has(d.id),
        accountId: !accountsErr && d.supplierAccountId && accountNameOf.has(String(d.supplierAccountId)) ? String(d.supplierAccountId) : null,
        jobId,
      }),
    });
  }
  // EVERY ROW ALL BILLS HOLDS (W1-32): the box above it filters it in place, by any of these words.
  // A set-aside duplicate is listed there too, so it is found too.
  for (const b of billsWithLines as any[]) {
    const reading = readBillInvoice({ notes: b.notes ?? null, lineDescriptions: (b.line_items ?? []).map((l: any) => l.description) });
    const number = b.bill_number || b.supplier_invoice_number || reading.invoiceNumber || null;
    // What a bill with no job is, in the words he'd type: "business cost" and its bucket ("fuel"),
    // or "shop stock" for a stock ticket.
    const kindWords = b.job_id ? [] : isShelfTicket(b) ? ["shop stock"] : ["business cost", bucketOf(b.category)];
    searchRows.push({
      key: `bill:${b.id}`,
      kind: "bill",
      title: `${b.supplier || "A bill"}${number ? ` #${number}` : ""}`,
      sub: [
        formatDateShort(b.bill_date),
        formatCurrency(b.amount),
        b.job_id ? `on ${jobSaid(b.job_id) ?? b.jobs?.name ?? "a job"}` : isShelfTicket(b) ? "shop stock" : `business cost, ${bucketOf(b.category)}`,
        // THE ROW'S OWN WORDS, from the one function that makes them (8a982483): a ticket the
        // supplier's closed paper covers reads the same in Search Or Ask as it does on its row.
        billSettledLabel({ ...b, settledBySupplier: settledBySupplierIds.has(String(b.id)) }, shortSupplierName).toLowerCase(),
      ]
        .filter(Boolean)
        .join(" · "),
      words: wordsOf(
        number,
        ...(reading.numbers ?? []),
        b.supplier,
        moneyWords(b.amount),
        b.bill_date,
        b.category,
        ...kindWords,
        // The words he might TYPE to find it, which is a wider net than the words the row shows:
        // "unpaid" still finds a ticket still owed even though no screen calls it that any more.
        isOnAccountBill({ status: String(b.status ?? ""), settledBySupplier: settledBySupplierIds.has(String(b.id)) })
          ? "on account unpaid bought"
          : "settled paid",
        b.jobs?.job_number,
        b.jobs?.name,
        ...jobWords(b.job_id),
        String(b.notes ?? "").split(/\r?\n/)[0],
      ),
      // Its own row in All Bills (FoldOpener opens the folds around it): the bill itself, with its
      // number, its lines and its doors, rather than the job page it sits on.
      href: `#bill-${b.id}`,
    });
  }
  for (const p of (pos ?? []) as any[]) {
    const job = Array.isArray(p.jobs) ? p.jobs[0] : p.jobs;
    searchRows.push({
      key: `po:${p.id}`,
      kind: "po",
      title: `${p.po_number ?? "PO"} · ${p.vendor || "No vendor"}`,
      sub: [formatCurrency(p.total), job?.name ? `on ${job.name}` : "on no job", p.status].filter(Boolean).join(" · "),
      words: wordsOf("po purchase order", p.po_number, p.vendor, moneyWords(p.total), p.status, job?.name),
      href: `/purchasing/${p.id}`,
    });
  }
  for (const f of looseDocs as any[]) {
    searchRows.push({
      key: `file:${f.id}`,
      kind: "file",
      title: String(f.name ?? "A file"),
      sub: [formatDateShort(String(f.created_at ?? "").slice(0, 10) || null), f.category, f.jobs?.name ? `on ${f.jobs.name}` : null].filter(Boolean).join(" · "),
      words: wordsOf("file", f.name, f.category, f.jobs?.name, ...jobWords(f.job_id)),
      href: f.signedUrl ?? (f.job_id ? `/jobs/${f.job_id}` : null),
    });
  }

  // ── THE LEDGER'S ROWS (Wave B) ────────────────────────────────────────────────────────────────
  // Each bill carries what its row prints and what its detail holds: the supplier's number on
  // every row (typed, stored, or read off the PDF name and lines by readBillInvoice), whether it was
  // set aside as a duplicate, and, for a live receipt on a job, its per-line billing switches.
  const receiptById = new Map(receiptsForBilling.map((r) => [r.id, r]));
  const supplierOfBill = new Map((billsWithLines as any[]).map((b) => [String(b.id), String(b.supplier || "Receipt")]));
  const paperOfBill = billPapers({}, billTies, billPaperUrls, (billId) => supplierOfBill.get(billId) ?? "Receipt");
  const ledgerBills = (billsWithLines as any[]).map((b) => {
    const reading = readBillInvoice({ notes: b.notes ?? null, lineDescriptions: (b.line_items ?? []).map((l: any) => l.description) });
    return {
      ...b,
      shownNumber: b.bill_number || b.supplier_invoice_number || reading.invoiceNumber || null,
      superseded: !!b.superseded_by_bill_id,
      // Settled in the supplier's own books (every covering document closed): not open (isOpenBill).
      settledBySupplier: settledBySupplierIds.has(String(b.id)),
      // WHO says so: the account's short name ("CED"), not the spelling the receipt reader stored
      // on bills.supplier (the row's first line already prints that one, in full).
      // BY IDENTITY (8a982483). This read the raw column, which is null on more than half his book,
      // so the very tickets only the resolver could reach - the ones this fix exists for - fell back
      // to the typed spelling and named the supplier differently from every other row.
      settledBySupplierName: settledBySupplierIds.has(String(b.id))
        ? shortSupplierName(accountNameOf.get(String(accountOfBill(String(b.id)) ?? "")) || b.supplier)
        : null,
      receipt: receiptById.get(String(b.id)) ?? null,
      papers: paperOfBill[String(b.id)] ?? null,
    };
  });
  // Each bill's Already Billed door, or its Billed By Hand · Not Billed After All (0357).
  const ledgerReach = abReach as AlreadyBilledReach | null;
  const billDoors =
    ledgerReach && ledgerReach.ready
      ? billAlreadyBilledDoors({
          bills: ledgerBills.map((b: any) => ({
            id: String(b.id),
            job_id: b.job_id ?? null,
            po_id: b.po_id ?? null,
            amount: b.amount,
            superseded: b.superseded,
            what: [String(b.supplier ?? "").trim() || "The bill", b.shownNumber ?? null].filter(Boolean).join(" "),
            // Its lines decide whether New Invoice would bill any of it (the Costs tab's own test).
            lines: b.line_items ?? null,
          })),
          reach: ledgerReach.jobs,
          hands: ledgerReach.hands,
          claimed: ledgerReach.claimed,
        })
      : {};

  // What is waiting under More, counted so its one line says so (nothing silent behind a fold).
  const openDuplicates = duplicates.filter(isOpenDuplicateGroup);
  const needsYouIds = (paperFeed?.cards ?? []).map((c) => c.invoiceId);
  // WAITING ON A CREDIT (0346): off Needs You, folded under its supplier, and pointed at from
  // Needs You so a card he set aside never just vanishes. One line per supplier account.
  const waitingByAccount = new Map<string, { name: string; count: number }>();
  for (const c of paperFeed?.waiting ?? []) {
    // Only a paper on an account waits (paperCards), so every one has its account's fold to point at.
    const accountId = String(c.accountId ?? "");
    if (!accountId) continue;
    const had = waitingByAccount.get(accountId) ?? { name: c.supplier, count: 0 };
    waitingByAccount.set(accountId, { name: had.name, count: had.count + 1 });
  }

  // WHAT SHOWS, AND WHEN (W1-32). A new company sees the title, Snap Or Note, Add By Hand and the
  // drop line, and nothing else: the search, Needs You, Suppliers, All Bills and More each appear once
  // they hold something (or once a read of theirs failed, which they say).
  const hasSupplierSide = !!paperFeed || readFailed.size > 0;
  const showSuppliers = !!accountsErr || supplierAccounts.length > 0 || unassigned.bills > 0 || typeof payOn === "string";
  // Purchase Orders on is reason enough: All Bills' ⋯ is New PO's one home on this page, and the Bills &
  // POs row, /purchasing and "po" in Search Or Ask all land here (review of W1-32: a company that had
  // just turned the switch on, with nothing yet, found no New PO and no word about orders).
  const poOn = featureOn(switches.features, "purchase_orders");
  const showAllBills = !!billsErr || poOn || (billsWithLines as any[]).length > 0 || (pos ?? []).length > 0 || looseDocs.length > 0;
  // Needs You's empty line: every paper since the books began is in them, unless some wait on a credit.
  // ONLY WHEN IT WAS ALL READ (audit v1018, class 2): with the supplier half unread (its alert is in the
  // card) or the waiting papers unread, "every paper is in your books" would be a false all-clear right
  // under the sentence saying it couldn't check, so the card carries the alert alone.
  const supplierUnread = !paperFeed && readFailed.size > 0;
  const needsYouEmpty =
    supplierUnread || trayErr
      ? null
      : waitingByAccount.size
        ? "Nothing else waiting on you."
        : `Nothing waiting. Every paper${recordsSince ? ` since ${formatDateShort(recordsSince)}` : ""} is in your books.`;
  // The jobs Add By Hand offers: open and finished, never cancelled, the place first and the number second.
  const handJobs = paperJobs.map((j) => ({ id: j.id, label: jobPickLabel(j) }));

  return (
    // THE WHOLE PAGE IS THE DROP ZONE (dropbox plan, Phase 1): drag any number of PDFs and photos
    // anywhere onto it, or press Snap Or Note (the one paper door, W1-30: the same queue as + on
    // every page). Nothing is filed on drop; each paper waits under Needs You until a person taps an
    // answer on its card.
    //
    // THE ORDER (Bills plan, Wave B; W1-32): the title and its two doors, the search box, Needs You,
    // one line per supplier, All Bills, More. Everything below Needs You is folded, and every paragraph
    // is a one-line label with a Why? fold ("it looks like one big run-on sentence"). Every door the
    // page had keeps exactly one home (bills-page-doors.test.ts finds each one).
    <PaperworkDropZone>
      <FoldOpener />
      <PageHeader title="Bills" description="Drop a receipt or bill anywhere on this page.">
        <div className="flex flex-wrap items-center gap-2">
          <SnapOrNoteButton />
          {/* The one typed door (W1-32): a job's cost, a business cost in its bucket, or stock, with
              Paid? asked. It saves through the same createBill as every other cost. */}
          <AddByHandButton jobs={handJobs} shopStock={shopStock} jobsUnread={!!jobsErr} />
        </div>
      </PageHeader>

      <BillsSearchProvider rows={searchRows}>
        {/* FIND ANY PAPER: number, street, job, supplier, bucket, or $ (Bills plan, Wave A). It filters
            All Bills in place; a supplier's own paper is a hit that lands on its card. */}
        {searchRows.length > 0 && <BillsSearchBox />}

        {/* NEEDS YOU (W1-32): Sort These folded in. What was just dropped, the papers waiting for an
            answer, then the same "here's a bill, what's it for?" cards My Day shows, from the same call
            (supplierPaperFeed). The one place these decisions happen. */}
        <NeedsYou
          items={paperItems}
          jobs={paperJobs}
          matches={paperMatches}
          shopStock={shopStock}
          supplierCards={paperFeed?.cards.length ?? 0}
          always={hasSupplierSide || !!trayErr}
          emptyLine={needsYouEmpty}
          trayUnread={!!trayErr}
          supplier={
            supplierUnread ? (
              <p className="text-sm text-amber-800" role="alert">
                {invoicesErr
                  ? "Couldn't read your suppliers' own papers just now, so what you owe them and the bills waiting on you aren't shown. Reload the page to try again."
                  : accountsErr
                    ? "Couldn't read your supplier accounts just now, so their balances and the bills waiting on you aren't shown. Reload the page to try again."
                    : "Couldn't check your books just now, so the supplier bills waiting on you aren't shown. Reload the page to try again."}
              </p>
            ) : paperFeed ? (
              <div>
                <BooksBeginLine since={recordsSince} named={!!booksNamed} canChange={canChangeSettings} />
                <SupplierPaperCards feed={paperFeed} />
                {[...waitingByAccount.entries()].map(([accountId, w]) => (
                  <a
                    key={accountId}
                    href={`#supplier-waiting-credit-${accountId}`}
                    className="mt-2 flex min-h-11 items-center text-sm font-medium text-brand hover:underline"
                  >
                    {`Waiting On A Credit (${w.count}) · Under ${w.name}`}
                  </a>
                ))}
              </div>
            ) : null
          }
        />
        {/* The same ticket on two jobs is money on the wrong job: it is a decision, so it is pointed at
            from here, and answered on Reconcile, where the picking happens. A LINK, not a second copy
            of the control — that is the difference nav doctrine draws. */}
        {openDuplicates.length > 0 && (
          <a
            href="/reconcile#same-ticket-two-jobs"
            className="mb-6 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-900 hover:bg-amber-100"
          >
            <span className="min-w-0">
              {openDuplicates.length === 1
                ? `The Same ${formatCurrency(openDuplicates[0].amount)} Ticket Is On Two Jobs`
                : `${openDuplicates.length} Tickets Are Each Filed More Than Once`}
            </span>
            <span className="shrink-0 font-medium">Sort It Out</span>
          </a>
        )}

        {/* ONE LINE PER SUPPLIER. When the accounts read came back an error, the card is its heading
            and one sentence: no buttons that could only refuse, and a My Day ?pay= door lands on
            words, never on nothing (audit v1018, class 2). */}
        {accountsErr ? (
          <Card className="mb-6 p-4" id="suppliers">
            <h2 className="text-base font-semibold text-slate-900">Suppliers</h2>
            <p className="mt-1 text-sm text-amber-800" role="alert">
              Couldn&apos;t read your supplier accounts just now, so what you owe each one isn&apos;t shown and no payment can be recorded here. Reload the page to try again.
            </p>
          </Card>
        ) : showSuppliers ? (
          <SuppliersCard
            accounts={supplierAccounts}
            today={today}
            unassigned={unassigned}
            // THE ANSWER, NOT THE INGREDIENTS. The card used to add an account join to a spelling
            // grouping and call the sum "Owed"; it now reads the figure the one function produced.
            owedToSuppliers={owedToSuppliers}
            // The OTHER figure, named on the same card, so the one he finds further down the page
            // is not a surprise he has to reconcile himself.
            boughtNotSettled={boughtNotSettled}
            reconcile={reconcile}
            needsYouIds={needsYouIds}
            waitingOnCredit={paperFeed?.waiting ?? []}
            // The slice of an account's unpaid bills the supplier's own documents do not cover.
            // Never folded into a balance: named, so money he does owe is not explained away.
            noSupplierDocument={Object.fromEntries(noSupplierDocument)}
            payOn={typeof payOn === "string" ? payOn : null}
            // A lost papers, bills or payments read: a bills-less-payments figure would be wrong
            // without a word, so those accounts say they couldn't total instead.
            balancesUnread={balancesUnread}
            // Each says so where its own figure would have been: "you have sent them $0.00" and
            // "your paperwork rather than theirs" would be false without a word.
            paymentsUnread={!!paymentsErr}
            paperlessUnread={!!linksErr}
            actions={{
              recordPayment: recordSupplierPayment,
              voidPayment: voidSupplierPayment,
              setOnAccount: setSupplierOnAccount,
              // WITHOUT THIS LINE THE SUPPLIER'S OWN PAPERS ARE UNREACHABLE (review, 2026-09-19):
              // suppliers-card gates them on `!!actions.setInvoiceJob`.
              setInvoiceJob: setSupplierInvoiceJob,
              // The account's own details, which had no door until the audit counted one.
              updateAccount: updateSupplierAccount,
              recordAsBill: recordSupplierInvoiceAsBill,
              // Same Purchase: Tie Them (audit v994, DB1).
              tieToBill: tieSupplierInvoiceToBill,
              // Record To Shelf (Shop Stock, Phase 2): both halves passed, or the button does not render.
              // Shop Stock off (0352): neither half is passed, so it doesn't.
              ...(shopStock ? { shelfLines: supplierInvoiceShelfLines, recordToShelf: recordSupplierInvoiceToShelf } : {}),
              // Waiting On A Credit's way back: Stop Waiting on the folded line puts it on Needs You.
              stopWaitingOnCredit,
            }}
          />
        ) : null}

        {/* ALL BILLS: one searchable list (W1-32): every bill, purchase order, and receipt file no bill
            holds yet; a receipt's billing switches live in its own row. */}
        {showAllBills && (
          <BillsReceipts
            orgId={orgId}
            jobs={jobs ?? []}
            lists={lists ?? []}
            pos={(pos ?? []) as any}
            bills={ledgerBills as any}
            docs={looseDocs as any}
            readFailed={!!billsErr}
            // QUESTION (b), ALREADY ANSWERED. The fold used to total the rows it happened to be
            // holding; it reads the one function's figure now, so it cannot drift from the card.
            boughtNotSettled={boughtNotSettled}
            papersNote={billTiesErr ? "Couldn't load which receipt made each bill just now, so every receipt file is listed. Reload to try again." : null}
            switches={switches}
            alreadyBilled={billDoors}
          />
        )}
      </BillsSearchProvider>

      {/* ── WHERE THE "MORE" FOLD WENT ────────────────────────────────────────────────────────────
          The fold that used to sit here held the import door and all the supplier-name housekeeping,
          collapsed, at the bottom of the page that answers "what came in and what do I owe". It was
          a confession: that work is not this page's. It is /reconcile now, and this is ONE LINK to it
          — a link is not duplication; a second copy of a control is.

          It is drawn only once the book has something in it, so a new company's Bills page is still
          the header and nothing else. */}
      {liveBills.length > 0 && (
        <a
          id="reconcile-link"
          href="/reconcile"
          className="mb-6 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-white px-4 py-2.5 text-sm text-slate-700 shadow-sm hover:bg-slate-50"
        >
          <span className="min-w-0">Supplier names, and tickets filed twice, are sorted out on Reconcile.</span>
          <span className="shrink-0 font-medium text-brand">Open Reconcile</span>
        </a>
      )}
    </PaperworkDropZone>
  );
}
