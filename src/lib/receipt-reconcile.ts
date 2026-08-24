/**
 * DOES THE RECEIPT ADD UP?
 *
 * The reader asks a model for two things off one photo: the grand total, and every line. It then
 * used the grand total and never once compared the two. A misread total — a subtotal, a prior
 * balance, "you saved $41.02", a transposed digit — became the bill's `amount` with the model's
 * own transcription sitting underneath it saying something different, and nothing anywhere looked.
 *
 * That number is not cosmetic. `bills.amount` is job cost, it is the actual side of
 * budget-vs-actual, and importCostsIntoInvoice marks it up and bills it to the homeowner. A
 * misread total gets marked up and charged.
 *
 * ── WHY THIS FLAGS RATHER THAN CORRECTS ────────────────────────────────────────────────────
 *
 * The printed grand total is the authority: it is what was actually paid, and it legitimately
 * exceeds the sum of the lines all the time — a delivery fee, a core charge, a line the model
 * couldn't read. Silently substituting the line sum would trade a rare wrong number for a
 * frequent one. So the total stands and the DISAGREEMENT is what gets surfaced, because a human
 * glancing at the photo settles it in two seconds and nothing else can.
 *
 * The asymmetry is deliberate. Lines summing BELOW the total is the ordinary case (tax, fees,
 * an unread line) and only a large gap is worth a word. Lines summing ABOVE the total is close to
 * impossible on a real receipt — it means a line was double-counted or the total was misread —
 * so that gets a tighter threshold and a blunter sentence.
 */

export type ReceiptLine = { description: string; amount: number };

export type Reconciliation = {
  /** What the bill should record — always the printed grand total when we have one. */
  amount: number;
  /** Sum of the transcribed lines. */
  lineSum: number;
  /** Signed: positive when the total exceeds the lines (the ordinary direction). */
  difference: number;
  /** True when the gap is big enough that a person should glance at the photo. */
  mismatch: boolean;
  /** One plain sentence for the bill's notes, or "" when everything reconciles. */
  note: string;
};

/** Below this, a gap is rounding or a single cheap unread item — not worth a word. */
const ABSOLUTE_FLOOR = 1;
/** Lines UNDER the total: ordinary (tax, delivery, an unread line). Only a big gap matters. */
const UNDER_TOLERANCE_PCT = 0.1;
/** Lines OVER the total: nearly impossible honestly, so almost any gap is a signal. */
const OVER_TOLERANCE_PCT = 0.02;

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

export function reconcileReceipt(total: number, lines: ReceiptLine[]): Reconciliation {
  const lineSum = Math.round(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0) * 100) / 100;
  const difference = Math.round((total - lineSum) * 100) / 100;
  const base = { amount: total, lineSum, difference };

  // No lines transcribed at all is a different situation — the reader already handles an
  // unreadable receipt, and "nothing to compare" is not a disagreement.
  if (!lines.length || lineSum === 0) return { ...base, mismatch: false, note: "" };
  if (Math.abs(difference) < ABSOLUTE_FLOOR) return { ...base, mismatch: false, note: "" };

  if (difference < 0) {
    // The lines add up to MORE than the receipt says was paid.
    const over = Math.abs(difference);
    if (over <= Math.abs(total) * OVER_TOLERANCE_PCT) return { ...base, mismatch: false, note: "" };
    return {
      ...base,
      mismatch: true,
      note:
        `CHECK THIS ONE: the items read off this receipt add up to ${money(lineSum)}, which is ` +
        `${money(over)} MORE than the ${money(total)} total. A line was probably counted twice, or ` +
        `the total was misread. The bill records ${money(total)} — open the photo and confirm.`,
    };
  }

  if (difference <= Math.abs(total) * UNDER_TOLERANCE_PCT) return { ...base, mismatch: false, note: "" };
  return {
    ...base,
    mismatch: true,
    note:
      `The items read off this receipt add up to ${money(lineSum)}, ${money(difference)} less than ` +
      `the ${money(total)} total. That is normal if there's tax, delivery or a line we couldn't ` +
      `read — the bill records ${money(total)} either way. Worth a glance if it looks off.`,
  };
}
