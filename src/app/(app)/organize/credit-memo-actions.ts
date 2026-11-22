"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { cleanLines } from "@/lib/paper-lines";
import { creditMemoNoneSentence, creditMemoReverses, isWaitingCreditMemo, linesPointWithTotal, proposalOf, type PaperProposal } from "@/lib/paperwork";
import { billLabel, billsCarryingNumber, purchasesOf, sameSupplier, type LedgerBill } from "@/lib/same-purchase";
import { indexSupplierAliases, type SupplierAliasIndex } from "@/lib/supplier-identity";
import { billLabel as numberLabel, purchaseCents } from "@/lib/bill-correction";
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
} from "@/lib/credit-memo-close";
import { readBillClaimants } from "@/lib/bill-claimants";
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
