/**
 * THE SHAPE OF A PROFIT AND LOSS: its sections, in order, and what each one does to the bottom line.
 *
 * Erik, 2026-10-01: "lets get rid of the terminology owners draw and use only net profit however ...
 * an actual draw from the owner is considered equity and should be a line item below net profit
 * stating what Ive taken out this month". So a profit and loss now has a part that is NOT a cost and
 * is NOT subtracted: money the owner took out, below the line, said and never netted off.
 *
 * WHY A TYPED RECORD AND NOT A SECOND IF. A section that sits below the line but gets summed into a
 * total is the worst kind of wrong number: every row on the screen is right and the bottom line is
 * off by the draw. There are four surfaces that draw a profit and loss (the Net Profit card, Money
 * by Month, the accountant's Summary and Costs tabs) and each used to decide for itself how to draw
 * a row. So the shape is DATA, here, once: a Record over PNL_SECTIONS, so a new section does not
 * compile until someone says where it sits and whether it is subtracted, and profit-and-loss.ts
 * totals a section only when this file says that section is subtracted.
 *
 * Pure: no I/O, no React, no imports. business-cost-buckets.ts reads BucketSection from here (a
 * bucket is a cost, so it can only ever be one of the two cost halves), and
 * analytics/profit-and-loss.ts reads the whole shape.
 */

/** Every section of a profit and loss, in the order it is read, top to bottom. */
export const PNL_SECTIONS = ["cogs", "overhead", "equity"] as const;

export type PnlSection = (typeof PNL_SECTIONS)[number];

export type PnlSectionShape = {
  /** Where the section sits against the bottom line. */
  where: "above_net_profit" | "below_net_profit";
  /** Is this section's money taken off Revenue on the way to Net Profit? A section with `false`
   *  here is never summed into a total and never reaches the bottom line, whatever it holds. */
  subtracted: boolean;
  /** Does the section get a heading row of its own (Cost of Goods Sold (COGS), Overhead)? A single
   *  line below the bottom line does not: it stands alone, under the rule. */
  heading: boolean;
  /** Does the section get a total row (Total COGS, Total Overhead)? */
  total: boolean;
};

/**
 * WHAT EACH SECTION DOES. The two cost halves are subtracted, in order, and each gets its heading
 * and its total. Equity is below the bottom line: Owner's Draw is what the owner took out, which is
 * not an expense of the business and is never subtracted to reach Net Profit. His own BUILD TIME is
 * a different thing and is a real direct cost — it is a COGS line (Owner Build Time), beside Crew
 * Pay (Erik, 2026-10-01: "build time, including my build time is considered COGS").
 */
export const PNL_SECTION_SHAPE: Record<PnlSection, PnlSectionShape> = {
  cogs: { where: "above_net_profit", subtracted: true, heading: true, total: true },
  overhead: { where: "above_net_profit", subtracted: true, heading: true, total: true },
  equity: { where: "below_net_profit", subtracted: false, heading: false, total: false },
};

/** The halves a business-cost bucket can be in: a bucket is a COST, so never equity. */
export type BucketSection = Exclude<PnlSection, "equity">;

/** The sections whose money reaches the bottom line, in order. */
export const SUBTRACTED_SECTIONS: readonly PnlSection[] = PNL_SECTIONS.filter((s) => PNL_SECTION_SHAPE[s].subtracted);

/** The sections drawn BELOW the bottom line, in order: said, never subtracted. */
export const BELOW_THE_LINE_SECTIONS: readonly PnlSection[] = PNL_SECTIONS.filter(
  (s) => PNL_SECTION_SHAPE[s].where === "below_net_profit",
);

/** Is this section's money subtracted to reach Net Profit? THE one answer. */
export function isSubtracted(section: PnlSection | null | undefined): boolean {
  return !!section && PNL_SECTION_SHAPE[section].subtracted === true;
}

// ── THE KINDS OF ROW, AND HOW EACH ONE IS DRAWN ───────────────────────────────────────────────────

/**
 * EVERY KIND OF ROW A PROFIT AND LOSS HAS. A kind is not a style: it is what the row IS, and the two
 * surfaces that draw rows (the Net Profit card and the accountant's Summary) read how to weight it
 * from the Record below rather than each keeping a switch of its own.
 *
 * WHY THIS IS A RECORD AND NOT TWO SWITCHES. Both of those switches failed OPEN on a kind they had
 * never heard of, in opposite and equally wrong directions: left-for-card's `lineOf` had no default
 * case, so an unknown kind rendered NOTHING at all while still sitting in the data; the accountant's
 * Summary ended `else rows.push(total(...))`, so an unknown kind printed BOLD, like a total. An
 * equity line that looks like a total sitting directly under Net Profit is the worst outcome
 * available here - every row on the screen right and the bottom line apparently off by the draw. A
 * Record over PNL_KINDS does not compile until a new kind says how it is weighted, and both surfaces
 * ask it instead of guessing.
 */
export const PNL_KINDS = ["revenue", "part", "heading", "cost", "total", "profit", "margin", "equity"] as const;

export type PnlKind = (typeof PNL_KINDS)[number];

export type PnlKindShape = {
  /** Does the row carry money of its own? A heading has no figure, and the margin is a percent. */
  money: boolean;
  /**
   * How much weight the row carries, on a screen and in a spreadsheet alike:
   *   heading  a section's name, no figure
   *   line     one figure under a heading, indented
   *   strong   a figure a reader's eye stops on: Revenue, a section's total, a profit
   */
  weight: "heading" | "line" | "strong";
  /** Is the row BELOW the bottom line - said, and never inside any total? Equity is: what the owner
   *  took out is not an expense of the business, so nothing subtracts it to reach Net Profit. */
  below: boolean;
};

export const PNL_KIND_SHAPE: Record<PnlKind, PnlKindShape> = {
  revenue: { money: true, weight: "strong", below: false },
  part: { money: true, weight: "line", below: false },
  heading: { money: false, weight: "heading", below: false },
  cost: { money: true, weight: "line", below: false },
  total: { money: true, weight: "strong", below: false },
  profit: { money: true, weight: "strong", below: false },
  margin: { money: false, weight: "line", below: false },
  // OWNER'S DRAW: equity, below the line. A LINE, never strong - it must not look like a total.
  equity: { money: true, weight: "line", below: true },
};

/** Is this row drawn below the bottom line? THE one answer. */
export function isBelowNetProfit(kind: PnlKind): boolean {
  return PNL_KIND_SHAPE[kind].below === true;
}

// ── ONE AMOUNT, BOOKED TWICE, NETTING TO NOTHING ──────────────────────────────────────────────────

/**
 * AN ALLOCATION AND ITS CONTRA. The owner's on-site hours are a direct cost of the job he worked
 * (Erik, 2026-10-01: "build time, including my build time is considered COGS") AND a sole proprietor
 * cannot deduct his own labour on the business's profit and loss - all of it is already his personal
 * income, so there is no owner wage to deduct. Both are true, of different reports, and the mechanism
 * accountants use to hold both is an allocation with a contra entry: the amount is charged where the
 * cost belongs, and the identical amount is booked straight back, so the pair adds NOTHING to any
 * total and the bottom line does not move by a cent.
 *
 *   charged  the cost, on its line, where Erik said build time belongs: inside COGS
 *   contra   the same amount back, negative, immediately under it
 *
 * WHY A PAIR IS A TYPE AND NOT A CONVENTION. A charged line shipped without its contra understates
 * Net Profit by the whole allocation, which is a wrong tax figure, not a wrong screen. So the pair is
 * built by ONE function that emits both lines at once (profit-and-loss.ts's ownerLabourPair), and the
 * contra's arithmetic is the charged line's OWN closure with a minus sign - not a second reading of
 * the same figure. There is one amount and one negation, so the two cannot drift apart.
 */
export type PnlNetting = "charged" | "contra";
