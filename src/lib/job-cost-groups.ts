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

export type CostRow = { id: string; kind: "bill" | "po"; amount: number };

export type CostPile = { ids: string[]; bills: number; pos: number; total: number };

export type BilledGroup = CostPile & {
  invoice: ClaimantInvoice;
  draft: boolean;
  /** The invoice sits on another job (the row was billed there and moved here): named with it. */
  offJobNumber: string | null;
};

export type JobCostGroups = {
  open: CostPile;
  billed: BilledGroup[];
  nothing: { id: string; why: NothingToBill }[];
};

const cents = (n: number) => Math.round(n * 100) / 100;
const pile = (): CostPile => ({ ids: [], bills: 0, pos: 0, total: 0 });
const add = (p: CostPile, r: CostRow) => {
  p.ids.push(r.id);
  if (r.kind === "po") p.pos += 1;
  else p.bills += 1;
  p.total = cents(p.total + (Number(r.amount) || 0));
};

/**
 * Sort the job's bills and orders by their verdict. A BILL with no verdict arrived after the
 * verdicts were read (the page reads the list and the figure side by side), so no invoice can hold
 * it yet: it is open. An ORDER with no verdict is not a live cost (a draft, a cancelled one, or one
 * a bill replaced) and belongs to no pile; the purchase orders list below still shows it.
 */
export function groupJobCosts(rows: readonly CostRow[], verdicts: readonly CostRowVerdict[], jobId: string | null = null): JobCostGroups {
  const byId = new Map(verdicts.map((v) => [v.id, v] as const));
  const open = pile();
  const billed = new Map<string, BilledGroup>();
  const nothing: JobCostGroups["nothing"] = [];
  for (const r of rows) {
    const v = byId.get(r.id);
    if (!v) {
      if (r.kind === "bill") add(open, r);
      continue;
    }
    if (v.state === "open") add(open, r);
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
    billed: [...billed.values()].sort((a, b) => b.invoice.created_at.localeCompare(a.invoice.created_at)),
    nothing,
  };
}

/** "3 bills", "1 PO", "2 bills · 1 PO". */
export function pileCount(p: Pick<CostPile, "bills" | "pos">): string {
  const bills = `${p.bills} ${p.bills === 1 ? "bill" : "bills"}`;
  const pos = `${p.pos} ${p.pos === 1 ? "PO" : "POs"}`;
  if (!p.pos) return bills;
  if (!p.bills) return pos;
  return `${bills} · ${pos}`;
}

/** The invoice a Billed row is folded under: "INV-081 (draft)", "INV-058 (J-021)". */
export function billedOnLabel(g: Pick<BilledGroup, "invoice" | "draft" | "offJobNumber">): string {
  const num = g.invoice.invoice_number ?? "An unnumbered invoice";
  const tags = [g.offJobNumber, g.draft ? "draft" : null].filter(Boolean);
  return tags.length ? `${num} (${tags.join(", ")})` : num;
}

/** Why a row is on no invoice and never will be, in the office's words. */
export function nothingToBillWhy(why: NothingToBill): string {
  if (why === "po_billed") return "Its PO is already billed";
  if (why === "own_cost") return "All of it is your own cost";
  if (why === "own_return") return "A return of parts the customer was never billed for";
  return "Nothing on it to bill";
}
