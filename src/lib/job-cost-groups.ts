/**
 * THE COSTS TAB, OPEN FIRST (Erik, 2026-09-25, building INV-081 for 85 Whitney: "in costs i need to
 * know what is open more than i need to know all the totals because i think theres a bill missing
 * from this but i cant even tell as they are all mixed together").
 *
 * No rule lives here. Which side of the line a bill or an order is on is UnbilledWork.costRows:
 * the loop that sums the Unbilled card's figure, over the same claims the importers read. This
 * only sorts the job's rows into the three piles that verdict names, so the list and the button
 * above it can never disagree about what is open:
 *
 *   Not Billed Yet   what the next bill picks up
 *   Billed           folded by the invoice holding it, newest first. A DRAFT holds its rows like
 *                    any non-void invoice ("On INV-081 (draft)"), so Not Billed Yet means on no
 *                    invoice at all, and the draft is marked so it never reads as sent
 *   Nothing To Bill  on no invoice and never going on one: its PO was billed, it is $0, every line
 *                    on it is the company's own, or it is a return of parts the customer was never
 *                    billed for. Listed, with why, so nothing is silent
 */

import type { ClaimantInvoice, CostRowVerdict, NothingToBill } from "@/lib/unbilled-work";
import { STOCK_NO_COST_FIX } from "@/lib/stock-billing";
import { formatCurrency } from "@/lib/utils";

export type CostRow = { id: string; kind: "bill" | "po" | "stock"; amount: number };

/** `takes`: pieces taken from stock (Shop Stock, Phase 3), one invoice line each. */
export type CostPile = { ids: string[]; bills: number; pos: number; takes: number; total: number };

/** A take from stock as the tab lists it: no bill row stands behind it, so its words ride here. */
export type StockPileRow = { label: string; cost: number; takenAt: string; note?: string };

export type BilledGroup = CostPile & {
  invoice: ClaimantInvoice;
  draft: boolean;
  /** The invoice sits on another job (the row was billed there and moved here): named with it. */
  offJobNumber: string | null;
};

export type JobCostGroups = {
  /** Its total is what the next bill picks up before markup (billsAmount − returnsAmount +
   *  stockAmount), not the bills' face value: a line that is the company's own is not in it. */
  open: CostPile;
  /** Open rows whose face value is more than the next bill picks up: id → dollars that stay the
   *  company's own. Said on the row, so the pile's total never reads as a typo. */
  openOwn: Record<string, number>;
  billed: BilledGroup[];
  nothing: { id: string; why: NothingToBill }[];
  /** The takes from stock in any pile, by verdict id ("stock:<draw_group>"): their words and cost. */
  stock: Record<string, StockPileRow>;
};

const cents = (n: number) => Math.round(n * 100) / 100;
const pile = (): CostPile => ({ ids: [], bills: 0, pos: 0, takes: 0, total: 0 });
const add = (p: CostPile, r: CostRow, amount: number = Number(r.amount) || 0) => {
  p.ids.push(r.id);
  if (r.kind === "po") p.pos += 1;
  else if (r.kind === "stock") p.takes += 1;
  else p.bills += 1;
  p.total = cents(p.total + amount);
};

/**
 * Sort the job's bills and orders by their verdict. A BILL with no verdict arrived after the
 * verdicts were read (the page reads the list and the figure side by side), so no invoice can hold
 * it yet: it is open. An ORDER with no verdict is not a live cost (a draft, a cancelled one, or one
 * a bill replaced) and belongs to no pile; the purchase orders list below still shows it.
 *
 * A TAKE FROM STOCK has no bill row: its verdict carries its own words and cost, so every stock
 * verdict is a row here (open, folded under the invoice that holds it, or nothing to bill).
 */
export function groupJobCosts(rows: readonly CostRow[], verdicts: readonly CostRowVerdict[], jobId: string | null = null): JobCostGroups {
  const byId = new Map(verdicts.map((v) => [v.id, v] as const));
  const open = pile();
  const openOwn: Record<string, number> = {};
  const billed = new Map<string, BilledGroup>();
  const nothing: JobCostGroups["nothing"] = [];
  const stock: Record<string, StockPileRow> = {};
  const stockRows: CostRow[] = [];
  for (const v of verdicts) {
    if (v.kind !== "stock") continue;
    stock[v.id] = { label: v.label, cost: v.cost, takenAt: v.takenAt, ...(v.note ? { note: v.note } : {}) };
    stockRows.push({ id: v.id, kind: "stock", amount: v.cost });
  }
  for (const r of [...rows.filter((x) => x.kind !== "stock"), ...stockRows]) {
    const v = byId.get(r.id);
    if (!v) {
      if (r.kind === "bill") add(open, r);
      continue;
    }
    if (v.state === "open") {
      // The engine's own figure for this row, so the pile adds up to what the button bills.
      add(open, r, v.cost);
      const own = cents(Math.abs(Number(r.amount) || 0) - Math.abs(v.cost));
      if (own > 0) openOwn[r.id] = own;
    }
    else if (v.state === "nothing") nothing.push({ id: r.id, why: v.why });
    else {
      const g =
        billed.get(v.invoice.id) ??
        ({
          ...pile(),
          invoice: v.invoice,
          draft: v.invoice.status === "draft",
          offJobNumber: jobId && v.invoice.job_id && v.invoice.job_id !== jobId ? (v.invoice.job_number ?? "another job") : null,
        } as BilledGroup);
      add(g, r);
      billed.set(v.invoice.id, g);
    }
  }
  return {
    open,
    openOwn,
    billed: [...billed.values()].sort((a, b) => b.invoice.created_at.localeCompare(a.invoice.created_at)),
    nothing,
    stock,
  };
}

/** "3 bills", "1 PO", "2 bills · 1 PO", "1 bill · 2 from stock", "0 bills" when the pile is empty. */
export function pileCount(p: Pick<CostPile, "bills" | "pos"> & { takes?: number }): string {
  const takes = p.takes ?? 0;
  const parts = [
    p.bills || (!p.pos && !takes) ? `${p.bills} ${p.bills === 1 ? "bill" : "bills"}` : null,
    p.pos ? `${p.pos} ${p.pos === 1 ? "PO" : "POs"}` : null,
    takes ? `${takes} from stock` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** The invoice a Billed row is folded under: "INV-081 (draft)", "INV-058 (J-021)". */
export function billedOnLabel(g: Pick<BilledGroup, "invoice" | "draft" | "offJobNumber">): string {
  const num = g.invoice.invoice_number ?? "An unnumbered invoice";
  const tags = [g.offJobNumber, g.draft ? "draft" : null].filter(Boolean);
  return tags.length ? `${num} (${tags.join(", ")})` : num;
}

/** Said under an open row that is partly the company's own: "$9.17 of it is your own". */
export function openOwnNote(own: number | undefined): string | undefined {
  return own && own > 0 ? `${formatCurrency(own)} of it is your own` : undefined;
}

/** Why a row is on no invoice and never will be, in the office's words. */
export function nothingToBillWhy(why: NothingToBill): string {
  if (why === "po_billed") return "Its PO is already billed";
  if (why === "own_cost") return "All of it is your own cost";
  if (why === "own_return") return "A return of parts the customer was never billed for";
  // Nothing re-costs a take once it is drawn, so the words name only the door that works.
  if (why === "stock_no_cost") return `Its roll has no cost on it, so it isn't billed - ${STOCK_NO_COST_FIX}`;
  return "Nothing on it to bill";
}
