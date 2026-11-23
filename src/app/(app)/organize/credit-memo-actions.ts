"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { cleanLines } from "@/lib/paper-lines";
import { creditMemoNoneSentence, creditMemoReverses, isWaitingCreditMemo, linesPointWithTotal, proposalOf, type PaperProposal } from "@/lib/paperwork";
import { billLabel, billsCarryingNumber, purchasesOf, sameSupplier, type LedgerBill } from "@/lib/same-purchase";
import { indexSupplierAliases, type SupplierAliasIndex } from "@/lib/supplier-identity";
import { billLabel as numberLabel, lineWords, purchaseCents } from "@/lib/bill-correction";
import { restampLotsForBill } from "@/lib/stock-ledger";
import { BRING_IN_NEW_WORK } from "@/lib/actuals-draw";
import { formatCurrency } from "@/lib/utils";
import {
  CLOSES,
  bestHomes,
  correctionInput,
  creditMemoSentence,
  memoGapCents,
  orderAfterSplits,
  pairCreditMemo,
  type MemoLine,
  type Pairing,
  type PurchaseLine,
  andList,
  creditAcrossBillsSentence,
  isTaxish,
  sameItemWords,
  pairCreditAcrossBills,
  returnTaxCheck,
  type BillPairing,
  type ReturnBill,
} from "@/lib/credit-memo-close";
import { ALREADY_FILED } from "@/lib/return-bill-door";
import { readBillClaimants, type BillClaimant } from "@/lib/bill-claimants";
import { correctBill } from "@/app/(app)/jobs/actions";
import { importCostsIntoInvoice } from "@/app/(app)/billing/actions";
import { isMissingColumnError } from "@/app/(app)/organize/paperwork-core";

/**
 * A CREDIT MEMO FILES WITH ITS BILL (cn-v1181). The tray's one door for a supplier's credit memo:
 * find the purchase it reverses, file it UNDER that purchase through the correction door (0381,
 * jobs/actions correctBill: never a second way to write a bill), then close the returned goods on
 * the purchase's lines by the pure rule in lib/credit-memo-close. Goods that went back stop showing
 * on the customer's next invoice, unless an invoice that went out already billed them.
 *
 * Three companies share one database: every read and write here names the company, every write is
 * read back, and a read that fails is said, never taken for "nothing there".
 */

type Result = { ok: boolean; error?: string; message?: string };
export type CreditMemoCandidate = { billId: string; label: string };
export type CreditMemoHomeResult =
  /** `by`: "number" when the memo's own printed reversal named the bill (the door files at once);
   *  "words" when its lines matched it best (the door names the bill and files on that tap). */
  | { ok: true; kind: "one"; by: "number" | "words"; candidate: CreditMemoCandidate }
  | { ok: true; kind: "several"; candidates: CreditMemoCandidate[] }
  | { ok: true; kind: "none"; sentence: string }
  | { ok: false; error: string };

const NOT_FILED = "Nothing was filed.";
const BILLS_READ_CAP = 2000;
const CUT_SENTENCE =
  "Only your newest 2,000 bills were searched, and none of them carries the lines this credit memo returns; the purchase it reverses may be older. Fix Details can still file it on a job, as before.";
const MEMO_COLUMNS = "id, org_id, status, kind, doc_type, category, vendor, doc_number, amount, item_date, line_items, proposal, bill_id";
const BILL_COLUMNS =
  "id, supplier, supplier_account_id, bill_number, supplier_invoice_number, amount, bill_date, job_id, corrects_bill_id, superseded_by_bill_id, jobs(job_number, name)";
const LINE_COLUMNS =
  "id, bill_id, description, quantity, unit_price, amount, category, billable, billed_amount, is_stock, returned, returned_credit_bill_id, sort_order";

type Ctx = { supabase: any; orgId: string; userId: string };
type Memo = { item: any; lines: MemoLine[]; number: string; total: number };
type Fail = { error: string };

async function staff(): Promise<Ctx | Fail> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!ctx.orgId) return { error: `Your sign-in isn't attached to a company yet. ${NOT_FILED}` };
  return { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId };
}

/** The memo, still waiting in the tray, with its lines as the bill would hold them. */
async function readMemo(c: Ctx, itemId: string): Promise<Memo | Fail> {
  const id = String(itemId ?? "").trim();
  if (!id) return { error: "Couldn't tell which paper you meant." };
  const { data: item, error } = await c.supabase.from("organized_items").select(MEMO_COLUMNS).eq("org_id", c.orgId).eq("id", id).maybeSingle();
  if (error) return { error: `Couldn't read that paper just now: ${dbError(error)} ${NOT_FILED}` };
  if (!item) return { error: "That paper isn't here any more. Reload the page." };
  if (!isWaitingCreditMemo(item)) return { error: `This paper isn't a credit memo waiting in the tray. ${NOT_FILED}` };
  const total = Number(item.amount);
  // As File It reads a paper's lines: cleaned, and pointed the way the total points.
  const lines = linesPointWithTotal(total, cleanLines(item.line_items)) as MemoLine[];
  if (!lines.length) return { error: `This credit memo was read with no lines, so it can't close anything on its bill. Press Read Again so its lines come with it. ${NOT_FILED}` };
  if (!Number.isFinite(total) || Math.round(total * 100) >= 0) return { error: `This credit memo has no credit total. Put it in with Fix Details. ${NOT_FILED}` };
  return { item, lines, number: String(item.doc_number ?? "").trim(), total };
}

async function readAliases(c: Ctx): Promise<SupplierAliasIndex | Fail> {
  const { data, error } = await c.supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", c.orgId).limit(5000);
  if (error) return { error: `Couldn't read your supplier names just now: ${dbError(error)} ${NOT_FILED}` };
  return indexSupplierAliases((data ?? []) as { alias: string; supplier_account_id: string }[]);
}

/** Every line of these bills, with 0417's columns. Chunked; a failed chunk is a failed read. */
async function readLines(c: Ctx, billIds: string[]): Promise<Map<string, PurchaseLine[]> | Fail> {
  const out = new Map<string, PurchaseLine[]>(billIds.map((id) => [id, []]));
  for (let i = 0; i < billIds.length; i += 100) {
    const { data, error } = await c.supabase.from("bill_line_items").select(LINE_COLUMNS).eq("org_id", c.orgId).in("bill_id", billIds.slice(i, i + 100));
    if (error) {
      if (isMissingColumnError(error)) return { error: `File With Its Bill isn't ready on this account yet. ${NOT_FILED} Try again shortly.` };
      return { error: `Couldn't read the bills' lines just now: ${dbError(error)} ${NOT_FILED}` };
    }
    for (const l of (data ?? []) as any[]) out.get(String(l.bill_id))?.push(l as PurchaseLine);
  }
  return out;
}

const one = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));
const asLedger = (b: any): LedgerBill => ({ ...b, jobs: one(b.jobs) });

/**
 * THE PURCHASE THIS CREDIT REVERSES. (a) The number the memo says it reverses, read the way File It
 * reads a paper's number (billsCarryingNumber), when it names exactly one live purchase of this
 * supplier; (b) else the supplier's purchase whose lines the memo names best (lib/credit-memo-close
 * bestHomes): one, several for a person to pick, or none.
 */
export async function creditMemoHome(itemId: string): Promise<CreditMemoHomeResult> {
  const c = await staff();
  if ("error" in c) return { ok: false, error: c.error };
  const memo = await readMemo(c, itemId);
  if ("error" in memo) return { ok: false, error: memo.error };
  const aliases = await readAliases(c);
  if ("error" in aliases) return { ok: false, error: aliases.error };
  const { data: rows, error } = await c.supabase
    .from("bills")
    .select(BILL_COLUMNS)
    .eq("org_id", c.orgId)
    .is("superseded_by_bill_id", null)
    .order("created_at", { ascending: false })
    .limit(BILLS_READ_CAP);
  if (error) return { ok: false, error: `Couldn't read your bills just now: ${dbError(error)} ${NOT_FILED}` };
  const vendor = String(memo.item.vendor ?? "").trim();
  const theirs = ((rows ?? []) as any[])
    .map(asLedger)
    .filter((b) => sameSupplier({ name: vendor, account: null }, { name: b.supplier, account: b.supplier_account_id ?? null }, aliases));
  const { purchases } = purchasesOf(theirs);
  const label = (b: LedgerBill): CreditMemoCandidate => {
    const p = purchases.find((x) => x.original.id === b.id);
    return { billId: b.id, label: billLabel(b, p?.corrections ?? []) };
  };
  const originals = purchases.map((p) => p.original).filter((b) => !b.corrects_bill_id && Math.round((Number(b.amount) || 0) * 100) > 0);

  const reverses = creditMemoReverses(memo.item);
  if (reverses) {
    const hits = billsCarryingNumber(reverses, { supplier: vendor }, theirs, aliases).filter((b) => originals.some((o) => o.id === b.id));
    if (hits.length === 1) return { ok: true, kind: "one", by: "number", candidate: label(hits[0]) };
  }
  const lines = await readLines(c, originals.map((b) => b.id));
  if ("error" in lines) return { ok: false, error: lines.error };
  const best = bestHomes(memo.lines, originals.map((b) => ({ bill: b, lines: lines.get(b.id) ?? [] })));
  if (best.length === 1) return { ok: true, kind: "one", by: "words", candidate: label(best[0]) };
  if (best.length > 1) return { ok: true, kind: "several", candidates: best.map(label) };
  // A READ CUT AT ITS CAP IS SAID (skeptic #84, M6): an older purchase may be past it, so "none"
  // would be a guess; the sentence says the search was cut and names the way on.
  if ((rows ?? []).length >= BILLS_READ_CAP) return { ok: true, kind: "none", sentence: CUT_SENTENCE };
  return { ok: true, kind: "none", sentence: creditMemoNoneSentence(vendor) };
}

/**
 * WHAT ELSE THE DRAFT'S REFRESH DID (skeptic #84, M4). Import Costs brings every new cost on the job
 * onto the draft, not only this bill, so the sentence says that from the import's own count, or that
 * it brought in none; with no count back it says to look before sending.
 */
function refreshBroughtIn(stats: { pulled_in?: number; stock_pulled_in?: number } | undefined): string {
  if (!stats) return ", and it may have brought in other new costs on the job: look it over before you send it";
  const n = (Number(stats.pulled_in) || 0) + (Number(stats.stock_pulled_in) || 0);
  if (n === 0) return ", and it brought in no other new costs";
  return `, and it brought in ${n} other new ${n === 1 ? "cost" : "costs"} from the job`;
}

/** One closing write, read back: the line must still be in the state the pairing read. */
async function closeLine(c: Ctx, billId: string, p: Pairing, creditId: string, halfOrder: number | undefined): Promise<boolean> {
  if (p.kind === "closeReturned") {
    const { data, error } = await c.supabase
      .from("bill_line_items")
      .update({ returned_credit_bill_id: creditId })
      .eq("org_id", c.orgId)
      .eq("bill_id", billId)
      .eq("id", p.line.id)
      .eq("returned", true)
      .is("returned_credit_bill_id", null)
      .select("id");
    return !error && (data ?? []).length === 1;
  }
  if (p.kind === "closeWhole") {
    const { data, error } = await c.supabase
      .from("bill_line_items")
      .update({ returned: true, billable: false, returned_credit_bill_id: creditId })
      .eq("org_id", c.orgId)
      .eq("bill_id", billId)
      .eq("id", p.line.id)
      .eq("billable", true)
      .eq("returned", false)
      .is("returned_credit_bill_id", null)
      .is("billed_amount", null)
      .select("id");
    return !error && (data ?? []).length === 1;
  }
  if (p.kind !== "split" || halfOrder === undefined) return false;
  // THE KEPT HALF FIRST, then the returned half right after it. If the returned half does not land,
  // the kept half goes back to the line it was, so the bill never adds up to less than its paper.
  const { data: kept, error: keptErr } = await c.supabase
    .from("bill_line_items")
    .update({ quantity: p.kept.quantity, amount: p.kept.amount })
    .eq("org_id", c.orgId)
    .eq("bill_id", billId)
    .eq("id", p.line.id)
    // THE QUANTITY AND AMOUNT THE PAIRING READ (skeptic #86, S3): a line somebody else split a moment
    // ago (another tab, another credit) is not split again.
    .eq("quantity", p.line.quantity)
    .eq("amount", p.line.amount)
    .eq("billable", true)
    .eq("returned", false)
    .is("returned_credit_bill_id", null)
    .is("billed_amount", null)
    .select("id");
  if (keptErr || (kept ?? []).length !== 1) return false;
  const { data: half, error: halfErr } = await c.supabase
    .from("bill_line_items")
    .insert({
      org_id: c.orgId,
      bill_id: billId,
      description: String(p.line.description ?? ""),
      quantity: p.back.quantity,
      unit_price: Number(p.line.unit_price) || 0,
      amount: p.back.amount,
      category: p.line.category ?? null,
      billable: false,
      returned: true,
      returned_credit_bill_id: creditId,
      sort_order: halfOrder,
    })
    .select("id");
  if (!halfErr && (half ?? []).length === 1) return true;
  reportError("organize.creditMemo.split", halfErr ?? new Error("returned half wrote no row"), { billId, lineId: p.line.id });
  const { data: back } = await c.supabase
    .from("bill_line_items")
    .update({ quantity: Number(p.line.quantity), amount: Number(p.line.amount) })
    .eq("org_id", c.orgId)
    .eq("bill_id", billId)
    .eq("id", p.line.id)
    .select("id");
  if (!(back ?? []).length) reportError("organize.creditMemo.splitUndo", new Error("kept half did not go back"), { billId, lineId: p.line.id });
  return false;
}

/**
 * FILE THE MEMO UNDER ITS BILL, THEN CLOSE WHAT IT RETURNS (M2). The correction door writes the
 * memo; the pure rule pairs its lines; each closing write is read back; a memo line whose bill line
 * did not close keeps crediting the customer as it would have, and the sentence says which.
 */
export async function fileCreditMemoWithItsBill(itemId: string, billId: string): Promise<Result> {
  const c = await staff();
  if ("error" in c) return { ok: false, error: c.error };
  const memo = await readMemo(c, itemId);
  if ("error" in memo) return { ok: false, error: memo.error };
  if (!memo.number) return { ok: false, error: `This credit memo has no number on it. Put its number in with Fix Details, then File With Its Bill. ${NOT_FILED}` };
  const id = String(billId ?? "").trim();
  if (!id) return { ok: false, error: "Couldn't tell which bill you meant." };

  const { data: billRow, error: billErr } = await c.supabase
    .from("bills")
    .select(`${BILL_COLUMNS}, po_id`)
    .eq("org_id", c.orgId)
    .eq("id", id)
    .maybeSingle();
  if (billErr) return { ok: false, error: `Couldn't read that bill just now: ${dbError(billErr)} ${NOT_FILED}` };
  if (!billRow) return { ok: false, error: `That bill isn't here any more. Reload the page. ${NOT_FILED}` };
  const bill = asLedger(billRow) as LedgerBill & { po_id?: string | null };
  const aliases = await readAliases(c);
  if ("error" in aliases) return { ok: false, error: aliases.error };
  const vendor = String(memo.item.vendor ?? "").trim();
  if (!sameSupplier({ name: vendor, account: null }, { name: bill.supplier, account: bill.supplier_account_id ?? null }, aliases)) {
    return { ok: false, error: `${numberLabel(bill.bill_number)} isn't from ${vendor || "this memo's supplier"}, so the memo can't reverse it. ${NOT_FILED}` };
  }
  const { data: underRows, error: underErr } = await c.supabase.from("bills").select("id, bill_number, amount").eq("org_id", c.orgId).eq("corrects_bill_id", bill.id).limit(50);
  if (underErr) return { ok: false, error: `Couldn't read what is already filed under that bill: ${dbError(underErr)} ${NOT_FILED}` };
  const linesBy = await readLines(c, [bill.id]);
  if ("error" in linesBy) return { ok: false, error: linesBy.error };
  const lines = linesBy.get(bill.id) ?? [];
  const claimed = await readBillClaimants(c.supabase, bill.id, bill.po_id ?? null);
  if ("error" in claimed) return { ok: false, error: `Couldn't check which invoices already bill that purchase: ${claimed.error} ${NOT_FILED}` };
  const claims = claimed.rows;
  const sent = claims.filter((x) => x.status !== "draft");

  const pairs = pairCreditMemo(memo.lines, lines, { invoiced: sent.length > 0 });
  const where = numberLabel(bill.bill_number);
  const lost = pairs.filter((p) => p.kind === "unmatched" || (p.kind === "tax" && !p.line));
  if (lost.length) {
    const words = lost.map((p) => String(memo.lines[p.memoIndex]?.description ?? "").trim() || "a line").join("; ");
    return { ok: false, error: `${words} ${lost.length === 1 ? "isn't a line" : "aren't lines"} on ${where}, so the memo wasn't filed there. Fix Details can still file it on a job, as before.` };
  }
  const gap = memoGapCents(memo.total, memo.lines);
  if (gap !== 0) {
    return {
      ok: false,
      error: `The memo's lines come to ${formatCurrency(Math.abs(memo.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)))} and its total is ${formatCurrency(Math.abs(memo.total))}, so it wasn't filed. Press Read Again for a clearer read; Fix Details can still file it on a job, as before.`,
    };
  }

  // THE CORRECTION DOOR'S OWN WRITE: the memo becomes a bill UNDER the purchase (0381).
  const input = correctionInput(memo.lines, pairs);
  const together = (purchaseCents({ amount: bill.amount ?? 0, corrections: ((underRows ?? []) as any[]).map((u) => ({ billNumber: u.bill_number ?? null, amount: u.amount })) }) + Math.round(memo.total * 100)) / 100;
  const filed = await correctBill({
    billId: bill.id,
    paperNumber: memo.number,
    paperTotal: together,
    billDate: memo.item.item_date ?? null,
    notes: "Credit memo, filed with its bill from the tray.",
    lines: input.lines,
  });
  if (!filed.ok || !filed.id) return { ok: false, error: filed.error ?? `The memo didn't file. ${NOT_FILED}` };
  const creditId = String(filed.id);

  // CLOSE WHAT IT RETURNS, each write read back.
  const splits = pairs.filter((p): p is Extract<Pairing, { kind: "split" }> => p.kind === "split");
  const order = orderAfterSplits(lines, splits.map((p) => p.line.id));
  for (const [lineId, sort] of order.moves) {
    const { data: moved, error: moveErr } = await c.supabase.from("bill_line_items").update({ sort_order: sort }).eq("org_id", c.orgId).eq("bill_id", bill.id).eq("id", lineId).select("id");
    if (moveErr || !(moved ?? []).length) reportError("organize.creditMemo.order", moveErr ?? new Error("line order wrote no row"), { billId: bill.id, lineId });
  }
  const notClosed: number[] = [];
  const closedAt = new Set<number>();
  for (const p of pairs) {
    if (!CLOSES.has(p.kind)) continue;
    const line = (p as { line: PurchaseLine }).line;
    if (await closeLine(c, bill.id, p, creditId, order.halves.get(line.id))) closedAt.add(p.memoIndex);
    else notClosed.push(p.memoIndex);
  }
  // THE MEMO'S OWN LINES: a line that closed credits nothing, and a fee is the company's own cost.
  const offFailed: string[] = [];
  for (const k of input.offBill) {
    const memoIndex = input.sortOf[k];
    const p = pairs.find((x) => x.memoIndex === memoIndex);
    if (!p || (p.kind !== "fee" && !closedAt.has(memoIndex))) continue;
    const { data: off, error: offErr } = await c.supabase
      .from("bill_line_items")
      .update({ billable: false })
      .eq("org_id", c.orgId)
      .eq("bill_id", creditId)
      .eq("sort_order", k)
      .select("id");
    if (offErr || (off ?? []).length !== 1) offFailed.push(String(memo.lines[memoIndex]?.description ?? "a line"));
  }
  let rollNote = "";
  if (closedAt.size) {
    const r = await restampLotsForBill(c.supabase, c.orgId, bill.id);
    if (!r.ok) rollNote = ` A roll in stock from ${where} couldn't be re-costed: ${r.error}`;
    else if (r.restamped > 0 || r.unshelved > 0) rollNote = ` The roll in stock from ${where} was re-costed to match.`;
  }

  // THE TRAY ROW IS FILED THE WAY FILE IT FILES ONE: its bill, its job, how (so Undo takes it down).
  const { data: wrote, error: rowErr } = await c.supabase
    .from("organized_items")
    .update({
      status: "filed",
      bill_id: creditId,
      job_id: bill.job_id ?? null,
      proposal: { ...proposalOf(memo.item), billDeleted: null, filed: { how: "bill" } } satisfies PaperProposal,
    })
    .eq("org_id", c.orgId)
    .eq("id", memo.item.id)
    .eq("status", "needs_review")
    .select("id");
  const rowNote =
    rowErr || !(wrote ?? []).length
      ? ` The memo is filed under ${where}, but its card in the tray didn't update; reload, and Set Aside the card so it isn't filed twice.`
      : "";

  // A DRAFT THAT LISTS A LINE THAT JUST CLOSED is brought up to date the way a receipt's change
  // brings one (Import Costs, keeping the draft's own markup); a line changed by hand never follows.
  const drafts = Array.from(new Map(claims.filter((x) => x.status === "draft").map((x) => [x.invoiceId, x])).values());
  const draftNotes: string[] = [];
  if (closedAt.size) {
    for (const d of drafts) {
      if (claims.some((x) => x.invoiceId === d.invoiceId && x.edited)) {
        draftNotes.push(` ${d.number} (a draft) has a line from ${where} changed by hand, which doesn't follow the bill: use Start It Over for Materials on ${d.number} before you send it.`);
        continue;
      }
      const up = await importCostsIntoInvoice(d.invoiceId, undefined, { keepInvoiceMarkup: true });
      if (up.ok) draftNotes.push(` ${d.number} (a draft) now leaves the returned goods off${refreshBroughtIn(up.stats)}.`);
      else draftNotes.push(` ${d.number} (a draft) still lists the returned goods: press ${BRING_IN_NEW_WORK} on ${d.number} before you send it.`);
    }
  }

  revalidatePath("/organize");
  revalidatePath("/bills");
  if (bill.job_id) revalidatePath(`/jobs/${bill.job_id}`);
  const said = creditMemoSentence({ memoNumber: memo.number, billWords: where, memoTotal: memo.total, memo: memo.lines, pairs, notClosed });
  const failedSaid = notClosed.length
    ? ` ${notClosed.map((i) => String(memo.lines[i]?.description ?? "a line")).join("; ")} changed on the bill just now, so ${notClosed.length === 1 ? "it was" : "they were"} not closed.`
    : "";
  const offSaid = offFailed.length ? ` ${offFailed.join("; ")} on the memo couldn't be taken off the customer's bill; switch ${offFailed.length === 1 ? "it" : "them"} to Not Billed on ${memo.number}.` : "";
  return { ok: true, message: `${said}${failedSaid}${offSaid}${rollNote}${draftNotes.join("")}${rowNote}` };
}

// ── FILE WITH ITS BILL ON A CREDIT ALREADY ON A JOB (cn-v1184) ───────────────────────────────────

/**
 * WHY (the owner, 2026-11-22: "i thought the returned item problem was resolved already but im still
 * getting this as an invoice"). His credit came in from the JOB PAGE (Record as Cost on a credit), a
 * bill of its own below zero on the job, so it never reached the pairing rule and every draft listed
 * the purchase and then the return. And a supplier's return slip often covers goods from SEVERAL
 * invoices on one job, so this door never attaches the credit under one bill (`corrects_bill_id` is
 * not written; no `bills` row is written at all): the credit stays a bill of its own on the job, and
 * what it returns is CLOSED on whichever of the job's bills carry those lines
 * (lib/credit-memo-close pairCreditAcrossBills). The tray door's two functions above are untouched.
 */
const NOTHING_CHANGED = "Nothing changed.";

type CreditOnJob = {
  bill: LedgerBill & { po_id?: string | null };
  /** Its lines still in play (a part line already off the customer's bill is done), in their order. */
  lines: PurchaseLine[];
  memoLines: MemoLine[];
  /** EVERY line of the credit, on the bill or off (its tax share is its own proportion of all of them). */
  allLines: PurchaseLine[];
  allMemo: MemoLine[];
  words: string;
  total: number;
  claims: BillClaimant[];
  /** Every part line (not tax, below zero) is already off the customer's bill. */
  allOff: boolean;
};

const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);
const isPartLine = (l: { amount?: unknown; category?: string | null; description?: string | null }) => !isTaxish(l) && cents(l.amount) < 0;

/** THE CREDIT, asked by both doors before anything changes. Each refusal is one sentence; no write. */
async function readCreditOnJob(c: Ctx, creditBillId: string): Promise<CreditOnJob | Fail> {
  const id = String(creditBillId ?? "").trim();
  if (!id) return { error: "Couldn't tell which bill you meant." };
  const { data: row, error } = await c.supabase.from("bills").select(`${BILL_COLUMNS}, po_id`).eq("org_id", c.orgId).eq("id", id).maybeSingle();
  if (error) return { error: `Couldn't read that credit just now: ${dbError(error)} ${NOTHING_CHANGED}` };
  if (!row) return { error: `That bill isn't here any more. Reload the page. ${NOTHING_CHANGED}` };
  const bill = asLedger(row) as CreditOnJob["bill"];
  const total = Number(bill.amount);
  if (!Number.isFinite(total) || cents(total) >= 0) return { error: `This bill isn't a credit, so it has nothing to file with another bill. ${NOTHING_CHANGED}` };
  // A credit on no job has no customer invoice to keep clean; one on the shop shelf is tied elsewhere.
  if (!bill.job_id) return { error: `This credit isn't on a job, so there's no customer invoice for it to keep clean. ${NOTHING_CHANGED}` };
  if (bill.corrects_bill_id) return { error: `This credit is filed under another bill already, so this door leaves it as it is. ${NOTHING_CHANGED}` };
  if (bill.superseded_by_bill_id) return { error: `This credit was set aside as a duplicate, so it isn't filed anywhere. ${NOTHING_CHANGED}` };
  const { data: under, error: underErr } = await c.supabase.from("bills").select("id").eq("org_id", c.orgId).eq("corrects_bill_id", bill.id).limit(1);
  if (underErr) return { error: `Couldn't read what is filed under this credit: ${dbError(underErr)} ${NOTHING_CHANGED}` };
  if ((under ?? []).length) return { error: `A correction is filed under this credit, so this door leaves it as it is. ${NOTHING_CHANGED}` };
  const linesBy = await readLines(c, [bill.id]);
  if ("error" in linesBy) return { error: linesBy.error };
  const all = [...(linesBy.get(bill.id) ?? [])].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) || String(a.id).localeCompare(String(b.id)));
  if (!all.length) return { error: `This credit has no lines, so it can't close anything on its bills. Give it its lines with Edit. ${NOTHING_CHANGED}` };
  const asMemo = (l: PurchaseLine): MemoLine => ({ description: l.description ?? null, quantity: l.quantity, amount: l.amount, category: l.category ?? null });
  if (memoGapCents(total, all.map(asMemo)) !== 0) {
    const sum = all.reduce((s, l) => s + cents(l.amount), 0) / 100;
    return { error: `This credit's lines come to ${formatCurrency(Math.abs(sum))} and its total is ${formatCurrency(Math.abs(total))}. Give it its lines with Edit so they match. ${NOTHING_CHANGED}` };
  }
  const claimed = await readBillClaimants(c.supabase, bill.id, bill.po_id ?? null);
  if ("error" in claimed) return { error: `Couldn't check which invoices already hold this credit: ${claimed.error} ${NOTHING_CHANGED}` };
  const sent = claimed.rows.find((x) => x.status !== "draft");
  if (sent) return { error: `${sent.number} already credited this return to the customer, so it stays as it is. ${NOTHING_CHANGED}` };
  // A part line already off the customer's bill is done: a second press never pairs it again.
  const lines = all.filter((l) => !(isPartLine(l) && l.billable === false));
  const allOff = !all.some((l) => isPartLine(l) && l.billable !== false);
  const words = String(bill.bill_number ?? "").trim() || String(bill.supplier_invoice_number ?? "").trim() || "The credit";
  return { bill, lines, memoLines: lines.map(asMemo), allLines: all, allMemo: all.map(asMemo), words, total, claims: claimed.rows, allOff };
}

type JobBill = ReturnBill & { bill: LedgerBill; claims: BillClaimant[]; words: string };

/**
 * THE CREDIT'S BILLS: the same supplier's live purchases ON THE CREDIT'S JOB (supplier told the one
 * way: name and account of both bills, through the alias index), each with its lines and whether an
 * invoice that went out holds it. A failed read is said, never "no bill".
 */
async function readJobBills(c: Ctx, credit: CreditOnJob): Promise<JobBill[] | Fail> {
  const aliases = await readAliases(c);
  if ("error" in aliases) return { error: aliases.error };
  const { data: rows, error } = await c.supabase
    .from("bills")
    .select(`${BILL_COLUMNS}, po_id`)
    .eq("org_id", c.orgId)
    .eq("job_id", credit.bill.job_id)
    .is("superseded_by_bill_id", null)
    .is("corrects_bill_id", null)
    .order("created_at", { ascending: false })
    .limit(BILLS_READ_CAP);
  if (error) return { error: `Couldn't read this job's bills just now: ${dbError(error)} ${NOTHING_CHANGED}` };
  const theirs = ((rows ?? []) as any[])
    .map(asLedger)
    .filter((b) => b.id !== credit.bill.id && b.job_id === credit.bill.job_id && !b.corrects_bill_id && !b.superseded_by_bill_id && cents(b.amount) > 0)
    .filter((b) => sameSupplier({ name: credit.bill.supplier, account: credit.bill.supplier_account_id ?? null }, { name: b.supplier, account: b.supplier_account_id ?? null }, aliases));
  const lines = await readLines(c, theirs.map((b) => b.id));
  if ("error" in lines) return { error: lines.error };
  const out: JobBill[] = [];
  for (const b of theirs) {
    const claimed = await readBillClaimants(c.supabase, b.id, (b as { po_id?: string | null }).po_id ?? null);
    if ("error" in claimed) return { error: `Couldn't check which invoices already bill ${numberLabel(b.bill_number)}: ${claimed.error} ${NOTHING_CHANGED}` };
    out.push({
      id: b.id,
      bill_date: b.bill_date ?? null,
      invoiced: claimed.rows.some((x) => x.status !== "draft"),
      lines: lines.get(b.id) ?? [],
      bill: b,
      claims: claimed.rows,
      words: numberLabel(b.bill_number || b.supplier_invoice_number),
    });
  }
  return out;
}

type Closing = Extract<BillPairing, { kind: "closeReturned" | "closeWhole" | "split" }>;
type Before = Extract<BillPairing, { kind: "closedBefore" }>;
type Plan = { credit: CreditOnJob; bills: JobBill[]; pairs: BillPairing[]; closing: Closing[]; before: Before[] };

/**
 * WHY NOTHING WOULD CLOSE (skeptic #86, S4), from the pairs' own reasons: a line an invoice that went
 * out already billed stays the customer's credit (named when the claim read has its number); a line no
 * bill carries is today's sentence. Both kinds left: both sentences.
 */
function noneSentence(credit: CreditOnJob, bills: JobBill[], pairs: BillPairing[]): string {
  const supplier = String(credit.bill.supplier ?? "").trim() || "this supplier";
  const today = `No bill from ${supplier} on this job carries the lines this credit returns, so nothing was closed. It stays a credit on the job, as before.`;
  const stays = pairs.filter((p): p is Extract<BillPairing, { kind: "stays" }> => p.kind === "stays");
  const invoiced = stays.filter((p) => p.why === "invoiced");
  if (!invoiced.length) return today;
  const numbers = new Set<string>();
  for (const p of invoiced) {
    const words = lineWords(credit.memoLines[p.memoIndex]?.description);
    for (const b of bills) {
      if (!b.invoiced || !b.lines.some((l) => !isTaxish(l) && sameItemWords(words, lineWords(l.description)))) continue;
      for (const x of b.claims) if (x.status !== "draft" && String(x.number ?? "").trim()) numbers.add(String(x.number).trim());
    }
  }
  const named = numbers.size ? `An invoice that went out, ${andList(Array.from(numbers))}, already billed` : "An invoice that went out already billed";
  const said = `${named} what this credit returns, so it stays a credit to the customer, as before. ${NOTHING_CHANGED}`;
  return stays.length > invoiced.length ? `${said} ${today}` : said;
}

/** Both doors' reading: the credit, its job's bills, the pairing, the tax. `none` carries the sentence. */
async function planReturn(c: Ctx, creditBillId: string): Promise<Plan | Fail | { none: string }> {
  const credit = await readCreditOnJob(c, creditBillId);
  if ("error" in credit) return credit;
  if (credit.allOff) return { none: ALREADY_FILED };
  const bills = await readJobBills(c, credit);
  if ("error" in bills) return bills;
  const pairs = pairCreditAcrossBills(credit.memoLines, bills, { creditId: credit.bill.id });
  const closing = pairs.filter((p): p is Closing => CLOSES.has(p.kind as Pairing["kind"]));
  const before = pairs.filter((p): p is Before => p.kind === "closedBefore");
  if (!closing.length && !before.length) return { none: noneSentence(credit, bills, pairs) };
  // FILING NEVER CHANGES WHAT THE CUSTOMER PAYS IN TAX (skeptic #86, S1 + S13): checked before any write.
  const tax = returnTaxCheck({ credit: credit.allMemo, memo: credit.memoLines, pairs, bills });
  if (tax.checked && !tax.ok) {
    const where = andList(tax.billIds.map((id) => bills.find((b) => b.id === id)?.words ?? "that bill"));
    return {
      error: `The tax on this credit (${formatCurrency(tax.creditTaxCents / 100)}) is not the tax its lines carry on ${where} (${formatCurrency(tax.billsTaxCents / 100)}), so filing it would change what the customer pays. It stays a credit on the job, as before. ${NOTHING_CHANGED}`,
    };
  }
  return { credit, bills, pairs, closing, before };
}

const billsSaid = (plan: Plan, ids: Iterable<string>) => andList(Array.from(new Set(ids)).map((id) => plan.bills.find((b) => b.id === id)?.words ?? "that bill"));

/**
 * WHAT THIS CREDIT WOULD CLOSE, AND WHERE. Found by words always: the door names it on ONE button
 * ("4 lines on T-543, T-576 and T-677") and files only on that tap. The candidate is the credit itself.
 */
export async function returnBillHome(creditBillId: string): Promise<CreditMemoHomeResult> {
  const c = await staff();
  if ("error" in c) return { ok: false, error: c.error };
  const plan = await planReturn(c, creditBillId);
  if ("error" in plan) return { ok: false, error: plan.error };
  if ("none" in plan) return { ok: true, kind: "none", sentence: plan.none };
  // A line this credit already closed counts in what it found (S2): a second press repairs it.
  const found = [...plan.closing, ...plan.before];
  const n = found.length;
  return {
    ok: true,
    kind: "one",
    by: "words",
    candidate: { billId: plan.credit.bill.id, label: `${n} ${n === 1 ? "line" : "lines"} on ${billsSaid(plan, found.map((p) => p.billId))}` },
  };
}

/**
 * FILE A CREDIT ON A JOB WITH ITS BILLS: every check and the pairing again (the client is never
 * trusted), then per bill closed on: the line order after its splits, each closing write read back;
 * the credit's own lines whose pair closed, or that are a fee, off the customer's bill BY LINE ID; the
 * roll in stock re-costed per bill; every draft holding a row of the credit or of a bill closed on
 * brought up to date ONCE. A closing write that fails is said and its credit line keeps crediting;
 * nothing is rolled back. No `bills` row is written.
 */
export async function fileReturnBillWithItsBill(creditBillId: string): Promise<Result> {
  const c = await staff();
  if ("error" in c) return { ok: false, error: c.error };
  const plan = await planReturn(c, creditBillId);
  if ("error" in plan) return { ok: false, error: plan.error };
  if ("none" in plan) return { ok: false, error: plan.none };
  const { credit, pairs, closing } = plan;
  const creditId = credit.bill.id;

  // ONE ANSWER TO "IS IT TAX" (skeptic #86, S6): a line of the credit that is tax by its words but not
  // by its category is written category Tax first, by id and read back, so the invoice builder (which
  // asks the category) and this door agree and the tax is never credited twice. A write that fails
  // stops the filing before anything else is written.
  let wroteAny = false;
  for (const l of credit.allLines) {
    if (!isTaxish(l) || /tax/i.test(String(l.category ?? ""))) continue;
    const { data: taxed, error: taxErr } = await c.supabase
      .from("bill_line_items")
      .update({ category: "Tax" })
      .eq("org_id", c.orgId)
      .eq("bill_id", creditId)
      .eq("id", l.id)
      .select("id");
    if (taxErr || (taxed ?? []).length !== 1) {
      const why = taxErr ? `: ${dbError(taxErr)}` : "";
      return { ok: false, error: `${String(l.description ?? "").trim() || "Its tax line"} on the credit couldn't be marked as tax just now${why}. ${wroteAny ? "Nothing else changed." : NOTHING_CHANGED}` };
    }
    wroteAny = true;
  }

  const notClosed: number[] = [];
  const closedAt = new Set<number>();
  const closedOn = new Set<string>();
  for (const b of plan.bills) {
    const mine = closing.filter((p) => p.billId === b.id);
    if (!mine.length) continue;
    const order = orderAfterSplits(b.lines, mine.filter((p) => p.kind === "split").map((p) => p.line.id));
    for (const [lineId, sort] of order.moves) {
      const { data: moved, error: moveErr } = await c.supabase.from("bill_line_items").update({ sort_order: sort }).eq("org_id", c.orgId).eq("bill_id", b.id).eq("id", lineId).select("id");
      if (moveErr || !(moved ?? []).length) reportError("organize.returnBill.order", moveErr ?? new Error("line order wrote no row"), { billId: b.id, lineId });
    }
    for (const p of mine) {
      if (await closeLine(c, b.id, p as unknown as Pairing, creditId, order.halves.get(p.line.id))) {
        closedAt.add(p.memoIndex);
        closedOn.add(b.id);
      } else notClosed.push(p.memoIndex);
    }
  }
  // THE CREDIT'S OWN LINES, by line id: a line that closed credits nothing; a fee is the company's own;
  // a line this credit had already closed comes off again (S2).
  const offFailed: string[] = [];
  let beforeOff = 0;
  for (const p of pairs) {
    if (p.kind !== "fee" && p.kind !== "closedBefore" && !closedAt.has(p.memoIndex)) continue;
    const line = credit.lines[p.memoIndex];
    if (p.kind === "fee" && line.billable === false) continue;
    const { data: off, error: offErr } = await c.supabase
      .from("bill_line_items")
      .update({ billable: false })
      .eq("org_id", c.orgId)
      .eq("bill_id", creditId)
      .eq("id", line.id)
      .select("id");
    if (offErr || (off ?? []).length !== 1) offFailed.push(String(line.description ?? "a line"));
    else {
      wroteAny = true;
      if (p.kind === "closedBefore") beforeOff += 1;
    }
  }
  if (closedAt.size) wroteAny = true;
  const rollNotes: string[] = [];
  for (const id of closedOn) {
    const where = plan.bills.find((b) => b.id === id)?.words ?? "that bill";
    const r = await restampLotsForBill(c.supabase, c.orgId, id);
    if (!r.ok) rollNotes.push(` A roll in stock from ${where} couldn't be re-costed: ${r.error}`);
    else if (r.restamped > 0 || r.unshelved > 0) rollNotes.push(` The roll in stock from ${where} was re-costed to match.`);
  }

  // EVERY DRAFT holding a row of the credit or of a bill closed on, ONCE; a hand-edited line never follows.
  // Brought up to date when ANYTHING was written (S8): a close, a credit line taken off, a fee among them.
  const draftNotes: string[] = [];
  if (wroteAny) {
    const claims = [...credit.claims, ...plan.bills.filter((b) => closedOn.has(b.id)).flatMap((b) => b.claims)];
    const drafts = Array.from(new Map(claims.filter((x) => x.status === "draft").map((x) => [x.invoiceId, x])).values());
    for (const d of drafts) {
      if (claims.some((x) => x.invoiceId === d.invoiceId && x.edited)) {
        draftNotes.push(` ${d.number} (a draft) has a line changed by hand, which doesn't follow the bills: use Start It Over for Materials on ${d.number} before you send it.`);
        continue;
      }
      const up = await importCostsIntoInvoice(d.invoiceId, undefined, { keepInvoiceMarkup: true });
      if (up.ok) draftNotes.push(` ${d.number} (a draft) now leaves the returned goods off${refreshBroughtIn(up.stats)}.`);
      else draftNotes.push(` ${d.number} (a draft) still lists the returned goods: press ${BRING_IN_NEW_WORK} on ${d.number} before you send it.`);
    }
  }

  revalidatePath("/organize");
  revalidatePath("/bills");
  revalidatePath(`/jobs/${credit.bill.job_id}`);
  const said = creditAcrossBillsSentence({
    creditWords: credit.words,
    creditTotal: credit.total,
    memo: credit.memoLines,
    pairs,
    billWords: new Map(plan.bills.map((b) => [b.id, b.words])),
    notClosed,
  });
  const offSaid = offFailed.length
    ? ` ${offFailed.join("; ")} on the credit couldn't be taken off the customer's bill; switch ${offFailed.length === 1 ? "it" : "them"} to Not Billed on ${credit.words === "The credit" ? "the credit" : credit.words}.`
    : "";
  const beforeSaid = beforeOff ? ` ${beforeOff} ${beforeOff === 1 ? "line" : "lines"} this credit had already closed: off the customer's bill now.` : "";
  return { ok: true, message: `${said}${beforeSaid}${offSaid}${rollNotes.join("")}${draftNotes.join("")}` };
}
