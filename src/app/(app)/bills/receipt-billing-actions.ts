"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import { billLineCost } from "@/lib/bill-itemisation";
import { drawStockForJob, stockFromReceiptLine } from "@/lib/stock-flow";
import { formatCurrency } from "@/lib/utils";
import { perUnitCost, round2, usedCountFromCost } from "./receipt-billing";

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
 * `is_stock` IS NOT WRITTEN HERE ON PURPOSE. stockFromReceiptLine claims the line itself - it
 * flips `is_stock` false → true as its guard against counting one box onto the shelf twice - so
 * setting the flag here would make that claim find zero rows and refuse. The money is written
 * first regardless: if the shelf write fails, the customer is still billed correctly and the
 * refusal is said out loud, which is the right way round for the two to fail.
 */
export type ReceiptLineUsageResult = { ok: boolean; error?: string; note?: string };

export async function setReceiptLineUsage(input: {
  lineId: string;
  /** Dollars of this line THIS job used. Null puts the whole line back on the customer's bill. */
  billedAmount: number | null;
  /** How many the container holds - typed by a person, never inferred. Null skips the shelf. */
  containerCount: number | null;
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
    amount = round2(n);
  }

  // NOTHING SILENT. bill_line_items is staff-only behind RLS, so a non-staff or cross-org caller
  // gets a zero-row UPDATE, and a zero-row UPDATE is a 204 that looks exactly like success.
  //
  // Clearing the split does NOT clear `is_stock`, and that is deliberate: the flag records that
  // this container was counted onto the shelf, which is a thing that HAPPENED. Un-saying it would
  // let the same box be counted a second time the next time he splits the line. The money goes
  // back to billing the whole line, which is what he asked for; the shelf count is corrected on
  // Stock, where the count lives.
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
   * ── THE SHELF (Owner C's seam, src/lib/stock-flow.ts) ───────────────────────────────────────
   * The rest of the box did not evaporate: it went back in the van. stockFromReceiptLine is the
   * one door onto `inventory_items` and it claims the line as its own guard, so this is called
   * exactly once per line - a later change to the split moves the MONEY and leaves the shelf
   * count alone, because there is no stock movement ledger to correct against yet and inventing
   * a correction would be worse than leaving the count where a person put it.
   *
   * A shelf failure never undoes the money. It comes back as a note the card says out loud.
   */
  let note: string | undefined;
  const containerCount = Number(input.containerCount) || 0;
  if (amount != null && containerCount > 0 && line.is_stock !== true) {
    const added = await stockFromReceiptLine({
      lineId,
      description: String(line.description ?? ""),
      // What ONE CONTAINER cost on the receipt - $108.36 for the box, not 21 cents for a nut.
      unitCost: cost,
      containerCount,
      vendor: bill?.supplier ?? null,
      // There is no part-number column on a receipt line. The catalogue number is inside the
      // description ("IDEAL 30641 Twister 341-Tan 500") and parsing one out of it would be a
      // guess at which token is the part - so nothing is passed rather than something invented.
      partNumber: null,
    });
    if (!added.ok) {
      note = added.error;
    } else if (amount > 0) {
      // WHAT LEAVES THE SHELF. The count he typed when he counted them; otherwise the count his
      // dollars work out to. That derived figure is a QUANTITY and never money - the invoice
      // bills the dollars he typed, to the cent, and no rounded count is printed anywhere a
      // customer will read it.
      const used =
        input.usedQuantity != null && Number(input.usedQuantity) > 0
          ? Math.round(Number(input.usedQuantity) * 100) / 100
          : usedCountFromCost(amount, perUnitCost(cost, containerCount));
      if (used && used > 0) {
        const drew = await drawStockForJob({
          inventoryItemId: added.inventoryItemId,
          quantity: used,
          note: `${String(line.description ?? "Receipt line")} - ${formatCurrency(amount)} used on this job`,
        });
        if (!drew.ok) note = drew.error;
      }
    }
  }

  revalidatePath("/bills");
  revalidatePath("/inventory");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return { ok: true, note };
}
