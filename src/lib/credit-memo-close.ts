import { formatCurrency } from "@/lib/utils";
import { lineWords } from "@/lib/bill-correction";
import { sameItem } from "@/lib/supplier-returns";
import { excludedReceiptCost } from "@/lib/bill-itemisation";

/**
 * A SUPPLIER'S CREDIT MEMO CLOSES WHAT IT RETURNS (cn-v1181): THE PAIRING RULE, PURE.
 *
 * WHY. A credit memo could not be filed from the tray; pushed through Fix Details it became a loose
 * negative bill on the job, and the customer's next invoice listed the purchase and then
 * "Returned:" lines under it. The owner's words (2026-11-22): "so i thought returns werent going to
 * show up on the invoice". Goods that went back should not show on the customer's invoice at all,
 * unless the customer was ALREADY billed for them (then the credit is the customer's, as today).
 *
 * THE RULE (THE TRAY'S ROAD, cn-v1181). A memo still waiting in the tray is filed as a correction
 * UNDER the bill it reverses (0381, the correction door's own write). Then each of the memo's lines is
 * paired with ONE line of that bill:
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
 * THE ROW'S ROAD (cn-v1184). A credit already recorded on a job (a bill of its own below zero) is
 * NEVER filed under one bill: a return slip often covers goods from several invoices. The row's door
 * closes its lines across the job's bills (pairCreditAcrossBills below, built from this same pairing)
 * and the credit stays a bill of its own.
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

// ── cn-v1184: ONE CREDIT, SEVERAL BILLS ON ITS JOB ───────────────────────────────────────────────

/**
 * A RETURN SLIP OFTEN COVERS GOODS FROM SEVERAL INVOICES ON ONE JOB (the owner's papers, 2026-11-22:
 * two of his four slips did). So a credit recorded on a job is never attached under ONE bill: it stays
 * a bill of its own, and what it returns is closed on whichever of the job's bills carry those lines.
 *
 * Built ONLY from `pairCreditMemo`, per bill, in three passes over the bills in a fixed order (bill
 * date, then id), each pass over the credit lines not yet paired and the bill lines not yet used:
 *   (1) open returns first, on EVERY bill (as `pairCreditMemo` asks them, whatever went out);
 *   (2) whole lines, only on bills no invoice that went out holds;
 *   (3) splits, only on those bills.
 * What is left: `tax` (it needs no bill line: tax rides with what it taxes on both papers), `fee` (a
 * positive line), `zero`, else `stays`: "invoiced" when a bill an invoice that went out holds would
 * have taken it, "noMatch" when no line of the job's bills carries its words, else "noFit".
 * A one-bill credit pairs exactly as `pairCreditMemo` pairs it.
 */
export type ReturnBill = { id: string; bill_date?: string | null; invoiced: boolean; lines: readonly PurchaseLine[] };

export type BillPairing =
  | { kind: "closeReturned" | "closeWhole"; memoIndex: number; billId: string; line: PurchaseLine }
  /** cn-v1184 fixer (skeptic #86, S2): a line THIS credit already closed on a bill, while the credit's
   *  own line still bills (a write that failed, or its Bill switch turned back on). Nothing on the bill
   *  is written; the credit's line comes off again. Only when the caller names the credit (`creditId`). */
  | { kind: "closedBefore"; memoIndex: number; billId: string; line: PurchaseLine }
  | { kind: "split"; memoIndex: number; billId: string; line: PurchaseLine; kept: { quantity: number; amount: number }; back: { quantity: number; amount: number } }
  | { kind: "stays"; memoIndex: number; why: "invoiced" | "noFit" | "noMatch" }
  | { kind: "tax"; memoIndex: number }
  | { kind: "fee"; memoIndex: number }
  | { kind: "zero"; memoIndex: number };

export function pairCreditAcrossBills(memo: readonly MemoLine[], bills: readonly ReturnBill[], o: { creditId?: string } = {}): BillPairing[] {
  const ordered = [...bills].sort((a, b) => String(a.bill_date ?? "").localeCompare(String(b.bill_date ?? "")) || String(a.id).localeCompare(String(b.id)));
  const out: (BillPairing | null)[] = memo.map(() => null);
  const used = new Set<string>();
  memo.forEach((m, i) => {
    if (isTaxish(m)) out[i] = { kind: "tax", memoIndex: i };
    else if (toCents(m.amount) > 0) out[i] = { kind: "fee", memoIndex: i };
    else if (toCents(m.amount) === 0) out[i] = { kind: "zero", memoIndex: i };
  });
  // (0) LINES THIS CREDIT ALREADY CLOSED (skeptic #86, S2): a bill line that names this credit, of the
  // same item and the same amount to the cent, each bill line used once. Nothing on the bill moves.
  if (o.creditId) {
    memo.forEach((m, i) => {
      if (out[i]) return;
      const words = lineWords(m.description);
      for (const b of ordered) {
        const hit = b.lines.find(
          (l) =>
            !used.has(String(l.id)) &&
            l.returned_credit_bill_id === o.creditId &&
            !isTaxish(l) &&
            toCents(l.amount) === -toCents(m.amount) &&
            sameItemWords(words, lineWords(l.description)),
        );
        if (hit) {
          used.add(String(hit.id));
          out[i] = { kind: "closedBefore", memoIndex: i, billId: b.id, line: hit };
          return;
        }
      }
    });
  }
  const pass = (take: ReadonlySet<Pairing["kind"]>, invoiced: boolean, only: (b: ReturnBill) => boolean) => {
    for (const b of ordered) {
      if (!only(b)) continue;
      const open = memo.map((_, i) => i).filter((i) => !out[i]);
      if (!open.length) return;
      const lines = b.lines.filter((l) => !used.has(String(l.id)));
      for (const p of pairCreditMemo(open.map((i) => memo[i]), lines, { invoiced })) {
        if (!take.has(p.kind) || !("line" in p) || !p.line) continue;
        const i = open[p.memoIndex];
        used.add(String(p.line.id));
        out[i] = { ...(p as Extract<Pairing, { kind: "closeReturned" | "closeWhole" | "split" }>), memoIndex: i, billId: b.id };
      }
    }
  };
  pass(new Set(["closeReturned"]), true, () => true);
  pass(new Set(["closeReturned", "closeWhole"]), false, (b) => !b.invoiced);
  pass(new Set(["split"]), false, (b) => !b.invoiced);
  memo.forEach((m, i) => {
    if (out[i]) return;
    const words = lineWords(m.description);
    const carries = ordered.some((b) => b.lines.some((l) => !isTaxish(l) && sameItemWords(words, lineWords(l.description))));
    if (!carries) {
      out[i] = { kind: "stays", memoIndex: i, why: "noMatch" };
      return;
    }
    const wouldHave = ordered.some(
      (b) => b.invoiced && pairCreditMemo([m], b.lines.filter((l) => !used.has(String(l.id))), { invoiced: true }).some((p) => p.kind === "stays" && p.why === "invoiced"),
    );
    out[i] = { kind: "stays", memoIndex: i, why: wouldHave ? "invoiced" : "noFit" };
  });
  return out as BillPairing[];
}

/** "T-543", "T-543 and T-576", "T-543, T-576 and T-677". */
export function andList(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * WHAT THE DOOR SAYS ONCE A CREDIT ON A JOB IS FILED WITH ITS BILLS: what closed and where, each
 * split, what stays and why, the fees. `notClosed`: pairs whose closing write did not land (said, and
 * their credit lines left crediting as before). `billWords`: each bill's number as it is shown.
 */
export function creditAcrossBillsSentence(o: {
  creditWords: string;
  creditTotal: number;
  memo: readonly MemoLine[];
  pairs: readonly BillPairing[];
  billWords: ReadonlyMap<string, string>;
  notClosed?: readonly number[];
}): string {
  const desc = (i: number) => String(o.memo[i]?.description ?? "").trim() || "a line";
  const failed = new Set(o.notClosed ?? []);
  const closing = o.pairs.filter((p) => CLOSES.has(p.kind as Pairing["kind"]));
  const closed = closing.filter((p) => !failed.has(p.memoIndex)) as Extract<BillPairing, { billId: string }>[];
  const out: string[] = [`${o.creditWords}: ${formatCurrency(Math.abs(o.creditTotal))} back from the supplier.`];
  if (closed.length) {
    const where = andList(Array.from(new Set(closed.map((p) => o.billWords.get(p.billId) ?? "that bill"))));
    out.push(
      `${closed.length === 1 ? "1 returned line is" : `${closed.length} returned lines are`} closed on ${where} (${closed.map((p) => desc(p.memoIndex)).join("; ")}): off the customer's bill, credit received.`,
    );
  }
  for (const p of closed) {
    if (p.kind !== "split") continue;
    out.push(`${String(p.line.description ?? "").trim()} was split: ${p.kept.quantity} kept (${formatCurrency(p.kept.amount)}), ${p.back.quantity} returned (${formatCurrency(p.back.amount)}).`);
  }
  const lost = closing.filter((p) => failed.has(p.memoIndex));
  if (lost.length) {
    out.push(`${lost.map((p) => desc(p.memoIndex)).join("; ")} changed on the bill just now, so ${lost.length === 1 ? "it was" : "they were"} not closed.`);
  }
  const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const invoiced = o.pairs.filter((p) => p.kind === "stays" && p.why === "invoiced");
  if (invoiced.length) out.push(`${invoiced.map((p) => desc(p.memoIndex)).join("; ")} ${verb(invoiced.length, "stays", "stay")} a credit to the customer, as before: an invoice that went out already billed it.`);
  const noMatch = o.pairs.filter((p) => p.kind === "stays" && p.why === "noMatch");
  if (noMatch.length) {
    out.push(`${noMatch.map((p) => desc(p.memoIndex)).join("; ")} matched no line on this job's bills, so ${verb(noMatch.length, "it stays", "they stay")} a credit to the customer, as before.`);
  }
  const noFit = [...o.pairs.filter((p) => p.kind === "stays" && p.why === "noFit"), ...lost];
  if (noFit.length) out.push(`${noFit.map((p) => desc(p.memoIndex)).join("; ")} ${verb(noFit.length, "stays", "stay")} a credit to the customer, as before.`);
  const fees = o.pairs.filter((p) => p.kind === "fee");
  if (fees.length) {
    const fee = fees.reduce((s, p) => s + toCents(o.memo[p.memoIndex]?.amount), 0);
    out.push(`${fees.map((p) => desc(p.memoIndex)).join("; ")} (${formatCurrency(fromCents(fee))}) ${verb(fees.length, "is", "are")} the company's cost, not billed to the customer.`);
  }
  return out.join(" ");
}

// ── cn-v1184 fixer (skeptic #86, S1 + S13): FILING NEVER CHANGES WHAT THE CUSTOMER PAYS IN TAX ─────

/**
 * Closing a line that STILL BILLED moves tax on both papers: the credit's own tax line credits less
 * (its share for the part lines that come off), and each bill closed on takes its own share of its tax
 * off with the line (lib/bill-itemisation excludedReceiptCost, the one copy of that arithmetic). The
 * two must be the same money, or filing changes what the customer pays: a ticket with an untaxed line
 * (a delivery charge) takes off only half the tax the credit gave back; a tax line a person split by
 * hand takes off none of it.
 *   (a) the credit's tax for those lines = |Σ the credit's tax lines| × (the closing pairs' credit
 *       lines ÷ ALL the credit's part lines);
 *   (b) per bill closed on: excludedReceiptCost(lines after the closes) − excludedReceiptCost(lines
 *       now) − the dollars closed (a whole close: the line not billable; a split: the kept half bills,
 *       the returned half does not).
 * Only `closeWhole` and `split` are checked: `closeReturned` (and a line this credit closed before)
 * moves no money on the bill. Allowed: 2 cents plus 1 cent per bill closed on (each bill rounds its
 * tax once). All in whole cents.
 */
export type ReturnTaxVerdict =
  | { checked: false; ok: true }
  | { checked: true; ok: boolean; creditTaxCents: number; billsTaxCents: number; billIds: string[] };

export function returnTaxCheck(o: {
  /** EVERY line of the credit (its tax lines, and all its part lines, on the bill or off). */
  credit: readonly MemoLine[];
  /** The lines the pairs' memoIndex points into. */
  memo: readonly MemoLine[];
  pairs: readonly BillPairing[];
  bills: readonly { id: string; lines: readonly PurchaseLine[] }[];
}): ReturnTaxVerdict {
  type Moves = { kind: "closeWhole"; memoIndex: number; billId: string; line: PurchaseLine } | Extract<BillPairing, { kind: "split" }>;
  const closing = o.pairs.filter((p) => p.kind === "closeWhole" || p.kind === "split") as Moves[];
  if (!closing.length) return { checked: false, ok: true };
  const tax = Math.abs(o.credit.filter((l) => isTaxish(l)).reduce((s, l) => s + toCents(l.amount), 0));
  const allParts = o.credit.filter((l) => !isTaxish(l) && toCents(l.amount) < 0).reduce((s, l) => s - toCents(l.amount), 0);
  const closingSize = closing.reduce((s, p) => s + Math.abs(toCents(o.memo[p.memoIndex]?.amount)), 0);
  const creditTaxCents = allParts > 0 ? Math.round((tax * closingSize) / allParts) : 0;

  const billIds = Array.from(new Set(closing.map((p) => p.billId)));
  let billsTaxCents = 0;
  for (const id of billIds) {
    const now = [...(o.bills.find((b) => b.id === id)?.lines ?? [])];
    const mine = closing.filter((p) => p.billId === id);
    const after: PurchaseLine[] = [];
    let closedCents = 0;
    for (const l of now) {
      const p = mine.find((x) => String(x.line.id) === String(l.id));
      if (!p) after.push(l);
      else if (p.kind === "closeWhole") {
        after.push({ ...l, billable: false, returned: true });
        closedCents += toCents(l.amount);
      } else {
        after.push({ ...l, quantity: p.kept.quantity, amount: p.kept.amount });
        after.push({ ...l, id: `${l.id}:returned`, quantity: p.back.quantity, amount: p.back.amount, billable: false, returned: true });
        closedCents += toCents(p.back.amount);
      }
    }
    billsTaxCents += toCents(excludedReceiptCost(after)) - toCents(excludedReceiptCost(now)) - closedCents;
  }
  const ok = Math.abs(creditTaxCents - billsTaxCents) <= 2 + billIds.length;
  return { checked: true, ok, creditTaxCents, billsTaxCents, billIds };
}
