import "server-only";

import { reportError } from "@/lib/observe";
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
export const OPEN_JOBS_FOR_PAPER = 500;

/** Everything the exact job match needs, read once: the open jobs, the org's POs, and who the
 *  company itself is. */
export type MarkContext = { markJobs: MarkJob[]; pos: MarkPo[]; selfNames: string[] };

/**
 * The open jobs (with their number, name, street and customer) for the exact match of what is
 * printed on the paper (jobFromPaperMarks). The reader model never sees them (paperReaderSystem).
 * The same open jobs, and as many, as the Organize row's picker offers (OPEN_JOBS_FOR_PAPER).
 *
 * Beside them, and never able to fail the read: this org's purchase orders (a printed PO number
 * finds its job), and SELF NAMES, the company's own name and its people's (Erik, 2026-09-24: a CED
 * ticket prints "ERIK TAYLOR" as who it was sold to, on every ticket, and that is never the
 * customer). A read that fails is an empty list: no PO match, no names set aside.
 */
export async function loadMarkContext(supabase: any, orgId: string | null | undefined): Promise<MarkContext> {
  let jq = supabase.from("jobs").select("id, job_number, name, address, customers(name, company_name)");
  if (orgId) jq = jq.eq("org_id", orgId);
  const { data: jobs } = await jq.in("status", ACTIVE_JOB_STATUSES).order("created_at", { ascending: false }).limit(OPEN_JOBS_FOR_PAPER);
  const rows = (jobs ?? []) as any[];
  let pos: MarkPo[] = [];
  let selfNames: string[] = [];
  await Promise.all([
    (async () => {
      try {
        let pq = supabase.from("purchase_orders").select("po_number, job_id");
        if (orgId) pq = pq.eq("org_id", orgId);
        const { data, error } = await pq.not("job_id", "is", null).limit(2000);
        if (!error) pos = ((data ?? []) as MarkPo[]).filter((p) => p?.po_number && p?.job_id);
      } catch {
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

/** Update an organized_items row; on a missing-column error, once more without 0295's columns. */
export async function updateItemTolerant(supabase: any, id: string, orgId: string | null | undefined, patch: Record<string, unknown>) {
  const write = (p: Record<string, unknown>) => {
    let q = supabase.from("organized_items").update(p).eq("id", id);
    if (orgId) q = q.eq("org_id", orgId);
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
