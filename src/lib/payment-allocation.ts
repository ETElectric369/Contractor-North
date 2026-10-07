/**
 * WHICH BILLS A SUPPLIER PAYMENT PAYS (0383, task 3 2026-10-07). Pure: the server decides, the sheet
 * only draws the boxes.
 *
 * Erik, 2026-10-04, on CED's own portal: "i check all the boxes next to all the invoices i want to
 * pay and it totals it up and thats my amount, checked boxes get logged and if i make a payment to
 * the account instead it'll mark off in order from old to new the ones that are fully paid and
 * leave the last one partially paid". His three answers, 2026-10-07:
 *   · a payment short of the boxes by CED's printed discount is paid in full, the discount recorded;
 *   · money over the boxes "needs to apply": it goes on the next open purchases, oldest first;
 *   · whatever is still left is money ahead on the account, said out loud.
 *
 * A PURCHASE is a bill and the corrections under it (0381): one box, one figure, paid together. The
 * cash goes on the members in order (the original first), the discount on the first member with
 * room, so every allocation row stays inside its bill and the purchase comes out paid in full.
 */

export const r2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export interface PurchaseMember {
  billId: string;
  /** amount − amount_paid on this member. Negative on a credit correction. */
  open: number;
}

export interface OpenPurchase {
  /** The original bill's id. */
  rootId: string;
  /** How the sheet names it: "8802-SO-257899 corrected by 8802-1109100". */
  label: string;
  /** The original's bill date, for oldest-first. */
  date: string | null;
  /** What is open on the whole purchase: Σ members' open. Listed only when over half a cent. */
  open: number;
  /** The original first, then its corrections by date. */
  members: PurchaseMember[];
  /** The supplier's prompt-pay discount still available on the day of the payment, or 0. */
  discount: number;
}

export interface AllocationRow {
  billId: string;
  amount: number;
  discount: number;
}

export interface AllocationPlan {
  rows: AllocationRow[];
  paidInFull: OpenPurchase[];
  partPaid: { purchase: OpenPurchase; paid: number; left: number } | null;
  /** Cash the plan could not put on any purchase: money ahead on the account. */
  ahead: number;
  /** Σ discount taken, so the sentence can say it. */
  discounts: number;
  /** Purchases outside the boxes the extra money reached (none without boxes). */
  spilled: OpenPurchase[];
  /** True when the discounts explained the shortfall. */
  tookDiscounts: boolean;
}

/** A bill as the planner needs it, whichever reader it came from. */
export interface PurchaseBillShape {
  id: string;
  amount: number;
  amountPaid: number | null | undefined;
  billDate: string | null;
  createdAt?: string | null;
  correctsBillId?: string | null;
}

/**
 * THE OPEN PURCHASES OF ONE ACCOUNT, OLDEST FIRST. A bill with no date sorts last: a paper nobody
 * dated is not the oldest thing he owes. A purchase whose members net to nothing (or to a credit) is
 * not open and is not listed; a credit nets inside its own purchase and nowhere else.
 */
export function openPurchasesOf(
  bills: readonly PurchaseBillShape[],
  labelOf: (root: PurchaseBillShape, corrections: PurchaseBillShape[]) => string,
  discountOf?: (rootId: string, memberIds: string[]) => number,
): OpenPurchase[] {
  const byId = new Map(bills.map((b) => [String(b.id), b]));
  const corrections = new Map<string, PurchaseBillShape[]>();
  const roots: PurchaseBillShape[] = [];
  for (const b of bills) {
    const root = b.correctsBillId ? String(b.correctsBillId) : null;
    if (root && byId.has(root)) corrections.set(root, [...(corrections.get(root) ?? []), b]);
    else roots.push(b);
  }
  const older = (x: PurchaseBillShape, y: PurchaseBillShape) =>
    (x.billDate ?? "9999") < (y.billDate ?? "9999") ? -1 : (x.billDate ?? "9999") > (y.billDate ?? "9999") ? 1 : String(x.createdAt ?? "").localeCompare(String(y.createdAt ?? ""));
  const openOf = (b: PurchaseBillShape) => r2((Number(b.amount) || 0) - (b.amountPaid == null ? 0 : Number(b.amountPaid) || 0));
  const out: OpenPurchase[] = [];
  for (const root of [...roots].sort(older)) {
    const kids = [...(corrections.get(String(root.id)) ?? [])].sort(older);
    const members = [root, ...kids].map((m) => ({ billId: String(m.id), open: openOf(m) }));
    const open = r2(members.reduce((s, m) => s + m.open, 0));
    if (open <= 0.005) continue;
    const ids = members.map((m) => m.billId);
    out.push({
      rootId: String(root.id),
      label: labelOf(root, kids),
      date: root.billDate ?? null,
      open,
      members,
      discount: r2(Math.max(0, discountOf?.(String(root.id), ids) ?? 0)),
    });
  }
  return out;
}

/**
 * THE PLAN. Boxes checked: those purchases oldest first, then — with money left — the others oldest
 * first. No boxes: a payment to the account, every open purchase oldest first. The last purchase the
 * money reaches may be part-paid; anything past the last purchase is ahead.
 *
 * THE DISCOUNT: taken only against boxes, and only when he paid the discounted total or less — a
 * payment of the full total takes none, and a payment between the two is read as full payments with
 * the last one short, never as a guess at which discount he meant.
 */
export function planPaymentAllocation(input: {
  amount: number;
  purchases: readonly OpenPurchase[];
  chosen?: readonly string[] | null;
}): AllocationPlan {
  const chosenIds = new Set((input.chosen ?? []).map(String));
  const chosen = input.purchases.filter((p) => chosenIds.has(p.rootId));
  const others = input.purchases.filter((p) => !chosenIds.has(p.rootId));
  const order = chosen.length ? [...chosen, ...others] : [...input.purchases];

  const chosenOpen = r2(chosen.reduce((s, p) => s + p.open, 0));
  const chosenDiscount = r2(chosen.reduce((s, p) => s + p.discount, 0));
  const amount = r2(Number(input.amount) || 0);
  const tookDiscounts = chosen.length > 0 && chosenDiscount > 0.005 && amount <= r2(chosenOpen - chosenDiscount) + 0.005;

  const rows: AllocationRow[] = [];
  const paidInFull: OpenPurchase[] = [];
  const spilled: OpenPurchase[] = [];
  let partPaid: AllocationPlan["partPaid"] = null;
  let discounts = 0;
  let left = amount;

  for (const p of order) {
    if (left <= 0.005) break;
    const discount = tookDiscounts && chosenIds.has(p.rootId) ? p.discount : 0;
    const need = r2(p.open - discount);
    const positive = p.members.filter((m) => m.open > 0.005);
    if (left >= need - 0.005) {
      let cashLeft = need;
      let discLeft = discount;
      for (const m of positive) {
        const d = r2(Math.min(discLeft, m.open));
        const cash = r2(Math.min(cashLeft, r2(m.open - d)));
        if (cash + d > 0.005) rows.push({ billId: m.billId, amount: cash, discount: d });
        cashLeft = r2(cashLeft - cash);
        discLeft = r2(discLeft - d);
      }
      discounts = r2(discounts + discount);
      left = r2(left - need);
      paidInFull.push(p);
      if (chosen.length && !chosenIds.has(p.rootId)) spilled.push(p);
      continue;
    }
    // THE LAST ONE, PART-PAID: his words. Cash only, no discount on a bill not paid in full.
    let cashLeft = left;
    for (const m of positive) {
      if (cashLeft <= 0.005) break;
      const cash = r2(Math.min(cashLeft, m.open));
      if (cash > 0.005) rows.push({ billId: m.billId, amount: cash, discount: 0 });
      cashLeft = r2(cashLeft - cash);
    }
    partPaid = { purchase: p, paid: r2(left - cashLeft), left: r2(p.open - (left - cashLeft)) };
    if (chosen.length && !chosenIds.has(p.rootId)) spilled.push(p);
    left = cashLeft;
    break;
  }

  return { rows, paidInFull, partPaid, ahead: r2(Math.max(0, left)), discounts, spilled, tookDiscounts };
}
