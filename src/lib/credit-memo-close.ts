import { formatCurrency } from "@/lib/utils";
import { lineWords } from "@/lib/bill-correction";
import { sameItem } from "@/lib/supplier-returns";

/**
 * A SUPPLIER'S CREDIT MEMO CLOSES WHAT IT RETURNS (cn-v1181): THE PAIRING RULE, PURE.
 *
 * WHY. A credit memo could not be filed from the tray; pushed through Fix Details it became a loose
 * negative bill on the job, and the customer's next invoice listed the purchase and then
 * "Returned:" lines under it. The owner's words (2026-11-22): "so i thought returns werent going to
 * show up on the invoice". Goods that went back should not show on the customer's invoice at all,
 * unless the customer was ALREADY billed for them (then the credit is the customer's, as today).
 *
 * THE RULE. The memo is filed as a correction UNDER the bill it reverses (0381, the correction door's
 * own write). Then each of the memo's lines is paired with ONE line of that bill:
 *   (1) an OPEN returned line (returned, no credit memo yet) of the same item and the same amount to
 *       the cent: the memo closes it;
 *   (2) else, when no invoice that has gone out bills the purchase, a line that still bills, of the
 *       same item: the WHOLE line when the amounts agree to the cent, else, when the memo returns
 *       part of the line at the line's own price, the line SPLIT cent-exact into kept and returned;
 *       a line with a part-used amount or shop stock taken from it is never split or closed;
 *   (3) else the memo's line stays as the correction door writes it, credited to the customer as
 *       today, and the result says which lines.
 * A line closed in (1) or (2) is off the customer's bill on BOTH sides: the purchase line bills
 * nothing and the memo's own line credits nothing. Tax lines ride with what they tax (the
 * itemisation's own rule); a positive line (a restocking fee) is the company's cost and said.
 *
 * Words are compared the way the return path compares them: whole words, one description holding
 * the other, at least two words (lib/supplier-returns `sameItem`, the one function both doors ask). Money is whole cents; float noise never decides a pair.
 */

const toCents = (n: unknown): number => Math.round((Number(n) || 0) * 100);
const fromCents = (c: number): number => c / 100;
const qty4 = (n: number) => Math.round(n * 10000) / 10000;

/** The same part read off two papers: lib/supplier-returns `sameItem` itself, one rule for both
 *  doors (the return path and the credit memo), never a copy. */
export const sameItemWords: (a: string, b: string) => boolean = sameItem;

/** One of the memo's own lines, as the tray holds it (a credit memo's lines are negative). */
export type MemoLine = { description?: string | null; quantity?: unknown; amount?: unknown; category?: string | null };

/** One line of the bill the memo reverses, as bill_line_items holds it (with 0417's columns). */
export type PurchaseLine = {
  id: string;
  description?: string | null;
  quantity?: unknown;
  unit_price?: unknown;
  amount?: unknown;
  category?: string | null;
  billable?: boolean | null;
  billed_amount?: unknown;
  is_stock?: boolean | null;
  returned?: boolean | null;
  returned_credit_bill_id?: string | null;
  sort_order?: number | null;
};

const TAX_WORDS = /^(sales\s+)?tax\b/i;
/** A tax line: by the category the receipt reader stores (the itemisation's own test), or by the
 *  words a supplier prints for it. */
export function isTaxish(l: { category?: string | null; description?: string | null }): boolean {
  return /tax/i.test(String(l.category ?? "")) || TAX_WORDS.test(String(l.description ?? "").trim());
}

export type Pairing =
  | { kind: "closeReturned"; memoIndex: number; line: PurchaseLine }
  | { kind: "closeWhole"; memoIndex: number; line: PurchaseLine }
  | {
      kind: "split";
      memoIndex: number;
      line: PurchaseLine;
      /** What stays on the bill line: the rest of the printed extension. */
      kept: { quantity: number; amount: number };
      /** The new returned line, right after it: exactly what the memo credits. */
      back: { quantity: number; amount: number };
    }
  /** Same item, but it stays: the customer was billed (`invoiced`), or nothing on the line fits. */
  | { kind: "stays"; memoIndex: number; line: PurchaseLine; why: "invoiced" | "noFit" }
  | { kind: "tax"; memoIndex: number; line: PurchaseLine | null }
  | { kind: "fee"; memoIndex: number }
  | { kind: "zero"; memoIndex: number }
  /** No line on the bill carries these words: the correction door cannot write it under this bill. */
  | { kind: "unmatched"; memoIndex: number };

export const CLOSES = new Set<Pairing["kind"]>(["closeReturned", "closeWhole", "split"]);

const isOpenReturned = (l: PurchaseLine) => l.returned === true && !l.returned_credit_bill_id;
/** A line that still bills and can be closed whole or split: nothing part-used, no shop stock. */
const canClose = (l: PurchaseLine) =>
  l.billable !== false &&
  l.returned !== true &&
  !l.returned_credit_bill_id &&
  (l.billed_amount === null || l.billed_amount === undefined || l.billed_amount === "") &&
  l.is_stock !== true &&
  toCents(l.amount) > 0;

const bySort = (a: PurchaseLine, b: PurchaseLine) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) || String(a.id).localeCompare(String(b.id));

/**
 * PAIR EACH MEMO LINE WITH ONE LINE OF THE BILL. `invoiced`: an invoice that has gone out to the
 * customer (not void, not a draft) already bills this purchase, so rule (2) does not apply.
 * Open returned lines are paired first across the whole memo, then lines that still bill, so a
 * memo for goods already marked returned never splits a line that is still billed.
 */
export function pairCreditMemo(memo: readonly MemoLine[], lines: readonly PurchaseLine[], o: { invoiced: boolean }): Pairing[] {
  const sorted = [...lines].sort(bySort);
  const items = sorted.filter((l) => !isTaxish(l));
  const taxLine = sorted.find((l) => isTaxish(l)) ?? null;
  const used = new Set<string>();
  const out: (Pairing | null)[] = memo.map(() => null);
  const words = memo.map((m) => lineWords(m.description));
  const size = memo.map((m) => -toCents(m.amount));
  const credit = memo.map((m, i) => !isTaxish(m) && size[i] > 0);

  memo.forEach((m, i) => {
    if (isTaxish(m)) out[i] = { kind: "tax", memoIndex: i, line: taxLine };
    else if (toCents(m.amount) > 0) out[i] = { kind: "fee", memoIndex: i };
    else if (toCents(m.amount) === 0) out[i] = { kind: "zero", memoIndex: i };
  });

  // (1) OPEN RETURNED LINES FIRST: same item, same amount to the cent. This rule does NOT look at
  // `invoiced`, on purpose (skeptic #84 proposed it; the planner kept it): a line that was already off
  // the bill when an invoice went out was never billed to the customer, so its credit must still close
  // here and credit the customer nothing. What makes that safe is the doors: a line a SENT invoice
  // already bills can never be marked Returned afterwards (setReceiptLineReturned and
  // setReceiptLineBillable refuse while one claims the bill, lib/bill-claimants), so an open returned
  // line on an invoiced bill is always one that went back before the invoice billed anything.
  memo.forEach((_, i) => {
    if (!credit[i] || out[i]) return;
    const hit = items.find((l) => !used.has(l.id) && isOpenReturned(l) && toCents(l.amount) === size[i] && sameItemWords(words[i], lineWords(l.description)));
    if (hit) {
      used.add(hit.id);
      out[i] = { kind: "closeReturned", memoIndex: i, line: hit };
    }
  });

  // (2) LINES THAT STILL BILL, only while no invoice that has gone out bills the purchase.
  if (!o.invoiced) {
    // The whole line first, for every memo line, so a split never takes a line a whole match needed.
    memo.forEach((_, i) => {
      if (!credit[i] || out[i]) return;
      const hit = items.find((l) => !used.has(l.id) && canClose(l) && toCents(l.amount) === size[i] && sameItemWords(words[i], lineWords(l.description)));
      if (hit) {
        used.add(hit.id);
        out[i] = { kind: "closeWhole", memoIndex: i, line: hit };
      }
    });
    memo.forEach((m, i) => {
      if (!credit[i] || out[i]) return;
      const qm = Math.abs(Number(m.quantity));
      if (!Number.isFinite(qm) || qm <= 0) return;
      const hit = items.find((l) => {
        if (used.has(l.id) || !canClose(l) || !sameItemWords(words[i], lineWords(l.description))) return false;
        const qb = Number(l.quantity);
        if (!Number.isFinite(qb) || qm >= qb) return false;
        // PART OF THE LINE, AT THE LINE'S OWN PRICE (within a cent of rounding): the printed
        // extension's share for the quantity returned.
        const share = Math.round((toCents(l.amount) * qm) / qb);
        return Math.abs(share - size[i]) <= 1 && size[i] < toCents(l.amount);
      });
      if (hit) {
        used.add(hit.id);
        const qb = Number(hit.quantity);
        out[i] = {
          kind: "split",
          memoIndex: i,
          line: hit,
          kept: { quantity: qty4(qb - qm), amount: fromCents(toCents(hit.amount) - size[i]) },
          back: { quantity: qty4(qm), amount: fromCents(size[i]) },
        };
      }
    });
  }

  // (3) WHAT STAYS: the same item on the bill, credited to the customer as today.
  memo.forEach((_, i) => {
    if (out[i]) return;
    const same = items.filter((l) => sameItemWords(words[i], lineWords(l.description)));
    const line = same.find((l) => !used.has(l.id)) ?? same[0];
    if (!line) {
      out[i] = { kind: "unmatched", memoIndex: i };
      return;
    }
    const wouldFit = same.some((l) => canClose(l) && toCents(l.amount) >= size[i]);
    out[i] = { kind: "stays", memoIndex: i, line, why: o.invoiced && wouldFit ? "invoiced" : "noFit" };
  });
  return out as Pairing[];
}

/** How well one bill answers a memo: lines it would close, and how many of those were open returns. */
export function memoScore(memo: readonly MemoLine[], lines: readonly PurchaseLine[]): { closes: number; open: number } {
  const p = pairCreditMemo(memo, lines, { invoiced: false });
  return { closes: p.filter((x) => CLOSES.has(x.kind)).length, open: p.filter((x) => x.kind === "closeReturned").length };
}

/**
 * THE BILL A MEMO NAMES BEST, among the supplier's purchases: the most lines it would close, open
 * returns weighing first. Exactly one best: it. Several equal: all of them, for a person to pick.
 * None closes anything: none.
 */
export function bestHomes<B>(memo: readonly MemoLine[], bills: readonly { bill: B; lines: readonly PurchaseLine[] }[]): B[] {
  const scored = bills.map((b) => ({ b: b.bill, s: memoScore(memo, b.lines) })).filter((x) => x.s.closes > 0);
  if (!scored.length) return [];
  const top = Math.max(...scored.map((x) => x.s.closes));
  const atTop = scored.filter((x) => x.s.closes === top);
  const open = Math.max(...atTop.map((x) => x.s.open));
  return atTop.filter((x) => x.s.open === open).map((x) => x.b);
}

/**
 * THE LINES THE CORRECTION DOOR IS HANDED (planBillCorrection): each credit carries the words of the
 * bill line it pairs with (the door refuses a credit naming no line of the purchase), a fee keeps its
 * own words, a $0 line is left out. `sortOf[k]` is the memo index of the k-th line handed over: the
 * door writes sort_order = k. `offBill` are the sort orders written billable = false after.
 */
export function correctionInput(
  memo: readonly MemoLine[],
  pairs: readonly Pairing[],
): { lines: { description: string; amount: number }[]; sortOf: number[]; offBill: number[] } {
  const lines: { description: string; amount: number }[] = [];
  const sortOf: number[] = [];
  const offBill: number[] = [];
  for (const p of pairs) {
    if (p.kind === "zero" || p.kind === "unmatched") continue;
    const m = memo[p.memoIndex];
    const description =
      p.kind === "fee" ? String(m.description ?? "").trim() : p.kind === "tax" ? String(p.line?.description ?? m.description ?? "").trim() : String(p.line.description ?? "").trim();
    if (CLOSES.has(p.kind) || p.kind === "fee") offBill.push(lines.length);
    sortOf.push(p.memoIndex);
    lines.push({ description, amount: fromCents(toCents(m.amount)) });
  }
  return { lines, sortOf, offBill };
}

/**
 * THE BILL'S LINE ORDER AFTER THE SPLITS: every line keeps its place and each returned half sits
 * right after the line it came from. Returns the new sort_order of each existing line that moves,
 * and the sort_order each split's returned half takes (by the split line's id).
 */
export function orderAfterSplits(lines: readonly PurchaseLine[], splitIds: readonly string[]): { moves: Map<string, number>; halves: Map<string, number> } {
  const split = new Set(splitIds);
  const moves = new Map<string, number>();
  const halves = new Map<string, number>();
  let k = 0;
  for (const l of [...lines].sort(bySort)) {
    if (Number(l.sort_order ?? 0) !== k) moves.set(l.id, k);
    k += 1;
    if (split.has(l.id)) {
      halves.set(l.id, k);
      k += 1;
    }
  }
  return { moves, halves };
}

/** The lines the memo's total and its lines disagree by, in cents (0 = they agree). */
export function memoGapCents(total: unknown, memo: readonly MemoLine[]): number {
  return toCents(total) - memo.reduce((s, m) => s + toCents(m.amount), 0);
}

/**
 * WHAT THE DOOR SAYS ONCE THE MEMO IS FILED. English: the tray is English today.
 */
export function creditMemoSentence(o: {
  memoNumber: string;
  billWords: string;
  memoTotal: number;
  memo: readonly MemoLine[];
  pairs: readonly Pairing[];
  /** Pairs whose closing write did not land: said, and their memo lines left crediting as today. */
  notClosed?: readonly number[];
}): string {
  const desc = (i: number) => String(o.memo[i]?.description ?? "").trim() || "a line";
  const failed = new Set(o.notClosed ?? []);
  const closed = o.pairs.filter((p) => CLOSES.has(p.kind) && !failed.has(p.memoIndex));
  const parts = o.pairs.filter((p) => p.kind === "split" && !failed.has(p.memoIndex));
  const stays = o.pairs.filter((p) => p.kind === "stays" || (CLOSES.has(p.kind) && failed.has(p.memoIndex)));
  const fees = o.pairs.filter((p) => p.kind === "fee");
  const out: string[] = [`${o.memoNumber} is filed under ${o.billWords}: ${formatCurrency(Math.abs(o.memoTotal))} back from the supplier.`];
  if (closed.length) {
    out.push(
      `${closed.length === 1 ? "1 returned line is" : `${closed.length} returned lines are`} closed (${closed.map((p) => desc(p.memoIndex)).join("; ")}): off the customer's bill, credit received.`,
    );
  }
  for (const p of parts) {
    if (p.kind !== "split") continue;
    out.push(`${String(p.line.description ?? "").trim()} was split: ${p.kept.quantity} kept (${formatCurrency(p.kept.amount)}), ${p.back.quantity} returned (${formatCurrency(p.back.amount)}).`);
  }
  if (stays.length) {
    const invoiced = stays.some((p) => p.kind === "stays" && p.why === "invoiced");
    out.push(
      `${stays.map((p) => desc(p.memoIndex)).join("; ")} ${stays.length === 1 ? "stays" : "stay"} a credit to the customer, as before${invoiced ? ": an invoice that went out already billed it" : ""}.`,
    );
  }
  if (fees.length) {
    const fee = fees.reduce((s, p) => s + toCents(o.memo[p.memoIndex]?.amount), 0);
    out.push(`${fees.map((p) => desc(p.memoIndex)).join("; ")} (${formatCurrency(fromCents(fee))}) is the company's cost, not billed to the customer.`);
  }
  return out.join(" ");
}
