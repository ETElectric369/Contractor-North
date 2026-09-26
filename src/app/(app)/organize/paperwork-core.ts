import "server-only";

import { reportError } from "@/lib/observe";
import { dbError } from "@/lib/db-error";
import { AUTO_FILE_BUCKETS, bucketOf, looksLikeSupplierFee } from "@/lib/business-cost-buckets";
import { getOrgSettings } from "@/lib/org-settings";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { indexSupplierAliases, resolveSupplierAccount, type SupplierAliasIndex } from "@/lib/supplier-identity";
import {
  findSameNumber,
  isLinelessReturn,
  linesPointWithTotal,
  onPaperWords,
  paperTypeOf,
  placeFromMarks,
  proposalOf,
  rematchPaper,
  type MarkJob,
  type MarkPo,
  type PaperMarks,
  type BookedBill,
  type BookedPaper,
  type BookedSupplierInvoice,
  type NumberMatch,
  type PaperItem,
  type PaperProposal,
  type PaperType,
} from "@/lib/paperwork";
import {
  FOOD_AND_DRINK_PROMPT_RULE,
  MASKED_PRICE_PROMPT_RULE,
  looksProvisionallyPriced,
  RECEIPT_LINE_CATEGORY_SCHEMA_HINT,
} from "@/app/(app)/bills/receipt-billing";

/**
 * THE PARTS OF FILING PAPER THAT MORE THAN ONE DOOR NEEDS (0295).
 *
 * Organize's tray, Drop Paperwork on /bills and a receipt read on a job page all write the same
 * bill from the same row, so the row-to-bill writer, the line cleaner and the reader's prompt live
 * here once. This is NOT a "use server" module: nothing in it can be called from a browser. The
 * doors that can are in actions.ts and paperwork-actions.ts, and each of them checks who is asking
 * before it gets here.
 */

// The paper's lines as the bill holds them live in src/lib/paper-lines.ts now (pure, so the tray
// row can key a Shop Stock count to the same index the bill's sort_order gets).
export { cleanLines, type BillLine } from "@/lib/paper-lines";
import { cleanLines, type BillLine } from "@/lib/paper-lines";

/** A store receipt is already paid; a supplier bill/invoice is still owed. */
function billStatusFor(category: string | null | undefined): "paid" | "unpaid" {
  return /bill|invoice/i.test(category || "") ? "unpaid" : "paid";
}

/** Paid/unpaid for a bill created from an ALREADY-READ row: what the paper said about tender
 *  (0153) wins; unknown is UNPAID, because a debt you already settled is harmless and one you
 *  forget is not. */
export function billStatusFromItem(item: { payment?: string | null; category?: string | null }): "paid" | "unpaid" {
  const p = String(item.payment ?? "");
  if (p === "paid_at_purchase") return "paid";
  if (p === "on_account" || p === "unknown") return "unpaid";
  return billStatusFor(item.category);
}

/** Insert a bill plus its line items (an itemized receipt → billable cost). */
export async function insertItemizedBill(
  supabase: any,
  bill: {
    job_id: string | null;
    supplier: string;
    amount: number | null;
    bill_date: string | null;
    category: string;
    scope_category?: string | null; // the JOB SCOPE (Framing, Decking…) for budget-vs-actual
    notes: string;
    created_by: string;
    /** 0271: the prices on this paper are a counter preview, not this account's own. */
    pricing_provisional?: boolean;
    /** The number printed on the paper (0017's column; the '#' on every bill label). */
    bill_number?: string | null;
    /** 0270: ONLY from an exact alias a person already made. Never a guess. */
    supplier_account_id?: string | null;
    /** 0303: a ticket bought for the shop shelf (job_id must be null). */
    on_shelf?: boolean;
  },
  given: BillLine[],
  status: "paid" | "unpaid" = "unpaid",
): Promise<string | null> {
  // THE LINES POINT WITH THE TOTAL, HERE WHERE THE BILL IS WRITTEN (audit v994 review). The
  // readers line them up when they read, but the total can change after that (Fix Details, It Is A
  // Charge) and the lines sit in the row as they were read. Every door that writes a bill from a
  // paper comes through here, so this is the one place the two cannot disagree.
  const lines = linesPointWithTotal(bill.amount, given);
  // A RETURN WITH NO LINES NEVER GOES ON A JOB (DB4): the importer would credit the customer the
  // whole of it at markup, with nothing to hold it to what they were billed. The doors ask first
  // and say so in their own words (fileRefusal, billJobReceipt); this is the boundary behind them.
  if (bill.job_id && isLinelessReturn(bill.amount, lines)) {
    reportError("organize:insertItemizedBill.linelessReturn", new Error("a return with no lines was refused on a job"), {
      supplier: bill.supplier,
      jobId: bill.job_id,
      amount: bill.amount,
    });
    return null;
  }
  // Undefined keys are dropped so a bill that has no number or account writes exactly what it
  // wrote before these existed.
  const row: Record<string, unknown> = { ...bill, status };
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  const { data, error } = await supabase.from("bills").insert(row).select("id").single();
  if (error || !data) {
    // A RECEIPT THAT DID NOT BECOME A BILL USED TO SAY NOTHING AT ALL (review, 2026-09-19): the
    // caller is told (null), and the ops log hears it, because a deploy that lands before its
    // migration makes PostgREST refuse the whole insert for one unknown column.
    reportError("organize:insertItemizedBill", error ?? new Error("bill insert returned no row"), {
      supplier: bill.supplier,
      jobId: bill.job_id,
      amount: bill.amount,
    });
    return null;
  }
  if (lines.length) {
    const { error: lineErr } = await supabase
      .from("bill_line_items")
      .insert(
        lines.map((l, i) => ({
          bill_id: data.id,
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price,
          amount: l.amount,
          category: l.category,
          billable: l.billable,
          // A part-used amount a person set on the bill before an Undo (TD3); absent otherwise,
          // so a line as read writes exactly what it always wrote.
          ...(l.billed_amount !== undefined ? { billed_amount: l.billed_amount } : {}),
          sort_order: i,
        })),
      )
      .select("id");
    // A BILL WITH NO LINES IS STILL A NUMBER (silent-write law, same pass as 0278): the cost is
    // kept, and the missing itemisation goes to the ops log instead of passing quietly.
    if (lineErr) {
      reportError("organize:insertItemizedBill.lines", lineErr, {
        billId: data.id,
        supplier: bill.supplier,
        lineCount: lines.length,
      });
    }
    // NO RESTAMP HERE, AND WHY (Shop Stock, 0304's other half): every bill-line write that can
    // move a roll's cost calls restampLotsForBill (receipt-billing-actions, updateBill), but these
    // lines belong to a bill written a moment ago. A roll is keyed to a line id, and these ids did
    // not exist until this insert, so no roll can be on this bill to restamp. A door that ever
    // adds lines to an EXISTING bill must restamp after it writes.
  }
  return data.id;
}

/**
 * THE TRADE THE PROMPT SPEAKS IN. Every reader here opened "You file paperwork for an electrical
 * contractor", in an app that also runs a deck builder and a general builder: Justin's lumber
 * receipts were read by an electrician. The org's own trade label, or "contractor". A failed read
 * costs nothing but the adjective.
 */
export async function tradeOf(supabase: any, orgId: string | null | undefined): Promise<string> {
  if (!orgId) return "contractor";
  try {
    const { data } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
    return getOrgSettings((data as { settings?: unknown } | null)?.settings).trade_label?.trim() || "contractor";
  } catch {
    return "contractor";
  }
}

/**
 * The supplier ACCOUNT for a spelling, by exact alias only (0270: the alias exists because a person
 * pressed something to make it). A miss, or a read that fails, is "not on an account", which is
 * exactly what every bill was before this: never a guess and never a refusal.
 */
export async function exactAccountFor(supabase: any, orgId: string | null | undefined, supplier: string | null | undefined): Promise<string | null> {
  if (!orgId || !String(supplier ?? "").trim()) return null;
  try {
    const { data, error } = await supabase
      .from("supplier_aliases")
      .select("alias, supplier_account_id")
      .eq("org_id", orgId)
      .limit(5000);
    if (error) return null;
    return resolveSupplierAccount(supplier, data as { alias: string; supplier_account_id: string }[]);
  } catch {
    return null;
  }
}

/** The printed number, cleaned for storage: no longer than a bill label can carry. */
export function cleanDocNumber(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s || /^(null|none|n\/a|unknown)$/i.test(s)) return null;
  return s.slice(0, 60);
}

// ── THE READER ──────────────────────────────────────────────────────────────────────────────

/**
 * HOW MANY OPEN JOBS THE PAPER IS MATCHED AGAINST, AND HOW MANY THE ROW'S PICKER OFFERS: one
 * number for both. A reader that matched a job the row's picker didn't carry said "Job picked from
 * the address" on the upload line while the row asked where it goes, with that job not even in the
 * list.
 */
export const OPEN_JOBS_FOR_PAPER = 1000;

/**
 * THE JOBS A PAPER CAN BE FILED TO (Erik, audit v994 PR1): every open job AND every finished one.
 * A CED ticket for J-046 lands after J-046 is complete, and it is still J-046's cost; with only
 * open jobs on the list it could only become a business cost, be set aside, or be typed by hand.
 * The matcher still PICKS only an open job (MarkJob.closed). Never a cancelled job.
 */
export const PAPER_JOB_STATUSES = [...ACTIVE_JOB_STATUSES, "complete"] as const;

/** Is this status a finished job (fileable, never picked)? */
export function isClosedForPaper(status: string | null | undefined): boolean {
  return status === "complete";
}

/** Everything the exact job match needs, read once: the open jobs, the org's POs, and who the
 *  company itself is. */
export type MarkContext = { markJobs: MarkJob[]; pos: MarkPo[]; selfNames: string[] };

/**
 * The open AND finished jobs (with their number, name, street and customer) for the exact match of
 * what is printed on the paper (jobFromPaperMarks): an open one can be picked, a finished one
 * (closed) never is, and a street it shares with an open job stops the street picking (PR1). The
 * reader model never sees them (paperReaderSystem). The same jobs, and as many, as the Organize
 * row's picker offers (PAPER_JOB_STATUSES, OPEN_JOBS_FOR_PAPER).
 *
 * Beside them, and never able to fail the read: this org's purchase orders (a printed PO number
 * finds its job), and SELF NAMES, the company's own name and its people's (Erik, 2026-09-24: a CED
 * ticket prints "ERIK TAYLOR" as who it was sold to, on every ticket, and that is never the
 * customer). A read that fails is an empty list: no PO match, no names set aside.
 */
export async function loadMarkContext(
  supabase: any,
  orgId: string | null | undefined,
  /** `strict`: a failed jobs or PO read THROWS instead of reading as no match. For a caller whose
   *  empty answer says "nothing missing" (the job's Costs tab papers), never for the tray. */
  opts: { strict?: boolean } = {},
): Promise<MarkContext> {
  let jq = supabase.from("jobs").select("id, job_number, name, address, status, customers(name, company_name)");
  if (orgId) jq = jq.eq("org_id", orgId);
  const { data: jobs, error: jobsError } = await jq.in("status", PAPER_JOB_STATUSES).order("created_at", { ascending: false }).limit(OPEN_JOBS_FOR_PAPER);
  if (jobsError && opts.strict) throw jobsError;
  const rows = (jobs ?? []) as any[];
  let pos: MarkPo[] = [];
  let selfNames: string[] = [];
  await Promise.all([
    (async () => {
      try {
        let pq = supabase.from("purchase_orders").select("po_number, job_id");
        if (orgId) pq = pq.eq("org_id", orgId);
        const { data, error } = await pq.not("job_id", "is", null).limit(2000);
        if (error && opts.strict) throw error;
        if (!error) pos = ((data ?? []) as MarkPo[]).filter((p) => p?.po_number && p?.job_id);
      } catch (e) {
        if (opts.strict) throw e;
        pos = [];
      }
    })(),
    (async () => {
      if (!orgId) return;
      try {
        const { data, error } = await supabase.from("profiles").select("full_name, organizations(name)").eq("org_id", orgId).limit(500);
        if (error) return;
        const names = new Set<string>();
        for (const r of (data ?? []) as any[]) {
          if (r?.full_name) names.add(String(r.full_name));
          const org = Array.isArray(r?.organizations) ? r.organizations[0] : r?.organizations;
          if (org?.name) names.add(String(org.name));
        }
        selfNames = [...names];
      } catch {
        selfNames = [];
      }
    })(),
  ]);
  return {
    markJobs: rows.map((j) => ({
      id: String(j.id),
      job_number: j.job_number ?? null,
      name: j.name ?? null,
      address: j.address ?? null,
      customerNames: [j.customers?.name, j.customers?.company_name],
      ...(isClosedForPaper(j.status) ? { closed: true } : {}),
    })),
    pos,
    selfNames,
  };
}

/** Every waiting paper matched again from what it stored (rematchPaper): in memory, no model, no
 *  write. */
export function rematchTray<T extends PaperItem>(items: readonly T[], ctx: MarkContext): T[] {
  return items.map((i) => {
    const r = rematchPaper(i, ctx.markJobs, ctx.pos, ctx.selfNames);
    // What the paper says in its own words, for the row that picked nothing: shown, never stored.
    return { ...r, on_paper: onPaperWords(proposalOf(r), ctx.selfNames) };
  });
}

/**
 * ONE PROMPT FOR ANY PIECE OF PAPER (Organize, Drop Paperwork). It reads and classifies; it does
 * not decide where anything goes.
 *
 * IT NEVER SEES THE JOB LIST (Erik, 2026-09-24: a model's guess alone never picks a job). The
 * job_marks it transcribes are matched to a job in code (jobFromPaperMarks), and that match is
 * PICKED on the row. A reader that was also shown every open job's customer and street, and asked
 * for its best guess in the same breath, could copy a name or a street off that list into
 * job_marks, and its guess would come back as "read off the paper". Without the list, what it
 * transcribes can only come from the paper. A guess at the job is AI Suggest's, a separate look.
 */
export function paperReaderSystem(trade: string): string {
  return `You read paperwork for a ${trade}. Look at the upload, say what kind of paper it is, and transcribe it.

Respond with ONLY a JSON object (no prose):
{
  "paper_type": "receipt" | "bill" | "not_a_cost" | "statement" | "credit_memo" | "purchase_order" | "photo" | "other" — "receipt" = a purchase already paid (store receipt, counter ticket paid by card or cash); "bill" = something still OWED (a supplier invoice on account, a subcontractor's bill); "statement" = an account summary listing several invoices and a balance; "credit_memo" = a credit or return; "purchase_order" = an order the company sent; "photo" = a picture of a place or a thing, not paperwork (a job site, a panel, a meter, equipment, a label, a nameplate, damage); "not_a_cost" = a plan, permit, quote, letter or note; "other" if you cannot tell,
  "kind": "receipt" | "note" | "job_document" — "receipt" for receipts and bills, "note" for handwriting, otherwise "job_document",
  "title": short label, e.g. "Home Depot — $84.12" or "Note: call inspector Tuesday",
  "summary": receipt/bill → brief list of what was bought; note → full clean transcription of the handwriting; otherwise what the document is,
  "document_number": the invoice, ticket or receipt number printed on it, exactly as printed, or null,
  "po_number": what is printed or written in its PO, customer order or job box, copied exactly as it appears (a contractor often writes the job's name or street there instead of a number), or null,
  "line_items": receipts, bills and credit memos ONLY — an array of every purchased or returned line: [{"description": item name, "quantity": number, "unit_price": price each (number), "amount": line total (number), "category": ${RECEIPT_LINE_CATEGORY_SCHEMA_HINT}}]. Transcribe EVERY line you can read, including tax as its own line. On a credit memo or a return, every line that comes back (and its tax) has a NEGATIVE amount and unit_price; a restocking fee the supplier keeps stays positive. Use [] otherwise,
  "vendor": store/supplier name or null,
  "amount": total in dollars as a number, or null — on a credit memo or a return, the total is NEGATIVE (money coming back),
  "date": "YYYY-MM-DD" date printed on it, or null,
  "category": "Receipt" | "Bill" | "Invoice" | "Photo" | "Plan" | "Permit" | "Other",
  "pricing_provisional": true | false — true when the price column is masked (*****), blank or "N/A", or the paper is a quote/counter preview rather than this account's own pricing,
  "payment": "paid_at_purchase" | "on_account" | "unknown" — "paid_at_purchase" ONLY when the document shows tender (cash tendered/change, a card number/••••, or an explicit PAID stamp); "on_account" when it shows a charge account, ON ACCT, net terms, "invoice", or a balance due; "unknown" when you cannot tell,
  "destination": "job" | "overhead" | "unsure" — "job" if the purchase is materials for a specific job; "overhead" if it is clearly a company expense NOT tied to one job (gas station, truck, shop supplies, small tools, phone, office, insurance, licenses); "unsure" otherwise,
  "overhead_category": ${AUTO_FILE_BUCKETS.map((b) => JSON.stringify(b)).join(" | ")} or null — only when destination is "overhead",
  "job_marks": what is PRINTED OR WRITTEN on it that names a job, copied exactly as it appears, each null when it is not there: {"address": the job, ship-to or delivery street address (house number and street only; never the store's or supplier's own address, never the address of the company this is billed or sold to), "job_name": a job name or job reference, "job_number": a job number, "customer": the customer or homeowner the work is for (never the store, never the company this is billed or sold to)},
  "job_hint": the words on the paper that point to a job (a job name, address or customer; never the store's or supplier's own address, never the name or address of the company this is billed or sold to), or null,
  "confidence": "low" | "medium" | "high"
}

Rules: copy job_marks only from what is on the paper; never fill one in from anything else. A gas-station or convenience receipt is overhead (Gas & Truck). Generic supply-house receipts with no job reference are "unsure", not overhead. A supplier's finance charge, service charge, late fee or interest is "unsure", never overhead. In every "description", write inches as the word in (e.g. "6 in EMT", not 6") and never put a raw double-quote character inside a JSON string.

${FOOD_AND_DRINK_PROMPT_RULE}

${MASKED_PRICE_PROMPT_RULE}`;
}

export type ReadFields = {
  kind: "receipt" | "note" | "job_document";
  doc_type: PaperType;
  title: string;
  summary: string | null;
  vendor: string | null;
  amount: number | null;
  item_date: string | null;
  category: string;
  confidence: "low" | "medium" | "high";
  payment: "paid_at_purchase" | "on_account" | "unknown" | null;
  line_items: BillLine[] | null;
  doc_number: string | null;
  pricing_provisional: boolean;
  /** Suggestions only. */
  proposal: PaperProposal;
};

const KIND_TO_CATEGORY: Record<string, string> = { receipt: "Receipt", note: "Other", job_document: "Plan" };

/** The words the reader copied off the paper that name a job, cleaned. Never from the job list. */
function marksOf(parsed: any): PaperMarks {
  const m = parsed?.job_marks && typeof parsed.job_marks === "object" ? parsed.job_marks : {};
  const s = (v: unknown) => {
    const t = String(v ?? "").trim().replace(/\s+/g, " ");
    return t && !/^(null|none|n\/a|unknown)$/i.test(t) ? t.slice(0, 200) : null;
  };
  return {
    address: s(m.address),
    jobName: s(m.job_name),
    jobNumber: s(m.job_number),
    customer: s(m.customer),
    po: s(parsed?.po_number),
    hint: s(parsed?.job_hint),
  };
}

export type ReaderOptions = {
  /** Every open job, for the exact match of the paper's printed marks (jobFromPaperMarks). */
  markJobs?: MarkJob[];
  /** This org's purchase orders, so a printed PO number finds its job. */
  pos?: MarkPo[];
  /** The company's own name and its people's: never a customer or a job name on the paper. */
  selfNames?: string[];
  /** A person answered "Bill Or Receipt" to "What is this?": it is a cost, whatever the model says. */
  personSaysCost?: boolean;
};

/** What the reader said, cleaned into the row's columns. Nothing here files anything. */
export function readerFields(parsed: any, fallbackTitle: string, opts: ReaderOptions = {}): ReadFields {
  const rawType = String(parsed?.paper_type ?? "").trim().toLowerCase();
  const saidPicture = rawType === "photo" || rawType === "picture";
  let typeRead = saidPicture ? "not_a_cost" : paperTypeOf(parsed?.paper_type);
  const kindRead = ["receipt", "note", "job_document"].includes(parsed?.kind) ? parsed.kind : null;
  // A person said it is a bill or a receipt: that beats the model. What it owes is still the
  // paper's to say (a bill if the model read one, otherwise a receipt).
  if (opts.personSaysCost && typeRead !== "receipt" && typeRead !== "bill") typeRead = "receipt";
  // The type decides the kind, so a "bill" can never sit in the tray as a job document with no
  // cost controls on it.
  const doc_type: PaperType = (typeRead as PaperType | null) ?? (kindRead === "receipt" ? "receipt" : "other");
  const picture = !opts.personSaysCost && (saidPicture || ((doc_type === "not_a_cost" || doc_type === "other") && parsed?.category === "Photo"));
  // A PICTURE IS NEVER A NOTE, even a picture of handwriting (a panel schedule, a label): a note
  // keeps itself, and a picture asks a person "What is this?" first.
  const kind: ReadFields["kind"] =
    doc_type === "receipt" || doc_type === "bill" ? "receipt" : kindRead === "note" && !picture ? "note" : "job_document";
  let category = String(parsed?.category || (doc_type === "bill" ? "Bill" : KIND_TO_CATEGORY[kind]) || "Other").slice(0, 60);
  if (picture) category = "Photo";
  else if (opts.personSaysCost && !/^(Receipt|Bill|Invoice)$/.test(category)) category = doc_type === "bill" ? "Bill" : "Receipt";
  const title = String(parsed?.title || fallbackTitle).slice(0, 200);
  const confidence = ["low", "medium", "high"].includes(parsed?.confidence) ? parsed.confidence : "medium";
  const readAmount = parsed?.amount != null && !isNaN(Number(parsed.amount)) ? Number(parsed.amount) : null;
  // A credit memo is money coming back, whatever sign the reader printed on it.
  const amount = doc_type === "credit_memo" && readAmount !== null ? -Math.abs(readAmount) : readAmount;
  const item_date = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed?.date ?? "")) ? String(parsed.date) : null;
  const vendor = parsed?.vendor ? String(parsed.vendor).slice(0, 200) : null;
  const summary = parsed?.summary ? String(parsed.summary).slice(0, 4000) : null;
  const isCost = kind === "receipt";
  /**
   * A CREDIT MEMO KEEPS ITS LINES (audit v994, DB4). They used to be dropped for anything that was
   * not a receipt or a bill, and a credit memo is neither - until a person switches it to Bill in
   * Fix Details and files it on a job. Then it became a negative bill with NO lines, the importer
   * had nothing to hold against the purchase it reverses (returnLinesAgainstPurchases), and it
   * credited the customer the whole return at markup - the INV-078 housings, $64.48 back for parts
   * Andrew was never charged. The lines are what make a return creditable only for what was billed.
   */
  const keepsLines = isCost || doc_type === "credit_memo";
  const lines = keepsLines ? linesPointWithTotal(amount, cleanLines(parsed?.line_items)) : [];
  const payment = isCost
    ? ((["paid_at_purchase", "on_account", "unknown"].includes(String(parsed?.payment ?? "")) ? String(parsed.payment) : "unknown") as ReadFields["payment"])
    : null;
  // Two chances at the counter-preview fact (0271): what the model answered, or the mask still
  // visible in what it transcribed.
  const pricing_provisional =
    parsed?.pricing_provisional === true ||
    looksProvisionallyPriced(String(parsed?.summary ?? "")) ||
    lines.some((l) => looksProvisionallyPriced(l?.description));
  // WHERE IT GOES (Erik, 2026-09-24). The job is PICKED only when what is printed on the paper
  // names exactly one open job, matched in code (jobFromPaperMarks), never by the model. The
  // reader is never shown the jobs, so it has no job to guess; its bucket is a GUESS, offered on
  // the row as a chip, never picked. A bucket only for a cost the reader called overhead, never
  // Fees, never anything fee-shaped.
  const marks = marksOf(parsed);
  const bucketRead = parsed?.destination === "overhead" ? bucketOf(parsed?.overhead_category) : null;
  const feeShaped = bucketRead === "Fees" || looksLikeSupplierFee(title, vendor, summary);
  // THE COMPANY'S OWN USE IS READ THE SAME WAY (Erik, 2026-09-24): "TOOLS" in the PO box picks
  // Tools & Supplies in code, exactly, the way "13897 HERRINGBONE" picks the job. A job mark
  // beats it; a paper naming both says so and picks nothing (placeFromMarks).
  const { job: byMarks, companyUse } = placeFromMarks(marks, opts.markJobs ?? [], opts.pos ?? [], opts.selfNames ?? [], { feeShaped });
  const hint = parsed?.job_hint ? String(parsed.job_hint).slice(0, 200) : null;
  const bucket = isCost && bucketRead && !feeShaped ? bucketRead : null;
  const proposal: PaperProposal = {
    jobId: byMarks.kind === "one" ? byMarks.jobId : null,
    jobFrom: byMarks.kind === "one" ? byMarks.from : null,
    jobHint: byMarks.kind === "one" ? byMarks.words || hint : hint,
    jobConflict: byMarks.kind === "conflict" ? byMarks.sentence : null,
    guessJobId: null,
    bucket,
    // The chip says whose guess it is: this one is the reader's, from the paper.
    bucketFrom: bucket ? "reader" : null,
    ...(companyUse ? { companyUse } : {}),
    po: cleanDocNumber(parsed?.po_number),
    // Kept, so the tray can match this paper again when the rules learn something (rematchPaper).
    marks,
    ...(picture ? { picture: true } : {}),
  };
  return {
    kind,
    doc_type,
    title,
    summary,
    vendor,
    amount,
    item_date,
    category,
    confidence,
    payment,
    line_items: lines.length ? lines : null,
    doc_number: cleanDocNumber(parsed?.document_number),
    pricing_provisional,
    proposal,
  };
}

/** The columns 0295 adds. A write that fails on one of them (the code deployed ahead of the
 *  migration) is retried without them, so a read is never lost to a missing column. */
export const PAPERWORK_COLUMNS = [
  "doc_type",
  "doc_number",
  "content_sha256",
  "source",
  "proposal",
  "pricing_provisional",
  "tied_bill_id",
  "tied_supplier_invoice_id",
] as const;

export function isMissingColumnError(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const message = String((err as { message?: string })?.message ?? "");
  return code === "42703" || code === "PGRST204" || /column .* does not exist|Could not find the .* column/i.test(message);
}

/**
 * Update an organized_items row; on a missing-column error, once more without 0295's columns.
 *
 * `onlyIfStatus` (audit v994, TD6): the write lands only while the row is still in that status. A
 * read takes 5 to 20 seconds, and a paper filed from another screen in the meantime must not be
 * put back in the tray over its live bill by the read landing late. Zero rows back is the answer.
 */
export async function updateItemTolerant(
  supabase: any,
  id: string,
  orgId: string | null | undefined,
  patch: Record<string, unknown>,
  opts: { onlyIfStatus?: string } = {},
) {
  const write = (p: Record<string, unknown>) => {
    let q = supabase.from("organized_items").update(p).eq("id", id);
    if (orgId) q = q.eq("org_id", orgId);
    if (opts.onlyIfStatus) q = q.eq("status", opts.onlyIfStatus);
    return q.select("id");
  };
  const first = await write(patch);
  if (!first.error || !isMissingColumnError(first.error)) return first;
  const older = { ...patch };
  for (const c of PAPERWORK_COLUMNS) delete older[c];
  return write(older);
}

// ── WHAT IS ALREADY ON THE BOOKS ────────────────────────────────────────────────────────────

export type Books = {
  bills: BookedBill[];
  papers: BookedPaper[];
  supplierInvoices: BookedSupplierInvoice[];
  aliases: SupplierAliasIndex;
};

/**
 * Every printed number this org already holds: bills with a number, the supplier's own documents,
 * and papers read here. One read of each, filtered in code, because "8802-1108330" and
 * "#8802 1108330" are the same number and SQL equality would call them two. A read that fails is
 * an empty list: the offer to tie is a convenience, and File It stays open either way.
 */
export async function loadBooks(supabase: any, orgId: string | null | undefined): Promise<Books> {
  const empty: Books = { bills: [], papers: [], supplierInvoices: [], aliases: new Map() };
  if (!orgId) return empty;
  const safe = async <T,>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    try {
      const { data, error } = await p;
      return error ? [] : ((data ?? []) as T[]);
    } catch {
      return [];
    }
  };
  const [bills, papers, supplierInvoices, aliasRows, links] = await Promise.all([
    safe<BookedBill>(
      supabase
        .from("bills")
        // BOTH NUMBER COLUMNS, and whether it was set aside (audit v994, DB1): a bill Record It As
        // A Bill wrote carries the number in supplier_invoice_number, and a set-aside copy (0271)
        // is not on the books at all.
        //
        // FILTERED IN SQL, NEWEST FIRST (review of that fix). Reading every bill in the org under a
        // 5000 cap with no order would, past the cap, drop an arbitrary set, and a match missed
        // here is a second bill. Only a bill with a number in either column can match, only a live
        // one counts, and if the cap is ever reached it is the oldest that fall off.
        .select("id, supplier, bill_number, supplier_invoice_number, supplier_account_id, superseded_by_bill_id, amount, bill_date, job_id, jobs(job_number, name)")
        .eq("org_id", orgId)
        .or("bill_number.not.is.null,supplier_invoice_number.not.is.null")
        .is("superseded_by_bill_id", null)
        .order("created_at", { ascending: false })
        .limit(5000),
    ),
    safe<BookedPaper>(
      supabase
        .from("organized_items")
        .select("id, vendor, doc_number, status, bill_id, title")
        .eq("org_id", orgId)
        .not("doc_number", "is", null)
        .limit(5000),
    ),
    safe<BookedSupplierInvoice>(
      supabase.from("supplier_invoices").select("id, invoice_number, supplier_account_id, total, invoice_date").eq("org_id", orgId).limit(5000),
    ),
    safe<{ alias: string; supplier_account_id: string }>(
      supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", orgId).limit(5000),
    ),
    // WHICH CED DOCUMENTS A BILL ALREADY COVERS (0273/0277). A document with a bill behind it is
    // that bill's purchase; one without is not a cost at all, and File It links the new bill to it.
    safe<{ supplier_invoice_id: string; bill_id: string; bills?: { id?: string; job_id?: string | null; jobs?: { job_number?: string | null; name?: string | null } | null } | null }>(
      supabase
        .from("bill_supplier_invoices")
        .select("supplier_invoice_id, bill_id, bills(id, job_id, jobs(job_number, name))")
        .eq("org_id", orgId)
        .limit(5000),
    ),
  ]);
  const cover = new Map<string, NonNullable<BookedSupplierInvoice["covered_by"]>>();
  for (const l of links) {
    if (!l?.supplier_invoice_id || !l.bill_id) continue;
    cover.set(String(l.supplier_invoice_id), { id: String(l.bill_id), job_id: l.bills?.job_id ?? null, jobs: l.bills?.jobs ?? null });
  }
  return {
    bills,
    papers,
    supplierInvoices: supplierInvoices.map((si) => ({ ...si, covered_by: cover.get(String(si.id)) ?? null })),
    aliases: indexSupplierAliases(aliasRows),
  };
}

export function matchesOnBooks(item: PaperItem, books: Books): NumberMatch[] {
  return findSameNumber(item, books, books.aliases);
}

/**
 * The needs_review row a piece of paper becomes the moment its file is safely in storage, BEFORE
 * anything reads it: a failed read or a phone that suspends mid-read can never lose the paper.
 * On code that deployed ahead of 0295, the fingerprint and source are dropped rather than the
 * row. A second copy of the same file is the unique index's refusal, handed back as `duplicate`.
 */
export async function insertPaperRow(
  supabase: any,
  row: {
    title: string;
    file_url: string;
    created_by: string;
    content_sha256?: string | null;
    source?: "organize" | "bills_drop" | "job";
    doc_type?: PaperType | null;
    doc_number?: string | null;
    vendor?: string | null;
    amount?: number | null;
    item_date?: string | null;
    kind?: string;
    proposal?: PaperProposal | null;
    confidence?: string;
  },
): Promise<{ id: string } | { duplicate: true } | { error: unknown }> {
  const full: Record<string, unknown> = {
    kind: row.kind ?? "job_document", // best guess until something has read it
    title: row.title.slice(0, 200),
    confidence: row.confidence ?? "low",
    status: "needs_review",
    file_url: row.file_url,
    created_by: row.created_by,
    content_sha256: row.content_sha256 ?? null,
    source: row.source ?? "organize",
    doc_type: row.doc_type ?? null,
    doc_number: row.doc_number ?? null,
    vendor: row.vendor ?? null,
    amount: row.amount ?? null,
    item_date: row.item_date ?? null,
    proposal: row.proposal ?? null,
  };
  const insert = (r: Record<string, unknown>) => supabase.from("organized_items").insert(r).select("id").single();
  let res = await insert(full);
  if (res.error && isMissingColumnError(res.error)) {
    const older = { ...full };
    for (const c of PAPERWORK_COLUMNS) delete older[c];
    res = await insert(older);
  }
  if (res.error) {
    if (String((res.error as { code?: string }).code ?? "") === "23505") return { duplicate: true };
    return { error: res.error };
  }
  if (!res.data?.id) return { error: new Error("The paper's row came back empty.") };
  return { id: String(res.data.id) };
}

// ── WHAT ELSE STANDS ON A FILING (audit v994, TD1-TD5) ────────────────────────────────────────

const moneySaid = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A bill a filing made, and everything that leans on it, read before it is torn down. */
export type BillStanding = {
  /** Copies set aside as duplicates OF this bill (0271). Deleting it makes them count again. */
  setAside: { id: string; label: string }[];
  /** Other papers tied to this bill (0295 tied_bill_id), which would be left filed over nothing. */
  tiedPapers: { id: string; title: string; proposal: unknown }[];
  /** The bill's lines as a person left them (switched off, part-used), in the bill's order. */
  lines: BillLine[];
  /** The bill's total as it stands now. */
  amount: number | null;
  /** A Shop Stock ticket (0303): its rolls come off with it, which is what its Undo means. */
  onShelf: boolean;
  /** Lines with a roll on the shop shelf, on a bill that is NOT a shelf ticket. */
  stocked: string[];
};

const jobSaid = (b: { job_id?: string | null; jobs?: { job_number?: string | null; name?: string | null } | null }) =>
  b.jobs?.job_number ? `${b.jobs.job_number}${b.jobs.name ? ` ${b.jobs.name}` : ""}` : b.job_id ? "a job" : "business costs";

/**
 * READ WHAT STANDS ON A BILL BEFORE IT COMES DOWN. Null: the bill is already gone. `error`: the
 * read failed, and the caller refuses rather than guessing that nothing leans on it (a set-aside
 * copy counting again is a cost counted twice, said nowhere).
 */
export async function readBillStanding(
  supabase: any,
  orgId: string | null | undefined,
  billId: string,
): Promise<BillStanding | { error: string } | null> {
  const scoped = (q: any) => (orgId ? q.eq("org_id", orgId) : q);
  const [billRead, copiesRead, tiedRead] = await Promise.all([
    scoped(
      supabase
        .from("bills")
        .select("id, amount, on_shelf, bill_line_items(description, quantity, unit_price, amount, category, billable, billed_amount, is_stock, sort_order)")
        .eq("id", billId),
    ).maybeSingle(),
    scoped(supabase.from("bills").select("id, supplier, amount, bill_date, job_id, jobs(job_number, name)").eq("superseded_by_bill_id", billId)).limit(20),
    scoped(supabase.from("organized_items").select("id, title, vendor, proposal").eq("tied_bill_id", billId)).limit(50),
  ]);
  if (billRead?.error || copiesRead?.error || tiedRead?.error) {
    reportError("organize:readBillStanding", billRead?.error ?? copiesRead?.error ?? tiedRead?.error, { billId });
    return { error: "Couldn't check what else stands on this bill, so nothing was changed. Try again." };
  }
  const bill = billRead?.data as any;
  if (!bill) return null;
  const raw = [...((bill.bill_line_items ?? []) as any[])].sort((a, b) => Number(a?.sort_order ?? 0) - Number(b?.sort_order ?? 0));
  const amount = bill.amount === null || bill.amount === undefined || !Number.isFinite(Number(bill.amount)) ? null : Number(bill.amount);
  return {
    setAside: ((copiesRead?.data ?? []) as any[]).map((c) => ({
      id: String(c.id),
      label: `${jobSaid(c)} (${c.supplier ?? "a bill"}${Number.isFinite(Number(c.amount)) ? `, ${moneySaid(Number(c.amount))}` : ""}${c.bill_date ? `, ${String(c.bill_date).slice(0, 10)}` : ""})`,
    })),
    tiedPapers: ((tiedRead?.data ?? []) as any[]).map((t) => ({ id: String(t.id), title: String(t.title ?? t.vendor ?? "a paper"), proposal: t.proposal })),
    lines: cleanLines(raw),
    amount,
    onShelf: bill.on_shelf === true,
    stocked: bill.on_shelf === true ? [] : raw.filter((l) => l?.is_stock === true).map((l) => String(l.description ?? "a line")),
  };
}

/**
 * WHY A BILL CAN'T COME DOWN FROM HERE, in the words for the button pressed, or null.
 *
 *   · A copy set aside as ITS duplicate (Erik, audit v994 TD2: "Undo refuses when a duplicate copy
 *     was set aside against the bill, and names that copy"). Deleting the keeper un-sets-aside the
 *     copy (the column is ON DELETE SET NULL), so the copy would count on its job again, silently.
 *   · A line with a roll on the shop shelf, on a bill that is not a shelf ticket: the roll can't
 *     ride back onto the paper, and taking the bill down would take the roll off with no word.
 */
export function standingRefusal(st: BillStanding, then: string, nothing: string, opts: { shelf?: boolean } = {}): string | null {
  if (st.setAside.length) {
    const c = st.setAside[0];
    const more = st.setAside.length > 1 ? ` and ${st.setAside.length - 1} more` : "";
    return `The copy on ${c.label}${more} was set aside as a duplicate of this bill, so taking this one down would make that copy count on its job again. On Bills, under The Same Ticket On Two Jobs, press Change Your Mind first, then ${then}. ${nothing}`;
  }
  if (opts.shelf !== false && st.stocked.length) {
    const n = st.stocked.length;
    return `${n === 1 ? `A line of this receipt (${st.stocked[0]}) is` : `${n} lines of this receipt are`} on the shop shelf, and that can't go back onto the paper. On Bills, press Take It Off The Shelf on ${n === 1 ? "it" : "them"} first, then ${then}. ${nothing}`;
  }
  return null;
}

/**
 * THE PAPERS TIED TO A BILL THAT JUST CAME DOWN go back to the tray, each in its own write (its
 * proposal keeps what the reader said and loses only `filed`), and their titles come back so the
 * sentence can name them. Before this they stayed "filed", tied to nothing, gone from the tray.
 */
export async function returnTiedPapers(
  supabase: any,
  orgId: string | null | undefined,
  papers: BillStanding["tiedPapers"],
  /** Set when the bill was deleted from Bills (papersAfterBillDeleted): the row says why it is back. */
  billDeleted: PaperProposal["billDeleted"] = null,
): Promise<string[]> {
  const back: string[] = [];
  for (const t of papers) {
    const p = t.proposal && typeof t.proposal === "object" && !Array.isArray(t.proposal) ? (t.proposal as Record<string, unknown>) : null;
    const proposal = billDeleted ? { proposal: { ...(p ?? {}), filed: null, billDeleted } } : p ? { proposal: { ...p, filed: null } } : {};
    let q = supabase
      .from("organized_items")
      .update({ status: "needs_review", tied_bill_id: null, tied_supplier_invoice_id: null, job_id: null, ...proposal })
      .eq("id", t.id);
    if (orgId) q = q.eq("org_id", orgId);
    const { data, error } = await q.select("id");
    if (error || !data?.length) {
      reportError("organize:returnTiedPapers", error ?? new Error("tied paper update wrote no rows"), { itemId: t.id });
      continue;
    }
    back.push(t.title);
  }
  return back;
}

/**
 * THE DOCUMENT A FILING POINTS AT, AND WHETHER THE FILING MADE IT (audit v994, TD1).
 *
 * A receipt recorded as a cost on the job page (billJobReceipt) gets a link row pointing at the
 * job's OWN upload: the filing never made that document, and Undo or Delete must never take it
 * off the job. Such a row says so (source 'job'); a row written before it said so is known by its
 * document being older than the row itself (30 of ET's link rows). A document the filing made is
 * always created after its paper's row.
 */
export async function filingDocument(
  supabase: any,
  orgId: string | null | undefined,
  item: { document_id?: string | null; source?: string | null; created_at?: string | null },
): Promise<{ id: string; file_url: string | null; owned: boolean } | { error: unknown } | null> {
  if (!item.document_id) return null;
  let q = supabase.from("documents").select("id, created_at, file_url").eq("id", item.document_id);
  if (orgId) q = q.eq("org_id", orgId);
  const { data, error } = await q.maybeSingle();
  if (error) return { error };
  if (!data) return null;
  const older = !!data.created_at && !!item.created_at && Date.parse(String(data.created_at)) < Date.parse(String(item.created_at));
  return { id: String(data.id), file_url: data.file_url ?? null, owned: item.source !== "job" && !older };
}

/** A table this database doesn't have yet (a migration not applied): nothing can lean on it. */
function tableNotThere(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "42P01" || code === "PGRST205" || /does not exist|could not find the table/i.test(msg);
}

/**
 * WHAT ELSE STANDS ON A DOCUMENT A FILING MADE, READ BEFORE IT IS DELETED (review of audit v994
 * wave 2, PR4). A photo filed from Organize now lands in the job's own folder, so Show On Portal
 * takes it and the Panel tab can pick it. Deleting the documents row then took it off the
 * customer's page (job_shared_documents cascades, 0300/0326) and cleared the panel's photo
 * (job_panels.photo_document_id is ON DELETE SET NULL, 0333), with nothing said. So the door
 * refuses in words and names where to change it. Null: nothing stands on it.
 */
export async function documentInUse(
  supabase: any,
  orgId: string | null | undefined,
  documentId: string,
): Promise<{ sentence: string } | { error: unknown } | null> {
  let sq = supabase.from("job_shared_documents").select("document_id").eq("document_id", documentId).is("removed_at", null);
  if (orgId) sq = sq.eq("org_id", orgId);
  const { data: shared, error: shareErr } = await sq.limit(1);
  if (shareErr && !tableNotThere(shareErr)) return { error: shareErr };
  if (shared?.length)
    return { sentence: "It is shown on the customer's page. Press Take Off Portal on the job's Customer Page tab first" };
  let pq = supabase.from("job_panels").select("id, name").eq("photo_document_id", documentId).is("removed_at", null);
  if (orgId) pq = pq.eq("org_id", orgId);
  const { data: panels, error: panelErr } = await pq.limit(1);
  if (panelErr && !tableNotThere(panelErr)) return { error: panelErr };
  if (panels?.length) {
    const name = String(panels[0]?.name ?? "").trim();
    return { sentence: `It is the photo of ${name ? `the panel "${name}"` : "a panel"} on the job's Panel tab. Pick another photo for that panel first` };
  }
  return null;
}

/** A job's own storage folder: <org>/<job>/..., never one of 0213's staff-only folders. */
export function isJobFolderPath(path: string | null | undefined, orgId: string | null | undefined): boolean {
  const p = String(path ?? "");
  if (!orgId || !p.startsWith(`${orgId}/`) || p.includes("..")) return false;
  const second = p.split("/")[1] ?? "";
  return !!second && !["employees", "organize", "bug-screenshots", "picks"].includes(second);
}

/**
 * A PAPER FILED ON A JOB GETS ITS OWN COPY IN THE JOB'S FOLDER (audit v994, PR4). The paper lives
 * in <org>/organize/, which 0213 keeps staff-only: the office saw a panel photo filed to J-047 and
 * the tech on J-047 did not, and Show On Portal refused it as not in the job's folder. The copy
 * keeps the file's extension (the Photos tab knows a picture by it); the organize original stays
 * for the tray and Undo. Null: the copy didn't land, and the caller says so.
 */
export async function copyToJobFolder(supabase: any, orgId: string, jobId: string, from: string): Promise<string | null> {
  const base = String(from.split("/").pop() ?? "file").replace(/^\d{10,}-/, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80) || "file";
  const to = `${orgId}/${jobId}/${Date.now()}-${base}`;
  try {
    const { error } = await supabase.storage.from("documents").copy(from, to);
    if (error) {
      reportError("organize:copyToJobFolder", error, { from, to });
      return null;
    }
    return to;
  } catch (e) {
    reportError("organize:copyToJobFolder", e, { from, to });
    return null;
  }
}

/** Take a copy a filing made back out of storage. Costs storage, never money: logged, not refused. */
export async function removeCopy(supabase: any, path: string | null | undefined, orgId: string | null | undefined): Promise<void> {
  if (!path || !isJobFolderPath(path, orgId)) return;
  try {
    const { error } = await supabase.storage.from("documents").remove([path]);
    if (error) reportError("organize:removeCopy", error, { path });
  } catch (e) {
    reportError("organize:removeCopy", e, { path });
  }
}

/** A paper that MADE a bill (organized_items.bill_id), read before the bill is deleted elsewhere. */
export type PaperBehindBill = {
  id: string;
  title: string;
  source: string | null;
  created_at: string | null;
  document_id: string | null;
  file_url: string | null;
  doc_type: string | null;
  category: string | null;
  kind: string | null;
  proposal: unknown;
};

/**
 * THE PAPERS BEHIND A BILL, read BEFORE the bill is deleted from Bills or a job's Costs (audit
 * v994, TD5): organized_items.bill_id is ON DELETE SET NULL, so after the delete nothing says which
 * paper made it. A failed read is an empty list (the bill is still the person's to delete).
 */
export async function papersBehindBill(supabase: any, orgId: string | null | undefined, billId: string): Promise<PaperBehindBill[]> {
  try {
    let q = supabase
      .from("organized_items")
      .select("id, title, vendor, source, created_at, document_id, file_url, doc_type, category, kind, proposal")
      .eq("bill_id", billId);
    if (orgId) q = q.eq("org_id", orgId);
    const { data, error } = await q.limit(20);
    if (error) {
      reportError("organize:papersBehindBill", error, { billId });
      return [];
    }
    return ((data ?? []) as any[]).map((r) => ({
      id: String(r.id),
      title: String(r.title ?? r.vendor ?? "a paper"),
      source: r.source ?? null,
      created_at: r.created_at ?? null,
      document_id: r.document_id ?? null,
      file_url: r.file_url ?? null,
      doc_type: r.doc_type ?? null,
      category: r.category ?? null,
      kind: r.kind ?? null,
      proposal: r.proposal ?? null,
    }));
  } catch (e) {
    reportError("organize:papersBehindBill", e, { billId });
    return [];
  }
}

/**
 * A BILL DELETED FROM BILLS PUTS ITS PAPER BACK (audit v994, TD5). The paper used to stay "filed"
 * over nothing, and dropping the same file again was refused as "Already In: filed on J-052", a job
 * with no such cost. Now: the copy the filing put on the job comes off, and the paper goes back to
 * Sort These with the lines the bill had (so a re-file keeps a person's choices, TD3). A receipt
 * recorded as a cost on the job page keeps its receipt on the job; its link row goes, so Record as
 * Cost there makes it a cost again. Returns the sentence to say, or "".
 */
export async function papersAfterBillDeleted(
  supabase: any,
  orgId: string | null | undefined,
  makers: PaperBehindBill[],
  standing: BillStanding | null,
  /** Who deleted the bill, kept on the paper beside when (billDeleted). */
  by: string | null = null,
): Promise<string> {
  const billDeleted = { at: new Date().toISOString(), by };
  const back: string[] = [];
  const onJob: string[] = [];
  for (const m of makers) {
    const doc = await filingDocument(supabase, orgId, m);
    const jobsOwn = m.source === "job" || (!!doc && !("error" in doc) && !doc.owned);
    if (jobsOwn) {
      let q = supabase.from("organized_items").delete().eq("id", m.id);
      if (orgId) q = q.eq("org_id", orgId);
      const { error } = await q.select("id");
      if (error) reportError("organize:papersAfterBillDeleted.link", error, { itemId: m.id });
      else onJob.push(m.title);
      continue;
    }
    if (doc && !("error" in doc) && doc.owned) {
      const { error: docErr } = await supabase.from("documents").delete().eq("id", doc.id).select("id");
      if (docErr) reportError("organize:papersAfterBillDeleted.doc", docErr, { itemId: m.id, documentId: doc.id });
      else if (doc.file_url && doc.file_url !== m.file_url) await removeCopy(supabase, doc.file_url, orgId);
    }
    const p = m.proposal && typeof m.proposal === "object" && !Array.isArray(m.proposal) ? (m.proposal as Record<string, unknown>) : null;
    const isCost = m.kind === "receipt" || m.doc_type === "receipt" || m.doc_type === "bill";
    const patch: Record<string, unknown> = {
      status: "needs_review",
      job_id: null,
      document_id: null,
      bill_id: null,
      petty_cash_id: null,
      ...(isCost ? { category: m.doc_type === "bill" || /bill|invoice/i.test(String(m.category ?? "")) ? "Bill" : "Receipt" } : {}),
      ...(standing?.lines.length ? { line_items: standing.lines } : {}),
      ...(standing && standing.amount !== null ? { amount: standing.amount } : {}),
      // WHY IT IS BACK (review of wave 2, TD5): a deleted bill is often a duplicate, and a paper
      // with no printed number has nothing stopping a second File It. The row asks.
      proposal: { ...(p ?? {}), filed: null, billDeleted },
    };
    let q = supabase.from("organized_items").update(patch).eq("id", m.id);
    if (orgId) q = q.eq("org_id", orgId);
    const { data, error } = await q.select("id");
    if (error || !data?.length) {
      reportError("organize:papersAfterBillDeleted.back", error ?? new Error("paper update wrote no rows"), { itemId: m.id });
      continue;
    }
    back.push(m.title);
  }
  const tied = standing?.tiedPapers.length ? await returnTiedPapers(supabase, orgId, standing.tiedPapers, billDeleted) : [];
  const all = [...back, ...tied];
  const parts = [
    all.length
      ? `${all.length === 1 ? `Its paper, "${all[0]}", is` : `${all.length} papers behind it are`} back in Sort These. If this bill was a duplicate, press Set Aside on ${all.length === 1 ? "that paper" : "them"}; if not, File It again.`
      : "",
    onJob.length ? `The receipt stays on the job; Record as Cost there makes it a cost again.` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

/**
 * THE CED DOCUMENTS A PAPER ADDED come off the list (Undo, and Delete: audit v994 TD4), except any
 * something already points at: a bill covering it, a job a person set, or another paper tied to it.
 * Those are kept and named.
 */
export async function takeDownLanded(
  supabase: any,
  orgId: string | null | undefined,
  landed: string[],
): Promise<{ kept: string[]; error?: string }> {
  if (!landed.length || !orgId) return { kept: [] };
  const { data: docs, error: docsErr } = await supabase
    .from("supplier_invoices")
    .select("id, invoice_number, job_id")
    .eq("org_id", orgId)
    .in("invoice_number", landed);
  if (docsErr) return { kept: [], error: dbError(docsErr) };
  const ids = ((docs ?? []) as any[]).map((d) => String(d.id));
  const { data: links } = ids.length
    ? await supabase.from("bill_supplier_invoices").select("supplier_invoice_id").in("supplier_invoice_id", ids)
    : { data: [] };
  const linked = new Set(((links ?? []) as any[]).map((l) => String(l.supplier_invoice_id)));
  // ANOTHER PAPER TIED TO ONE OF THEM. tied_supplier_invoice_id is ON DELETE SET NULL (0295), so
  // deleting the document would leave that paper "filed", tied to nothing, gone from the tray
  // without a word. It is kept and named like the rest.
  const { data: tiedPapers } = ids.length
    ? await supabase.from("organized_items").select("tied_supplier_invoice_id").eq("org_id", orgId).in("tied_supplier_invoice_id", ids)
    : { data: [] };
  for (const t of (tiedPapers ?? []) as any[]) if (t?.tied_supplier_invoice_id) linked.add(String(t.tied_supplier_invoice_id));
  const removable = ((docs ?? []) as any[]).filter((d) => !linked.has(String(d.id)) && !d.job_id);
  const kept = ((docs ?? []) as any[]).filter((d) => !removable.includes(d)).map((d) => String(d.invoice_number));
  if (removable.length) {
    const { error: delErr } = await supabase
      .from("supplier_invoices")
      .delete()
      .eq("org_id", orgId)
      .in("id", removable.map((d) => String(d.id)))
      .select("id");
    if (delErr) return { kept, error: dbError(delErr) };
  }
  return { kept };
}
