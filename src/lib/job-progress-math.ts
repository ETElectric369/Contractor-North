/** Pure job progress-billing math, extracted from job-financials.ts so the
 *  estimate / invoiced / collected / work-to-date computation is unit-testable
 *  without a DB. The server fn does the fetching, then calls this. */

import { billableBillCost, type BillLine } from "@/lib/bill-itemisation";
import { returnCreditCost, returnLinesAgainstPurchases } from "@/lib/supplier-returns";
import { contractTotalFromQuotes } from "@/lib/payment-schedule-math";
import { lumpLineRule } from "@/lib/invoice-math";
import { lineGroup } from "@/lib/portal/line-kind";

export type JobProgressFinancials = {
  /** Sum of the job's quotes — the agreed estimate (a cap on fixed-price, a
   *  reference on Time & Material). */
  estimate: number;
  /** Billable work to date. TIME & MATERIAL (given `tmWork`): the work lines already on the job's
   *  invoices at the price they were billed, plus the unbilled work priced as the next bill would
   *  price it - see billedWorkOnInvoices. FIXED PRICE: labor at charge rate + materials with
   *  markup, computed the SAME way importLabor/importCosts bill - which since 0268/0272 means a
   *  receipt counts for what it BILLS, not what it cost. */
  workToDate: number;
  /** Invoices actually sent to the customer (non-void, non-draft). */
  invoiced: number;
  /** Settled against the job's invoices — sum of amount_paid on non-void invoices.
   *  This is invoice-SETTLEMENT, which a balance-reducing account credit lowers even
   *  without cash arriving; /analytics' "collected" is true CASH (payments ledger net
   *  of voids/refunds, computeCollected). They agree whenever there are no non-cash
   *  credits — the common case. Full alignment = feed this from the payments ledger
   *  too (a signature change on this hot path; deferred, tracked). */
  collected: number;
  /** "fixed" (estimate is a contract cap) or "tm" (estimate is a reference). */
  billingType: "fixed" | "tm";
};

const num = (x: unknown): number => {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const cents = (n: number) => Math.round(n * 100) / 100;

// ── Material cost: the ONE rule ──────────────────────────────────────────────

/** PO statuses that are not a real committed cost: an unsent draft, or a killed order. */
// Only a CANCELLED (killed) PO is a non-cost. A 'draft' PO is the DEFAULT status
// (0002) and is still committed material cost — excluding it silently under-billed
// the customer for anything the office left in draft (audit re-review 2026-07-20).
const NON_COST_PO_STATUSES = new Set(["cancelled"]);

export type MaterialPo = { id?: string | null; total: number | null; status?: string | null };
/** A supplier bill as the money readers see it. `bill_line_items` is what the receipt was read
 *  into: it decides how much of `amount` reaches the customer (0268/0272), and a row that carries
 *  none - a hand-entered bill, or a caller whose select list has not been widened - bills its
 *  whole amount exactly as it always did. */
export type MaterialBill = {
  id?: string | null;
  amount: number | null;
  po_id?: string | null;
  bill_line_items?: BillLine[] | null;
  /** When it was filed: the order supplier returns spend a purchase in (returnLinesAgainstPurchases). */
  created_at?: string | null;
};

/**
 * THE material-cost rule, shared by every summer (progress financials, profitability,
 * budget-vs-actual, and importCostsIntoInvoice) so a job can never show — or bill — two
 * different material numbers.
 *
 * A purchase order counts as material cost only while it is BOTH:
 *   1. live — not `cancelled` (a killed order), and
 *   2. not fully superseded by a supplier bill that names it via `bills.po_id` (0142).
 *
 * (2) is the double-charge fix: a PO is an *estimate* of what a delivery will cost; the
 * supplier's bill is what it ACTUALLY cost. So a PO's contribution is its total MINUS the
 * bills that already name it — the bills are summed separately by every caller, so
 * (po.total − linkedBills) + allBills counts each delivery once. A partial bill therefore
 * leaves the PO's un-billed remainder still on the job (a $5k PO with a $2k partial bill
 * contributes $3k here + $2k in the bill sum = $5k committed, not $2k); a bill that covers
 * the PO drops it to zero. The returned rows carry the ADJUSTED total for markup.
 *
 * A PO row with no `status` (a partial select or old fixture) is treated as live.
 */
export function livePurchaseOrders<T extends MaterialPo>(
  pos: T[] | null | undefined,
  bills: MaterialBill[] | null | undefined,
): T[] {
  const billedByPo = new Map<string, number>();
  for (const b of bills ?? []) {
    if (typeof b.po_id === "string" && b.po_id) {
      billedByPo.set(b.po_id, (billedByPo.get(b.po_id) ?? 0) + (Number(b.amount) || 0));
    }
  }
  const out: T[] = [];
  for (const p of pos ?? []) {
    if (NON_COST_PO_STATUSES.has(String(p.status ?? "").toLowerCase())) continue;
    const billed = p.id ? (billedByPo.get(p.id) ?? 0) : 0;
    const remainder = Math.round(((Number(p.total) || 0) - billed) * 100) / 100;
    if (remainder <= 0.005) continue; // fully (or over-) billed → the bill sum carries it
    out.push(billed > 0 ? ({ ...p, total: remainder } as T) : p);
  }
  return out;
}

/** One invoice line as the billed-work sum reads it (the classifying columns + its dollars). */
export type BilledWorkLine = {
  import_source?: string | null;
  line_kind?: string | null;
  unit?: string | null;
  description?: string | null;
  line_total?: number | string | null;
};

/**
 * THE WORK A JOB'S INVOICES ALREADY CARRY, AT THE PRICE THEY CARRY IT (Tao Zhu, J-002, 2026-09-25).
 *
 * INV-080's Progress Summary said "Work completed to date $18,624.14" while Tao had been billed
 * $19,716.64 for work: the panel priced every hour ever worked at TODAY's bill rate (Erik $125,
 * Brian $85), and the June hours had gone out on INV-00028 at $150 and $75. A billed line is the
 * truth for what was billed. So on Time & Material, work to date is these lines plus the unbilled
 * work (unbilledWorkForJob: what the next bill would charge). No hour or receipt is counted twice:
 * a row an invoice line claims (source_ids / its key) is off the unbilled figure, and its line is
 * here; an unclaimed row is there and nowhere here.
 *
 * WHICH LINES ARE WORK: labor, materials (returns come off as negatives), change orders, lines
 * from the estimate, and hand lines - lineGroup, the rule the portal and /i file lines by. NOT
 * work: a deposit's lines, a milestone line, a lump draw's own amount (lumpLineRule, the rule the
 * "Less previous billings" credit nets) and the credit lines themselves. Those are money asked
 * for against work, and counting them would count the same work twice.
 *
 * EVERY NON-VOID INVOICE, DRAFTS INCLUDED. A draft is not billed yet, but its lines are the running
 * bill (INV-078 on J-011): the rows it claims are already off the unbilled figure, so leaving the
 * draft out would drop that work from both halves. Its work reads at its own line prices, as the
 * customer will see it.
 */
export function billedWorkOnInvoices(
  invoices: { status: string; invoice_kind?: string | null; invoice_items?: BilledWorkLine[] | null }[] | null | undefined,
): number {
  let sum = 0;
  for (const inv of invoices ?? []) {
    if (inv.status === "void") continue;
    const items = inv.invoice_items ?? [];
    const isLump = lumpLineRule(inv.invoice_kind, items);
    for (const it of items) {
      const src = it.import_source ?? null;
      if (src === "draw_credit" || src === "milestone" || isLump(it)) continue;
      const g = lineGroup(it, inv.invoice_kind ?? null);
      if (g === "credit" || g === "deposit" || g === "contract") continue;
      sum += num(it.line_total);
    }
  }
  return cents(sum);
}

/** Roll the fetched rows + already-computed billable labor into the progress
 *  financials. Materials are marked up PER ROW (cost > 0 only) exactly like
 *  importCostsIntoInvoice; invoiced excludes void/draft; collected excludes void. */
export function computeJobProgress(input: {
  billingTypeRaw: string | null | undefined;
  quotes: { total: number | null; status?: string | null }[];
  invoices: { total: number | null; status: string; amount_paid: number | null }[];
  billableLabor: number;
  pos: MaterialPo[];
  bills: MaterialBill[];
  markupPercent: number;
  /** Time & Material only: the billed work (billedWorkOnInvoices) and the unbilled work
   *  (unbilledWorkForJob's total). When given on a T&M job, work to date is their sum; the
   *  labor/material roll-up below is then the fixed-price figure only. */
  tmWork?: { billed: number; unbilled: number } | null;
  /** FIXED PRICE: every live take from stock on the job (net of pieces carried back), billed or
   *  not: work to date is everything worked. Each is marked up and rounded on its own, exactly as
   *  the importer writes one line per take (stock-billing.ts). Absent = none. On Time & Material
   *  the takes are already in `tmWork` (billed ones as their lines, open ones in the unbilled). */
  stockTakes?: { cost: number }[];
}): JobProgressFinancials {
  const billingType: "fixed" | "tm" = input.billingTypeRaw === "tm" ? "tm" : "fixed";

  // Estimate base = the ACCEPTED contract (accepted quote[s] only; falls back to all
  // quotes when none accepted yet) via the one shared rule — so a superseded revision
  // can't inflate the base. Same helper the job page + billing + contracts use.
  const estimate = contractTotalFromQuotes(input.quotes ?? []);
  const invoiced = cents(
    (input.invoices ?? []).reduce(
      (s, i) => (i.status !== "void" && i.status !== "draft" ? s + num(i.total) : s),
      0,
    ),
  );
  const collected = cents(
    (input.invoices ?? []).reduce((s, i) => (i.status !== "void" ? s + num(i.amount_paid) : s), 0),
  );

  const markup = num(input.markupPercent);
  const mk = (cost: number) => cents(cost * (1 + markup / 100));
  // A return credits at most what the purchase it reverses billed - the importer's own reading.
  const returnLines = returnLinesAgainstPurchases(input.bills ?? [], (b) => b.bill_line_items);
  // Live POs only: a draft/cancelled order is not a cost, and a PO already paid by a
  // supplier bill is superseded by that bill (never charge one delivery twice).
  const billableMaterials =
    livePurchaseOrders(input.pos, input.bills).reduce(
      (s, p) => (num(p.total) > 0 ? s + mk(num(p.total)) : s),
      0,
    ) +
    // WORK TO DATE IS WHAT THE CUSTOMER WILL BE BILLED, NOT WHAT THE BOX COST (review of cn-v966).
    // The whole promise of this function is that the panel reconciles to the penny with the lines
    // importCostsIntoInvoice writes, and since 0268/0272 those lines are the receipt MINUS the
    // snacks and minus the share of a container that went on the shelf. Summing bills.amount here
    // put Erik's ice cream bar, marked up, into the reference figure a progress draw is measured
    // against. billableBillCost is the importer's own reading, shared, so the two cannot drift.
    //
    // livePurchaseOrders above still gets the FULL amounts: a PO is an estimate of what the
    // delivery COST and its bill supersedes it at cost, not at price. Netting the excluded lines
    // out of that subtraction would leave the snacks behind as an un-billed PO remainder.
    (input.bills ?? []).reduce((s, b) => {
      const billable = billableBillCost(b.amount, b.bill_line_items);
      return billable > 0 ? s + mk(billable) : s;
    }, 0) -
    // A SUPPLIER RETURN COMES OFF (INV-078). The importer now credits a return filed as a negative
    // bill, marked up like the purchase it reverses and net of the lines that were never the
    // customer's; the reference figure has to move with it or the panel stops reconciling to the
    // lines it promises to equal. Same shared reading as the importer and the Unbilled card.
    (input.bills ?? []).reduce((s, b) => {
      const back = returnCreditCost(b.amount, returnLines.get(b) ?? b.bill_line_items);
      return back > 0 ? s + mk(back) : s;
    }, 0) +
    // PIECES TAKEN FROM STOCK (Shop Stock, Phase 3): each take bills its stamped cost at the same
    // markup, one line per take, so work to date moves with the lines the importer writes.
    (input.stockTakes ?? []).reduce((s, t) => (num(t.cost) > 0 ? s + mk(num(t.cost)) : s), 0);

  const workToDate =
    billingType === "tm" && input.tmWork
      ? cents(num(input.tmWork.billed) + num(input.tmWork.unbilled))
      : cents(num(input.billableLabor) + billableMaterials);
  return { estimate, workToDate, invoiced, collected, billingType };
}
