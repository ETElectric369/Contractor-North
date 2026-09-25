"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import { billLineCost } from "@/lib/bill-itemisation";
import { formatCurrency } from "@/lib/utils";
import { round2, splitContradictsReceipt } from "./receipt-billing";

export type Result = { ok: boolean; error?: string };

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
    .select("id, bill_id, bills(job_id)")
    .eq("id", lineId)
    .maybeSingle();
  if (!line) return { ok: false, error: "Couldn't find that receipt line. Reload the page and try again." };

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
  revalidatePath("/bills");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
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
   * "Put The Rest On The Shelf" (putOnShelf in src/lib/stock-ledger.ts) is the door that puts the
   * rest on the shelf, with its pieces, its unit and what it cost off this receipt (Phase 2).
   */
  revalidatePath("/bills");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}
