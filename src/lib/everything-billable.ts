import { billableChangeOrders } from "@/lib/change-order-billing";
import { isDrawKind } from "@/lib/invoice-math";
import { isPrepaymentKind } from "@/lib/prepayments";

/**
 * EVERYTHING BILLABLE (cn-v1181): what a fixed-price job can bill, what its sent bills cover, and what
 * is still to bill, with ALL the billing data a job holds.
 *
 * WHERE IT CAME FROM. cn-v1179 keeps a fixed-price job open after a payment while its price is not all
 * on a bill, measured by the job page's Left to Bill: the accepted estimates' totals less the sent
 * bills' totals. That figure knew no change order and no discount, so a job with a discount line, an
 * approved deduct change order, or a taxed estimate billed with no tax stayed open for ever, and an
 * approved extra that was never billed did not hold one open. The cure was put to the owner as "teach
 * the page's rollup about change orders and discounts", and his answer (2026-11-22): "yes \"left to
 * bill\" should definitely have all the billing data and lets change the name to \"Everything
 * Billable\"".
 *
 * THIS IS A NEW RULE IN A FILE OF ITS OWN, ON PURPOSE. contractTotalFromQuotes and computeJobProgress
 * also feed the customer's draw paper, the draws themselves, the generated contract, profitability
 * and the billing pipeline; none of those may move. The tile on a contract job, the paid-in-full
 * gate (lib/finish-bills-first priceLeftToBill) and the Get Paid sheet read THIS and only this, so the
 * page and the gate can never disagree (two doors, one thing).
 *
 * THE UNIT IS DOLLARS BEFORE TAX. A price is agreed before tax, a discount is given before tax, and a
 * change order's amount has none; tax is charged bill by bill and may be exempt. So each side is
 * measured before tax and the tax the bills charged is reported beside the figures, never inside:
 *
 *   billable = the estimates (accepted ones add up; with none accepted, the newest alone)
 *            + approved change orders (an add is positive, a deduct negative)
 *            - discounts given on sent bills (a discount is a lower price, not money still owed)
 *   billed   = what the sent, non-void bills cover:
 *                a payment request      its amount, turned back into before-tax dollars by the
 *                                       estimate's own ratio: it is tax-free money against the
 *                                       TAX-INCLUDED price, exactly as a draw is (on an estimate with no
 *                                       tax that is its amount). It comes back off a later bill as a
 *                                       credit line, and the two add up to the work.
 *                a draw with no tax     a slice of the estimate's TAX-INCLUDED total (that is how
 *                                       draws are born), turned back into before-tax dollars by the
 *                                       estimate's own ratio; a discount on it is real dollars and
 *                                       is never scaled
 *                anything else          its subtotal (its lines, discounts and credits included), with
 *                                       the tax share of any request it took off put back: the credit
 *                                       line sits inside the subtotal at the request's full amount, and
 *                                       the request itself counted only at its before-tax share
 *   left     = billable - billed, never below zero;  over = billed - billable, never below zero.
 *
 * WHAT A PART OF THE ESTIMATE MAY TAKE (`partLeftGross`) IS MEASURED BY WORK, NOT BY MONEY ASKED AHEAD.
 * The door that writes a part (recurring/actions createProgressInvoice) bills a percent of the WORK
 * the estimate has left, and the job's payment requests then come off that bill by themselves; so a
 * request does not shrink what a part is a part of, and a bill that took one off counts at its work
 * (the credit added back). The sheet that shows the percent base and the door that bills it read this
 * one figure. `requestsToComeOff` is the money asked ahead that no sent bill has taken off yet.
 *
 * NOT THIS RULE'S BUSINESS: a Time and Material job (its bills are its work: the Unbilled card), a job
 * on a payment schedule (the schedule's own remaining stands), and a line added to a bill by hand that
 * is no change order (it counts as billing toward the price, as it always did).
 */

const fin = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};
const cents = (n: number) => Math.round(n * 100) / 100;
/** One cent, with room for the float it is held in. */
const CENT = 0.0101;
const has = (x: unknown): boolean => x !== null && x !== undefined && x !== "" && Number.isFinite(Number(x));

export type BillableQuote = {
  quote_number?: string | null;
  status?: string | null;
  created_at?: string | null;
  subtotal?: number | string | null;
  tax?: number | string | null;
  total?: number | string | null;
};

export type BillableChangeOrder = {
  id: string;
  co_number: string | null;
  description: string | null;
  amount: number | null;
  status?: string | null;
};

/** A customer's invoice on the job. `discount` is the sum of its discount lines (line_kind
 *  'discount'), in whatever sign they are stored: it is read as a cut. */
export type BillableInvoice = {
  id?: string | null;
  invoice_number?: string | null;
  status: string;
  invoice_kind?: string | null;
  subtotal?: number | string | null;
  tax?: number | string | null;
  total: number | string | null;
  discount?: number | string | null;
  /** The sum of its lines that take a payment request off (import_source 'prepaid_credit'), in
   *  whatever sign they are stored: read as money taken off this bill. Absent means none. */
  prepaidCredit?: number | string | null;
};

export type EverythingBillable = {
  /** Everything that can be billed on the job, before tax. */
  billable: number;
  /** What the sent bills cover, before tax. */
  billed: number;
  /** Still to bill. Never negative. */
  left: number;
  /** Billed past what was agreed (an approved deduct never taken off, an extra billed by hand). */
  over: number;
  billedInFull: boolean;
  /** The price is an ACCEPTED one. False: the newest estimate alone, not accepted yet. */
  accepted: boolean;
  /** The three pieces of `billable`: the estimates, the approved change orders (signed), the discounts (a positive cut). */
  estimates: number;
  changeOrders: number;
  discounts: number;
  /** Tax the sent bills charged. Beside the figures, never inside them. */
  tax: number;
  /** An estimate or a sent bill carries tax: the screen says its figures are before tax. */
  taxed: boolean;
  /** What Part of the Estimate may still take, in the estimate's own tax-included dollars: the WORK
   *  the estimate has left (payment requests are not work: they come off the part's bill by
   *  themselves), never more than is still billable once discounts and approved deducts are counted. */
  partLeftGross: number;
  /** Money asked ahead on payment requests that no sent bill has taken off yet: it is inside `billed`
   *  and comes off the next bill by itself. */
  requestsToComeOff: number;
  /** For the Why fold. */
  pieces: {
    estimates: { number: string | null; amount: number; accepted: boolean }[];
    changeOrders: { id: string; label: string; amount: number }[];
    bills: { id: string | null; number: string | null; total: number; counts: number }[];
  };
};

/** The estimates that ARE the price: the accepted ones, else the newest alone (contractTotalFromQuotes'
 *  rule, mirrored here so the page's two figures pick the same papers). */
export function priceQuotes<Q extends BillableQuote>(quotes: readonly Q[] | null | undefined): { quotes: Q[]; accepted: boolean } {
  const all = [...(quotes ?? [])];
  const accepted = all.filter((q) => q.status === "accepted");
  if (accepted.length) return { quotes: accepted, accepted: true };
  if (all.length > 1 && all.some((q) => !q.created_at)) {
    // The same refusal contractTotalFromQuotes makes: "newest" cannot be told without the stamps.
    throw new Error("everythingBillable: quotes are missing created_at; add it to the select list, or the newest-estimate rule cannot be applied.");
  }
  const newest = all.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
  return { quotes: newest ? [newest] : [], accepted: false };
}

/** An estimate's price before tax: its subtotal; a row with none stored reads total less tax. */
function beforeTax(q: BillableQuote): number {
  const sub = fin(q.subtotal);
  if (has(q.subtotal) && Math.abs(sub) > 0.005) return sub;
  return fin(q.total) - fin(q.tax);
}

/** Null when the job has no estimate at all (nothing to measure against). */
export function everythingBillable(input: {
  quotes: readonly BillableQuote[] | null | undefined;
  changeOrders?: readonly BillableChangeOrder[] | null;
  invoices?: readonly BillableInvoice[] | null;
}): EverythingBillable | null {
  const price = priceQuotes(input.quotes);
  if (!price.quotes.length) return null;

  const estimates = cents(price.quotes.reduce((s, q) => s + beforeTax(q), 0));
  const gross = cents(price.quotes.reduce((s, q) => s + fin(q.total), 0));
  // Before-tax dollars per tax-included dollar of the estimate. 1 when the estimate has no tax.
  const ratio = gross > 0.005 && estimates > 0.005 ? estimates / gross : 1;

  const cos = billableChangeOrders([...(input.changeOrders ?? [])]);
  const changeOrders = cents(cos.reduce((s, c) => s + fin(c.amount), 0));

  let discounts = 0;
  let billed = 0;
  let tax = 0;
  let workGross = 0; // the WORK on sent bills, tax-included: requests out, their credits added back
  let workCounts = 0; // the same, before tax
  let requested = 0;
  let tookOff = 0;
  const bills: EverythingBillable["pieces"]["bills"] = [];
  for (const inv of input.invoices ?? []) {
    if (inv.status === "void" || inv.status === "draft") continue;
    const total = fin(inv.total);
    const cut = Math.abs(fin(inv.discount));
    const invTax = fin(inv.tax);
    const request = isPrepaymentKind(inv.invoice_kind);
    // Money this bill took off for a payment request (a request itself takes none off).
    const credit = request ? 0 : Math.abs(fin(inv.prepaidCredit));
    let counts: number;
    // Money asked ahead is tax-free money against the tax-included price: its before-tax share. (Skeptic
    // #84: counted at its full amount, a request for the whole of a taxed price read as "all billed" AND
    // "more than agreed" by the tax, and a deposit read as more billed than it was until a bill took it off.)
    if (request) counts = total * ratio;
    // The discount is real dollars: only the slice of the estimate is turned back. A request this draw
    // took off needs no term of its own: it left the tax-included slice, and the ratio turns both back.
    else if (isDrawKind(inv.invoice_kind) && Math.abs(invTax) <= 0.005) counts = (total + cut) * ratio - cut;
    // A bill with its own tax: its subtotal holds the credit line at the request's FULL amount, and the
    // request counted at its before-tax share, so the difference (the request's tax share) is put back.
    else counts = (has(inv.subtotal) ? fin(inv.subtotal) : total - invTax) + credit * (1 - ratio);
    discounts += cut;
    billed += counts;
    tax += invTax;
    if (request) requested += total;
    else {
      tookOff += credit;
      workGross += total + credit;
      workCounts += counts + credit * ratio;
    }
    bills.push({ id: inv.id ?? null, number: inv.invoice_number ?? null, total: cents(total), counts: cents(counts) });
  }
  discounts = cents(discounts);
  billed = cents(billed);
  tax = cents(tax);

  const billable = cents(Math.max(0, estimates + changeOrders - discounts));
  const rest = cents(billable - billed);
  // A CENT OF ROUNDING IS NOT MONEY. A draw is a cents-rounded slice of a tax-included total, turned back
  // into before-tax dollars: two draws that bill an estimate out can land a cent either side of it. A
  // cent "still to bill" would hold a paid job open for ever, so one cent or less is nothing here; two
  // cents is money.
  const left = rest > CENT ? rest : 0;
  const over = rest < -CENT ? -rest : 0;
  // A part is a part of the WORK left: by the estimate's own tax-included dollars, and never past what
  // is still billable (a discount given or an approved deduct is not billed again as a part).
  // The estimate's own remainder IS what a part is a part of, to the cent, so that "the rest" bills the
  // estimate out exactly. The price caps it only where it is truly lower (a discount given, an approved
  // deduct, tax that was never billed): a cent of rounding between the two is not lower.
  const grossWorkLeft = Math.max(0, cents(gross - workGross));
  const byPrice = Math.max(0, ratio > 0 ? (billable - workCounts) / ratio : billable - workCounts);
  const partLeftGross = byPrice >= grossWorkLeft - CENT ? grossWorkLeft : cents(byPrice);
  const requestsToComeOff = Math.max(0, cents(requested - tookOff));

  return {
    billable,
    billed,
    left,
    over,
    billedInFull: billable > 0.005 && left <= 0,
    accepted: price.accepted,
    estimates,
    changeOrders,
    discounts,
    tax,
    taxed: Math.abs(tax) > 0.005 || price.quotes.some((q) => Math.abs(fin(q.tax)) > 0.005),
    partLeftGross,
    requestsToComeOff,
    pieces: {
      estimates: price.quotes.map((q) => ({ number: q.quote_number ?? null, amount: cents(beforeTax(q)), accepted: q.status === "accepted" })),
      changeOrders: cos.map((c) => ({
        id: c.id,
        label: [c.co_number, (c.description ?? "").trim()].filter(Boolean).join(" · ") || "Change order",
        amount: cents(fin(c.amount)),
      })),
      bills,
    },
  };
}
