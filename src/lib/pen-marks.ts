import { formatCurrency } from "@/lib/utils";

/**
 * PEN MARKS ON A SUPPLIER'S PAPER (cn-v1181): the one rule for a line crossed out by hand, a
 * quantity changed by pen, and a mark nobody can be sure of.
 *
 * WHERE IT CAME FROM. The owner scanned delivery tickets he had marked up by hand, items crossed out
 * that went back to the supplier and quantities written over, and the readers had no rule for ink: on
 * some scans a struck line came in at $0 with the tax worked out again (so the bill was LOWER than the
 * supplier's paper and what is owed was wrong), on another the struck lines were charged in full (so
 * the customer would have been billed for goods that went back), and on one the struck lines were
 * dropped. His words (2026-11-22): "i am scanning redacted bills onto [a job] and it seems to be
 * picking up on the redactions on some and not others"; of the unused goods: "credits are being issued
 * for all un-used items have been returned"; and of a store receipt already paid: "there may or may
 * not be a return submitted but we probably dont need to account for it like a charge on an account
 * [...] so it just gets redacted".
 *
 * THE RULE, IN FOUR SENTENCES.
 *   1. The paper stays whole: every printed line at its PRINTED price, the printed tax, the printed
 *      total. Ink never lowers what the paper says, so what is owed to the supplier stays right.
 *   2. A line struck by hand comes off the CUSTOMER'S bill (billable false). A quantity changed by
 *      hand splits the line in two: what was kept, and what went back.
 *   3. HOW THE PAPER WAS PAID decides the rest. On account (or unknown): the struck goods are a
 *      RETURN the supplier owes a credit for; the line says so until the credit memo closes it. Paid
 *      at purchase (a store receipt): it just comes off the customer's bill; nothing is tracked.
 *   4. A mark that cannot be read for sure is never guessed: the line is held off the customer's bill
 *      and the bill asks, Kept or Returned.
 *
 * Pure, and no catalog: the cards that say these words are English today, and one vocabulary for
 * three screens (the tray, the bill, the job's costs) lives here so they cannot drift.
 */

export type PenMark = "struck" | "quantity" | "unclear";
export const PEN_MARKS: readonly PenMark[] = ["struck", "quantity", "unclear"];

export function penMarkOf(x: unknown): PenMark | null {
  const s = String(x ?? "").trim().toLowerCase();
  return (PEN_MARKS as readonly string[]).includes(s) ? (s as PenMark) : null;
}

/** The fields of a paper's line this rule reads and writes (a paper's line is jsonb in the tray). */
export type PenLine = {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  billable: boolean;
  /** What the reader saw written by hand on this line. `unclear` IS the open question. */
  pen?: PenMark;
  /** Crossed out or sent back: it comes off the customer's bill. Explicit once read or answered. */
  returned?: boolean;
};

const cents = (n: number) => Math.round(n * 100) / 100;
const qty = (n: number) => Math.round(n * 10000) / 10000;

/**
 * ONE CLEANED LINE AND WHAT THE READER SAID OF IT, as the line or lines the paper holds.
 *
 * IDEMPOTENT ON A STORED LINE. A tray paper's lines are read back through cleanLines when it is filed
 * and again after an Undo; a line already split or answered carries an explicit `returned` and no
 * `hand_quantity`, and passes through exactly as it is. An unanswered `unclear` line stays unclear.
 */
export function applyPenMark<T extends PenLine>(line: T, raw: { pen?: unknown; hand_quantity?: unknown; returned?: unknown } | null | undefined): T[] {
  const pen = penMarkOf(raw?.pen);
  const mark = pen ? { pen } : {};
  // STORED OR ANSWERED: an explicit boolean wins, the way a stored `billable` wins in cleanLines.
  if (typeof raw?.returned === "boolean" && pen !== "unclear") {
    return [{ ...line, ...mark, returned: raw.returned, billable: raw.returned ? false : line.billable }];
  }
  if (!pen) return [line];
  const held = (): T[] => [{ ...line, pen: "unclear", billable: false }];
  if (pen === "unclear") return held();
  if (pen === "struck") return [{ ...line, pen, returned: true, billable: false }];
  // A QUANTITY CHANGED BY HAND: the handwritten number is what was KEPT.
  const given = raw?.hand_quantity;
  const h = given === null || given === undefined || given === "" ? NaN : Number(given);
  const q = Number(line.quantity);
  if (!Number.isFinite(h) || !Number.isFinite(q) || h < 0 || h >= q) return held();
  if (h === 0) return [{ ...line, pen: "struck", returned: true, billable: false }];
  // The PRINTED extension is split by the share kept (never quantity times price: a supply house
  // prices per hundred and per thousand, and the extension is the price). Cent-exact: the two halves
  // always add back to the printed line.
  const keptAmount = cents((Number(line.amount) * h) / q);
  const backAmount = cents(Number(line.amount) - keptAmount);
  return [
    { ...line, pen, quantity: qty(h), amount: keptAmount, returned: false },
    { ...line, pen, quantity: qty(q - h), amount: backAmount, returned: true, billable: false },
  ];
}

export type PenSummary = {
  /** Lines read as crossed out. */
  struck: number;
  /** Quantities read as changed by hand (one per change, however the line was split). */
  quantity: number;
  /** Marks nobody could be sure of: each is a question still open. */
  unclear: number;
  /** Lines that come off the customer's bill for a pen mark, and their printed dollars before tax. */
  returnedLines: number;
  returnedAmount: number;
  any: boolean;
};

export function penSummary(lines: readonly { pen?: unknown; returned?: unknown; amount?: unknown }[] | null | undefined): PenSummary {
  const s: PenSummary = { struck: 0, quantity: 0, unclear: 0, returnedLines: 0, returnedAmount: 0, any: false };
  for (const l of lines ?? []) {
    const pen = penMarkOf(l?.pen);
    if (pen === "struck") s.struck += 1;
    else if (pen === "unclear") s.unclear += 1;
    // A changed quantity is two lines; its returned half is the one counted.
    else if (pen === "quantity" && l?.returned === true) s.quantity += 1;
    if (l?.returned === true) {
      s.returnedLines += 1;
      s.returnedAmount += Math.abs(Number(l?.amount) || 0);
    }
  }
  s.returnedAmount = cents(s.returnedAmount);
  s.any = s.struck + s.quantity + s.unclear + s.returnedLines > 0;
  return s;
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * WHAT THE BILL SAYS IT READ, so a person can confirm it (the owner asked for exactly this: a reader
 * that acts on ink has to say what ink it saw). English: the tray, the bill card and the job's costs
 * are English today. Null when there is nothing to say.
 *
 * `comesOff`: the dollars leaving the customer's bill, tax share included (the caller's own reading,
 * lib/bill-itemisation excludedReceiptCost); absent, the returned lines' printed dollars before tax.
 * `handTotal` / `keptTotal`: a total written by hand on the paper, and what the lines read as kept
 * come to; said only when both are known.
 */
export function penSentence(
  s: PenSummary,
  o: { creditExpected: boolean; comesOff?: number | null; handTotal?: number | null; keptTotal?: number | null },
): string | null {
  if (!s.any) return null;
  const read = [
    s.struck ? n(s.struck, "line crossed out", "lines crossed out") : "",
    s.quantity ? n(s.quantity, "quantity changed", "quantities changed") : "",
  ].filter(Boolean);
  const out: string[] = [];
  if (read.length) out.push(`Pen marks read: ${read.join(", ")}.`);
  if (s.returnedLines > 0) {
    const off = formatCurrency(o.comesOff != null && Number.isFinite(Number(o.comesOff)) ? Math.abs(Number(o.comesOff)) : s.returnedAmount);
    out.push(
      o.creditExpected
        ? `${off} is marked returned: off the customer's bill, with a credit expected from the supplier.`
        : `${off} comes off the customer's bill.`,
    );
  }
  if (read.length || s.returnedLines > 0) out.push("The total is kept as printed.");
  if (s.unclear > 0) {
    out.push(
      `${n(s.unclear, "pen mark", "pen marks")} couldn't be read for sure: ${s.unclear === 1 ? "that line is" : "those lines are"} held off the customer's bill until you answer Kept or Returned.`,
    );
  }
  const hand = o.handTotal;
  const kept = o.keptTotal;
  if (hand != null && kept != null && Number.isFinite(Number(hand)) && Number.isFinite(Number(kept))) {
    out.push(
      Math.abs(Number(hand) - Number(kept)) <= 1
        ? "That matches your handwritten total."
        : `Your handwritten total says ${formatCurrency(Number(hand))}; the lines read as kept come to ${formatCurrency(Number(kept))}.`,
    );
  }
  return out.join(" ");
}

/** The one vocabulary. Anything clickable is Title Case. */
export const PEN_WORDS = {
  kept: "Kept",
  returned: "Returned",
  crossedOut: "Crossed Out",
  /** A line's face on a paper bought on account, before and after its credit memo. */
  creditExpected: "Returned · Credit Expected",
  creditReceived: "Returned · Credit Received",
  /** A line's face on a receipt paid at purchase. */
  crossedOutNotBilled: "Crossed Out · Not Billed",
  /** The open question on a line. */
  needsAnswer: "Pen Mark: Kept or Returned?",
} as const;

/**
 * IS A CREDIT EXPECTED FOR WHAT WENT BACK? One answer for the door that writes a bill and the doors
 * that change a line on it later. What the PAPER said about tender wins when there is a paper
 * ("paid_at_purchase" is the only "no": on account and unknown are both owed, as this app files
 * them). A bill with no paper (typed by hand) is read from the bill: paid with no supplier account is
 * a counter sale already settled; anything else is on account. Never from "is it paid NOW": an account
 * bill settled on a statement last week is still owed its credit.
 */
export function creditExpectedOf(o: { paperPayment?: string | null; billStatus?: string | null; hasSupplierAccount?: boolean | null }): boolean {
  const said = String(o.paperPayment ?? "").trim();
  if (said) return said !== "paid_at_purchase";
  return !(String(o.billStatus ?? "") === "paid" && !o.hasSupplierAccount);
}

/**
 * A PAPER'S LINE, AS ITS BILL'S LINE HOLDS IT (bill_line_items.pen_mark / returned / billable, 0417).
 *
 * `creditExpected`: the paper was NOT paid at purchase (on account, or unknown, which this app files
 * as owed). Then a returned line is a credit the supplier owes, tracked on the line until the credit
 * memo closes it. On a receipt paid at purchase it only comes off the customer's bill.
 */
export function penColumns(
  line: { pen?: unknown; returned?: unknown; billable?: unknown },
  creditExpected: boolean,
): { pen_mark: PenMark | null; returned: boolean; billable: boolean } {
  const pen = penMarkOf(line.pen);
  const back = line.returned === true;
  return {
    pen_mark: pen,
    returned: creditExpected && back,
    billable: back || pen === "unclear" ? false : line.billable !== false,
  };
}

/** The other way, for an Undo: a bill's line back onto its paper, keeping what a person answered. */
export function penFromColumns(row: { pen_mark?: unknown; returned?: unknown; billable?: unknown }): { pen?: PenMark; returned?: boolean } {
  const pen = penMarkOf(row.pen_mark);
  if (pen === "unclear") return { pen };
  if (row.returned === true) return { ...(pen ? { pen } : {}), returned: true };
  // A marked line with no credit tracked (a receipt paid at purchase): off the bill is "returned" on
  // the paper; switched back on by a person is "kept".
  if (pen) return { pen, returned: row.billable === false };
  return {};
}
