/** Pure job progress-billing math, extracted from job-financials.ts so the
 *  estimate / invoiced / collected / work-to-date computation is unit-testable
 *  without a DB. The server fn does the fetching, then calls this. */

import { contractTotalFromQuotes } from "@/lib/payment-schedule-math";

export type JobProgressFinancials = {
  /** Sum of the job's quotes — the agreed estimate (a cap on fixed-price, a
   *  reference on Time & Material). */
  estimate: number;
  /** Billable work to date: labor at charge rate + materials with markup. Computed
   *  the SAME way importLabor/importCosts bill, so it reconciles to the penny. */
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
export type MaterialBill = { amount: number | null; po_id?: string | null };

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
  // Live POs only: a draft/cancelled order is not a cost, and a PO already paid by a
  // supplier bill is superseded by that bill (never charge one delivery twice).
  const billableMaterials =
    livePurchaseOrders(input.pos, input.bills).reduce(
      (s, p) => (num(p.total) > 0 ? s + mk(num(p.total)) : s),
      0,
    ) + (input.bills ?? []).reduce((s, b) => (num(b.amount) > 0 ? s + mk(num(b.amount)) : s), 0);

  const workToDate = cents(num(input.billableLabor) + billableMaterials);
  return { estimate, workToDate, invoiced, collected, billingType };
}
