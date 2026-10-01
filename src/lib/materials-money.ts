/**
 * THE MONEY ON A MATERIALS LIST, LINE BY LINE (item C4, from Erik's report a7831363 on /materials/<id>:
 * "This needs to be itemized by line item per item").
 *
 * The list footer printed one figure, "List Total", summed as `(est_cost ?? 0) × quantity` over every
 * line. A line with no price yet counted as ZERO and nothing on the screen said so — so a list of
 * twenty lines where six have no price read as a finished total, and the figure a person takes to a
 * supplier or a customer is short by whatever those six cost. That is the NOTHING SILENT law: nothing
 * may be left out of a figure without the screen saying it was left out.
 *
 * Pure, so the words are pinned by a test and the editor and the read-only view cannot print two
 * different sentences about the same list.
 */

/** What the money read needs off a line. `est_cost` is per unit; the line's own money is the
 *  EXTENSION, quantity × est_cost (lib/job-cost-guard's neighbour law: the extension is the price). */
export type PricedLine = { quantity?: number | null; est_cost?: number | null };

export type ListMoney = {
  /** What the priced lines come to. */
  total: number;
  /** How many lines carry a price. */
  priced: number;
  /** How many carry none — the ones NOT in `total`. */
  unpriced: number;
};

/** One line's own money: quantity × the price each. Null when the line has no price yet — not 0,
 *  because "nothing" and "free" are different answers and only one of them is a number. */
export function lineExtension(line: PricedLine): number | null {
  if (line.est_cost === null || line.est_cost === undefined) return null;
  const each = Number(line.est_cost);
  if (!Number.isFinite(each)) return null;
  const qty = Number(line.quantity);
  return Math.round(each * (Number.isFinite(qty) ? qty : 0) * 100) / 100;
}

/** The whole list's money, and how much of the list it actually covers. */
export function listMoney(items: readonly PricedLine[] | null | undefined): ListMoney {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const it of items ?? []) {
    const ext = lineExtension(it);
    if (ext === null) unpriced += 1;
    else {
      priced += 1;
      total += ext;
    }
  }
  return { total: Math.round(total * 100) / 100, priced, unpriced };
}

/**
 * WHAT THE TOTAL LEAVES OUT, in plain words — or null when it leaves nothing out and there is
 * nothing to say. Said under the figure, never instead of it: the priced lines are still a real
 * number, it just isn't the whole list.
 */
export function listTotalCaveat(money: ListMoney): string | null {
  if (money.unpriced === 0) return null;
  if (money.priced === 0)
    return money.unpriced === 1
      ? "This line has no price on it yet, so there is nothing to total."
      : `None of these ${money.unpriced} lines has a price on it yet, so there is nothing to total.`;
  return money.unpriced === 1
    ? "1 line has no price on it yet, so it is not in that total."
    : `${money.unpriced} lines have no price on them yet, so they are not in that total.`;
}
