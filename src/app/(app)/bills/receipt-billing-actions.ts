"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import { billLineCost } from "@/lib/bill-itemisation";
import { formatCurrency } from "@/lib/utils";
import { putOnShelf, restampLotsForBill, unshelveLot, type ShelfPick } from "@/lib/stock-ledger";
import { isMissingShelf } from "@/lib/job-cost";
import { importCostsIntoInvoice } from "@/app/(app)/billing/actions";
import { BRING_IN_NEW_WORK } from "@/lib/actuals-draw";
import { creditExpectedOf, penMarkOf } from "@/lib/pen-marks";
import { alreadyBilledSentence, readBillClaimants, sentClaimant } from "@/lib/bill-claimants";
import { decideReceiptLine, round2, splitContradictsReceipt } from "./receipt-billing";

export type Result = { ok: boolean; error?: string; note?: string };

/**
 * EVERY BILL-LINE WRITE PATH CALLS THIS AFTER IT WRITES (Shop Stock; 0304's other half). A roll on
 * the shelf is costed off its ticket's lines, and switching or splitting ANY line moves the tax
 * share, so every take-less roll from the ticket is worked out again here, and one whose line is
 * now billed in full comes off the shelf. With no roll on the ticket it is one small read. What it
 * did is SAID (nothing silent), and a failure is said too: 0304 already marked the roll stale, and
 * the reconcile view names it until it is put right.
 */
async function restampAfterLineWrite(supabase: any, orgId: string | null | undefined, billId: string | null | undefined): Promise<string | null> {
  if (!orgId || !billId) return null;
  const r = await restampLotsForBill(supabase, orgId, String(billId));
  if (!r.ok) return `The line saved, but the roll in stock from this ticket couldn't be re-costed: ${r.error}`;
  if (r.unshelved > 0)
    return `${r.unshelved === 1 ? "The roll" : `${r.unshelved} rolls`} from this ticket came out of stock, because the customer is billed all of it now. Its cost is back on the job.`;
  if (r.restamped > 0) return "The roll in stock from this ticket was re-costed to match.";
  return null;
}

/**
 * A ROLL ON THE SHELF FROM THIS LINE FIXES WHAT THE JOB USED (review of Phase 2). The roll holds the
 * pieces the job did NOT use, and a restamp can only move its dollars, never its pieces: switching
 * the line off the customer's bill, or typing a new "used" figure, would re-cost a 190 ft roll as the
 * whole 250 ft coil (or bill 60 ft while the shelf still holds 250). So while a roll sits on the line
 * these two doors refuse, and say the way through: take the roll off the shelf, then change it and
 * put the rest back. Bill the Whole Line (billed_amount null) still goes: it takes the roll off.
 * Null means no roll (or a database before 0303); a string is the refusal, or a failed read.
 */
async function liveRollOnLine(supabase: any, orgId: string | null | undefined, lineId: string): Promise<string | null> {
  let q = supabase.from("stock_lots").select("id").eq("bill_line_id", lineId).is("unshelved_at", null).limit(1);
  if (orgId) q = q.eq("org_id", orgId);
  const { data, error } = await q;
  if (error) return isMissingShelf(error) ? null : `Couldn't check stock for this line, so nothing was changed: ${dbError(error)}`;
  return data?.length ? ROLL_ON_LINE : null;
}

const ROLL_ON_LINE =
  "A roll from this line is in stock, and it holds the pieces this job didn't use. Take It Out of Stock first, change what this job used, then put the rest back in stock.";

/**
 * SWITCH ONE RECEIPT LINE OFF THE CUSTOMER'S BILL (migration 0268).
 *
 * This is the manual half of the Smartwater fix. The reader defaults food and drink to "not
 * billed" and everything else to billed; this is how Erik overrides either way, on the receipt,
 * before the importer ever turns it into an invoice line. A pair of gloves bought for one
 * homeowner's job is his to bill; a pair bought for the truck on the same receipt is not, and no
 * model will ever know which is which.
 *
 * NOTHING SILENT. `bill_line_items` is staff-only behind RLS, so a non-staff or cross-org caller
 * gets a zero-row UPDATE, and a zero-row UPDATE is a 204 that looks exactly like success. The
 * `.select("id")` is what turns that back into a refusal the screen can say out loud — the
 * silent-write law, the reason a screen must never be allowed to disagree with the database.
 */
export async function setReceiptLineBillable(lineId: string, billable: boolean): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  if (!lineId) return { ok: false, error: "Couldn't tell which receipt line you meant." };

  // The bill this line sits on, read through RLS: it gives the job page to revalidate, and it is a
  // second, independent statement that this row is visible to this org before anything is written.
  const { data: line } = await supabase
    .from("bill_line_items")
    .select("id, bill_id, bills(job_id, po_id)")
    .eq("id", lineId)
    .maybeSingle();
  if (!line) return { ok: false, error: "Couldn't find that receipt line. Reload the page and try again." };
  const rolled = await liveRollOnLine(supabase, ctx.orgId, lineId);
  if (rolled) return { ok: false, error: rolled };
  // A RETURNED LINE IS NOT SWITCHED BACK ON HERE (skeptic #84, M3): 0417 refuses a line that is both
  // returned and billed, and its check's words are not a person's. Kept is the way back. A database
  // before 0417 has no such line (the column is missing), so the switch goes on as it always did.
  if (billable) {
    const said = await returnedRefusal(supabase, ctx.orgId, lineId);
    if (said) return { ok: false, error: said };
  }
  const sent = await customerAlreadyBilled(supabase, line as LineOnBill);
  if (sent) return { ok: false, error: sent };

  // org_id rides on the WRITE as well as the read. RLS already scopes this table, but a rule at
  // one read path is a convention, not a boundary (0173) — money columns get the explicit filter.
  let write = supabase.from("bill_line_items").update({ billable: !!billable }).eq("id", lineId);
  if (ctx.orgId) write = write.eq("org_id", ctx.orgId);
  const { data, error } = await write.select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data || data.length === 0) {
    return { ok: false, error: "That line wasn't changed. Reload the page and try again." };
  }

  const jobId = (line as { bills?: { job_id?: string | null } | null }).bills?.job_id ?? null;
  const note = await restampAfterLineWrite(supabase, ctx.orgId, (line as { bill_id?: string | null }).bill_id);
  revalidatePath("/bills");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return note ? { ok: true, note } : { ok: true };
}

const CREDIT_FILED =
  "The supplier's credit for this line is already filed, so it stays returned. To change it, delete that credit memo's bill first.";

type LineOnBill = { bill_id?: string | null; bills?: { po_id?: string | null } | { po_id?: string | null }[] | null };

/**
 * A LINE THE CUSTOMER WAS ALREADY BILLED FOR IS NOT FLIPPED HERE (skeptic #84, S2), in both doors and
 * before any write. While an invoice that went to the customer bills this bill or the order it
 * delivered, the importer never reads the bill again, so a switch here moves no dollar the customer
 * holds; and a line marked returned would then be closed by the credit memo with nothing credited to
 * the customer. The card hides these doors on such a bill; this is the boundary for a stale page, a
 * second tab or a caller yet to come. Read the one way every door reads it (lib/bill-claimants); a
 * failed read refuses.
 */
async function customerAlreadyBilled(supabase: any, line: LineOnBill): Promise<string | null> {
  const billId = String(line.bill_id ?? "");
  const billRow = Array.isArray(line.bills) ? (line.bills[0] ?? null) : (line.bills ?? null);
  const claims = await readBillClaimants(supabase, billId, billRow?.po_id ?? null);
  if ("error" in claims) return `Couldn't check which invoices already bill this receipt, so nothing was changed: ${claims.error}`;
  const held = sentClaimant(claims.rows);
  return held ? alreadyBilledSentence(held.number, held.via === "po" ? "the order this receipt delivered" : "this receipt") : null;
}

const RETURNED_USE_KEPT = "This line went back to the supplier, so it can't be billed as it is. Press Kept on it if it was kept after all.";

/** The returned line's one sentence for the Bill switch, or null. A failed read refuses. */
async function returnedRefusal(supabase: any, orgId: string | null | undefined, lineId: string): Promise<string | null> {
  let q = supabase.from("bill_line_items").select("id, returned").eq("id", lineId);
  if (orgId) q = q.eq("org_id", orgId);
  const { data, error } = await q.maybeSingle();
  if (error) return (error as { code?: string }).code === "42703" ? null : `Couldn't read that line, so nothing was changed: ${dbError(error)}`;
  return data?.returned === true ? RETURNED_USE_KEPT : null;
}

/**
 * KEPT OR RETURNED: A PERSON'S ANSWER ON A BILL'S LINE (cn-v1181, lib/pen-marks; 0417).
 *
 * The reader marks a line it saw crossed out by hand, a quantity written over, or a mark it could not
 * be sure of (`unclear`, held off the customer's bill and asked). This is the one door that answers it
 * or changes the answer, beside setReceiptLineBillable and with that door's guards: staff only, a
 * roll in stock on the line refuses, `org_id` on the write, read back, the rolls re-costed, the pages
 * revalidated.
 *
 * RETURNED: off the customer's bill (`billable` false, `billed_amount` cleared) and, where the
 * supplier owes a credit for it (creditExpectedOf: the paper's tender when there is a paper, else the
 * bill), `returned` true until a credit memo closes it. An `unclear` mark becomes `struck`.
 * KEPT: `returned` false, an `unclear` mark is cleared, and `billable` goes back to what the line
 * would be with nothing stored (decideReceiptLine: a snack stays off).
 * A line whose credit is already filed (`returned_credit_bill_id`) is never changed here.
 */
export async function setReceiptLineReturned(lineId: string, returned: boolean): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!lineId) return { ok: false, error: "Couldn't tell which receipt line you meant." };

  let lineRead = supabase
    .from("bill_line_items")
    .select("id, bill_id, description, category, billable, pen_mark, returned, returned_credit_bill_id")
    .eq("id", lineId);
  if (ctx.orgId) lineRead = lineRead.eq("org_id", ctx.orgId);
  const { data: line, error: lineErr } = await lineRead.maybeSingle();
  if (lineErr) return { ok: false, error: `Couldn't read that line, so nothing was changed: ${dbError(lineErr)}` };
  if (!line) return { ok: false, error: "Couldn't find that receipt line. Reload the page and try again." };
  if (line.returned_credit_bill_id) return { ok: false, error: CREDIT_FILED };
  const rolled = await liveRollOnLine(supabase, ctx.orgId, lineId);
  if (rolled) return { ok: false, error: rolled };

  // IS A CREDIT TRACKED: the paper this bill was made from says how it was paid; with no paper, the
  // bill says. A failed read refuses: guessing would track a credit nobody owes, or lose one.
  let billRead = supabase.from("bills").select("id, job_id, po_id, status, supplier_account_id").eq("id", String(line.bill_id ?? ""));
  if (ctx.orgId) billRead = billRead.eq("org_id", ctx.orgId);
  const { data: bill, error: billErr } = await billRead.maybeSingle();
  if (billErr) return { ok: false, error: `Couldn't read the bill this line is on, so nothing was changed: ${dbError(billErr)}` };
  if (!bill) return { ok: false, error: "Couldn't find the bill this line is on. Reload the page and try again." };
  const sent = await customerAlreadyBilled(supabase, { bill_id: String(bill.id), bills: { po_id: bill.po_id ?? null } });
  if (sent) return { ok: false, error: sent };
  let paperRead = supabase.from("organized_items").select("id, payment").eq("bill_id", String(bill.id));
  if (ctx.orgId) paperRead = paperRead.eq("org_id", ctx.orgId);
  const { data: papers, error: paperErr } = await paperRead.limit(1);
  if (paperErr) return { ok: false, error: `Couldn't read the paper this bill came from, so nothing was changed: ${dbError(paperErr)}` };
  const creditExpected = creditExpectedOf({
    paperPayment: (papers as { payment?: string | null }[] | null)?.[0]?.payment ?? null,
    billStatus: bill.status ?? null,
    hasSupplierAccount: !!bill.supplier_account_id,
  });

  const pen = penMarkOf(line.pen_mark);
  const patch = returned
    ? { returned: creditExpected, billable: false, billed_amount: null, pen_mark: pen === "unclear" ? "struck" : pen }
    : {
        returned: false,
        pen_mark: pen === "unclear" ? null : pen,
        billable: decideReceiptLine(line.description, line.category, undefined).billable,
      };

  // The filter repeats the refusal above at the write: a credit filed between the read and this
  // write leaves the line as it is, and the zero rows are said.
  let write = supabase.from("bill_line_items").update(patch).eq("id", lineId).is("returned_credit_bill_id", null);
  if (ctx.orgId) write = write.eq("org_id", ctx.orgId);
  const { data, error } = await write.select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data || data.length === 0) return { ok: false, error: "That line wasn't changed. Reload the page and try again." };

  const note = await restampAfterLineWrite(supabase, ctx.orgId, String(line.bill_id ?? ""));
  revalidatePath("/bills");
  if (bill.job_id) revalidatePath(`/jobs/${bill.job_id}`);
  return note ? { ok: true, note } : { ok: true };
}

/**
 * BILL ONLY WHAT THIS JOB USED OUT OF A CONTAINER (Erik, 2026-09-19; migration 0272).
 *
 * Reading his own invoice he stopped on a line:
 *
 *   "the Twister box i was confused about and i remebered that is a whole ccontainer of wire nuts
 *    that we uses some of but is certainly stock and shouldnt be charged to the customer in full
 *    however necessary for the job"
 *
 * A 500 count box of IDEAL Twisters, $108.36, 21.7 cents each, and his customer was billed $135.00
 * for the box. The boolean from 0268 had no answer for that line: billed meant the whole box, not
 * billed meant he ate a cost the job really did incur. He fixed it by hand - sixty nuts at
 * twenty-seven cents typed onto the invoice, and the jar of anti-oxidant deleted outright - which
 * is rewriting his own books to get past his own app.
 *
 * This writes ONE column, `billed_amount`, in dollars. The count he used and the count in the box
 * are how he got to the dollars; the dollars are what is stored, because that is what the invoice
 * bills and a second money column is how two screens end up disagreeing about one dollar.
 *
 * `is_stock` IS NOT WRITTEN HERE. Since 0303 it is a mirror the database keeps: true only while a
 * roll from this line is on the shelf (stock_lots). Putting the rest on the shelf is its own door.
 */
export type ReceiptLineUsageResult = { ok: boolean; error?: string; note?: string };

export async function setReceiptLineUsage(input: {
  lineId: string;
  /** Dollars of this line THIS job used. Null puts the whole line back on the customer's bill. */
  billedAmount: number | null;
  /**
   * HOW MANY PIECES THIS LINE BOUGHT: units bought x pieces per unit, both typed by a person and
   * neither inferred. Null skips the shelf.
   *
   * It is the product and not the container count because this is the figure the shelf stores as
   * `quantity_on_hand` and divides the line cost by for `unit_cost`. Sending one box's count for a
   * two box line put half the real per-unit price into the price book along with half the stock.
   */
  containerCount: number | null;
  /** How many units of the container the line bought, from the sheet's own field. Carried
   *  separately from the product above so the refusal below can check it against the receipt. */
  boughtQuantity?: number | null;
  /** How many this job used, when he counted them rather than typing a dollar figure. */
  usedQuantity: number | null;
}): Promise<ReceiptLineUsageResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const lineId = String(input?.lineId ?? "");
  if (!lineId) return { ok: false, error: "Couldn't tell which receipt line you meant." };

  const { data: line } = await supabase
    .from("bill_line_items")
    .select("id, bill_id, description, quantity, unit_price, amount, is_stock, bills(job_id, supplier)")
    .eq("id", lineId)
    .maybeSingle();
  if (!line) return { ok: false, error: "Couldn't find that receipt line. Reload the page and try again." };

  // ONE READING OF WHAT THE LINE COST, shared with the invoice arithmetic. If the ceiling checked
  // here were computed any differently from the cost the itemisation subtracts against, a figure
  // could pass this gate and still be refused by the database - or worse, pass both and quietly
  // bill a few cents more than the line holds.
  const cost = billLineCost(line as Parameters<typeof billLineCost>[0]);

  let amount: number | null = null;
  if (input.billedAmount != null) {
    const n = Number(input.billedAmount);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "That isn't a dollar amount I can read." };
    if (!(cost > 0)) {
      return {
        ok: false,
        error: "This line has no price on it, so there's nothing to split. Fix the line's amount on the receipt first.",
      };
    }
    if (round2(n) > round2(cost)) {
      // 0272's CHECK says the same thing and would refuse this write anyway. Saying it here is
      // what turns a database error into a sentence he can act on.
      return {
        ok: false,
        error: `This job can't use more than the line cost, ${formatCurrency(cost)}. Lower the amount, or bill the whole line.`,
      };
    }
    /**
     * AND THE REFUSAL THAT GOES THE OTHER WAY (audit of cn-v966).
     *
     * The ceiling above is the only thing that ever stood between a split and the invoice, and the
     * failure it cannot see comes in UNDER it. "NMB 6/3 W/GND (1000 ft REEL)" on his CED ticket is
     * 55 feet at $4.32 for $237.66; divided as one thousand-piece container it bills $13.07, which
     * is comfortably less than the line cost and quietly walks $224.59 off the customer's invoice
     * while putting 945 feet of imaginary cable on the shelf.
     *
     * The receipt's own price column is the only witness to that, and the card checks it too. This
     * is here because a rule at one read path is a convention and not a boundary (0173): the same
     * function, the same sentence, so the screen and the database cannot say different things.
     */
    const objection = splitContradictsReceipt({
      cost,
      quantity: Number(line.quantity),
      unitPrice: Number(line.unit_price),
      boughtQuantity: input.boughtQuantity == null ? null : Number(input.boughtQuantity),
      pieces: input.containerCount == null ? null : Number(input.containerCount),
    });
    if (objection) return { ok: false, error: objection };
    amount = round2(n);
    // A new "used" figure under a roll would re-cost the roll without moving its pieces. Bill The
    // Whole Line (null, above) is let through: it takes the roll off the shelf, pieces and all.
    const rolled = await liveRollOnLine(supabase, ctx.orgId, lineId);
    if (rolled) return { ok: false, error: rolled };
  }

  // NOTHING SILENT. bill_line_items is staff-only behind RLS, so a non-staff or cross-org caller
  // gets a zero-row UPDATE, and a zero-row UPDATE is a 204 that looks exactly like success.
  //
  // `is_stock` is not this door's to touch: since 0303 the database keeps it true exactly while a
  // roll from this line is on the shelf. Once pieces of that roll are on a job, 0304 freezes this
  // line and the refusal says which takes to undo first.
  let write = supabase.from("bill_line_items").update({ billed_amount: amount }).eq("id", lineId);
  if (ctx.orgId) write = write.eq("org_id", ctx.orgId);
  const { data, error } = await write.select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data || data.length === 0) {
    return { ok: false, error: "That line wasn't changed. Reload the page and try again." };
  }

  const bill = (line as { bills?: { job_id?: string | null; supplier?: string | null } | null }).bills ?? null;
  const jobId = bill?.job_id ?? null;

  /**
   * ── THE SHELF IS NOT WRITTEN FROM HERE ANY MORE (Shop Stock, 0303) ──────────────────────────
   * This used to count the rest of the box onto inventory_items (stock-flow.ts) as a bare number
   * with no cost and no history. That count is now a cache of the shelf's own ledger, which the
   * database refuses to have typed over, and a line is marked is_stock only while a roll from it
   * is on the shelf. So this door moves the MONEY (what this job is billed) and nothing else;
   * "Put the Rest on the Shelf" (putOnShelf in src/lib/stock-ledger.ts) is the door that puts the
   * rest on the shelf, with its pieces, its unit and what it cost off this receipt (Phase 2).
   */
  const note = await restampAfterLineWrite(supabase, ctx.orgId, (line as { bill_id?: string | null }).bill_id);
  revalidatePath("/bills");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return note ? { ok: true, note } : { ok: true };
}

/**
 * PUT THE REST ON THE SHELF (Shop Stock, Phase 2; Erik: "things like wire and wire nuts i get a
 * roll and cut off 20' for a job").
 *
 * One press, one answer from a person: this line bought N pieces, THIS job used M of them, the rest
 * is on the shelf. What the job used is billed to it (billed_amount, the same column the split
 * writes); the rest becomes a roll on the shelf at its share of the ticket, tax included, and comes
 * off this job's cost. Both land in one transaction (0328), so a job is never billed for less while
 * nothing went on the shelf.
 *
 * Honeysuckle's 8/19 CED coil: 250 ft, 0 used. The job is billed $0 of it, the shelf holds 250 ft
 * of 12/2 at $180.17, and Honeysuckle's cost drops by $180.17.
 */
export async function putRestOnShelf(input: ShelfPick): Promise<ReceiptLineUsageResult & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const lineId = String(input?.lineId ?? "");
  if (!lineId) return { ok: false, error: "Couldn't tell which receipt line you meant." };
  const { data: line } = await ctx.supabase
    .from("bill_line_items")
    .select("id, bill_id, bills(job_id, po_id, jobs(name))")
    .eq("id", lineId)
    .maybeSingle();
  if (!line) return { ok: false, error: "Couldn't find that receipt line. Reload the page and try again." };

  const bill = (line as { bill_id?: string; bills?: { job_id?: string | null; po_id?: string | null; jobs?: { name?: string | null } | null } | null }).bills ?? null;
  const jobId = bill?.job_id ?? null;
  const jobName = bill?.jobs?.name ?? "The job";
  const billId = String((line as { bill_id?: string }).bill_id ?? "");

  /**
   * WHO ALREADY BILLS THIS RECEIPT (review of Phase 2), asked BEFORE anything moves:
   *   · a sent or paid invoice that billed the ORDER this receipt delivered (the importer skips a
   *     bill whose PO is billed) - the customer paid for the coil through the PO line, so a roll off
   *     it would be the same coil on the shelf to be billed again. Refused, like a claim on the
   *     receipt itself (0328 refuses both in the database too);
   *   · a DRAFT that holds the receipt or its order: it is brought up to date from the receipt right
   *     after the shelving (below), so it bills what the job used and nothing that went on the shelf.
   *     A line on it the office changed by hand never follows an import, so that draft refuses.
   */
  const claims = await readBillClaimants(ctx.supabase, billId, bill?.po_id ?? null);
  if ("error" in claims)
    return { ok: false, error: `Couldn't check which invoices already bill this receipt, so nothing went into stock: ${claims.error}` };
  const held = claims.rows.find((c) => c.status !== "draft");
  if (held)
    return {
      ok: false,
      error: `${held.number} has gone to the customer and already bills ${held.via === "po" ? "the order this receipt delivered" : "this receipt"}, so what the job used can't change now. Nothing went into stock.`,
    };
  const edited = claims.rows.find((c) => c.edited);
  if (edited)
    return {
      ok: false,
      error: `${edited.number} is a draft with a line from this receipt that was changed by hand, and a changed line doesn't follow the receipt, so the customer would still be billed for what goes into stock. Use Start It Over for Materials on ${edited.number}, then put the rest in stock. Nothing went into stock.`,
    };

  const res = await putOnShelf({ ...input, lineId });
  if (!res.ok) return { ok: false, error: res.error };

  // THE DRAFT FOLLOWS THE RECEIPT, in the same press. Pulling its materials in again refreshes every
  // imported line nobody edited (checked above), keeping the markup already on the invoice. If that
  // fails, the roll is on the shelf and the draft still bills the whole line: said, with the door.
  const draftNotes: string[] = [];
  for (const d of Array.from(new Map(claims.rows.map((c) => [c.invoiceId, c])).values())) {
    const up = await importCostsIntoInvoice(d.invoiceId, undefined, { keepInvoiceMarkup: true });
    if (up.ok) draftNotes.push(` ${d.number} (a draft) now bills this receipt as it stands.`);
    else
      draftNotes.push(
        ` ${d.number} (a draft) still bills the whole line: its materials didn't refresh (${up.error ?? "try again"}). Press ${BRING_IN_NEW_WORK} on ${d.number} before you send it.`,
      );
  }
  const draftNote = draftNotes.join("");
  const lot = res.lot;
  const perPiece = lot.pieces > 0 ? lot.cost / lot.pieces : 0;
  const each = perPiece > 0 && perPiece < 1 ? `about ${Math.round(perPiece * 100)}¢` : formatCurrency(perPiece);
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return {
    ok: true,
    message: `${lot.pieces} ${lot.unit} is in stock at ${formatCurrency(lot.cost)} (${each} a ${lot.unit === "ft" ? "foot" : lot.unit}). ${jobName}'s cost drops by ${formatCurrency(lot.cost)}.${draftNote}`,
  };
}

/**
 * TAKE IT OFF THE SHELF: the way back from Put the Rest on the Shelf, while nothing has been taken
 * from the roll (the database refuses after, naming the takes to undo). The roll's dollars go back
 * onto the job; what the customer is billed does not move, and Bill the Whole Line is one tap away.
 */
export async function takeRollOffShelf(lotId: string): Promise<Result> {
  const res = await unshelveLot(String(lotId ?? ""));
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}
