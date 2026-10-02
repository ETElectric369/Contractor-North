import { BUCKET_SECTION, bucketsIn, type BusinessCostBucket } from "@/lib/business-cost-buckets";
import { isSubtracted, type PnlKind, type PnlNetting, type PnlSection } from "@/lib/analytics/pnl-shape";
import type { OwnerMoneyCostTarget, OwnerMoneyFigures } from "@/lib/analytics/owner-money";

export { PNL_KINDS, PNL_KIND_SHAPE, PNL_SECTIONS, PNL_SECTION_SHAPE, isBelowNetProfit, isSubtracted } from "@/lib/analytics/pnl-shape";
export type { PnlKind, PnlKindShape, PnlNetting, PnlSection, PnlSectionShape } from "@/lib/analytics/pnl-shape";

/**
 * THE PROFIT AND LOSS, IN THE ACCOUNTING INDUSTRY'S OWN WORDS AND ORDER (Erik, 2026-09-28).
 *
 * "Lets stick with the tried and true old school simple wording and formatting of the accounting
 * industry on this one: ... Gross Profit is before Overhead and Net Profit = Owner's Draw." Fuel sat
 * in COGS with the job costs for two days, and on 2026-09-30 he moved it: "lets move fuel to
 * overhead above Auto and take out of COGS". So every money summary the app draws reads, top to
 * bottom:
 *
 *   Revenue                                  the money received (Other Income inside it, said)
 *   Cost of Goods Sold (COGS)
 *     Materials & Bills                      supplier materials and any bills on the jobs
 *     Stock Bought                           shop stock, the month it was bought
 *     Stock Lost (Written Off, Counted Short, Returned)
 *     Crew Pay (1099)
 *     Crew Mileage Paid                      and any bucket BUCKET_SECTION calls COGS (none today)
 *     Owner Build Time On Jobs               the owner's ON-SITE hours at his cost rate
 *     Owner Build Time Allocation (Contra)   the same amount back, so the pair nets to zero
 *     Total COGS
 *   Gross Profit                             Revenue less Total COGS
 *   Gross Margin %                           where a percent fits
 *   Overhead
 *     Fuel, Auto, Tools & Supplies, Phone & Office, Insurance & Licenses, Fees, Other
 *     Total Overhead
 *   Net Profit                               Gross Profit less Total Overhead
 *   ─────────────
 *   Owner's Draw                             EQUITY, below the line, never subtracted
 *
 * COGS CAN HOLD NO BUCKET AT ALL, and does today: its lines are the job-side ones by what they are.
 * Nothing here needs a bucket in it (no sentence joins a list that could be empty, and the one
 * division is by Revenue, never by a cost), and bucketHalvesWords below is how a sentence says the
 * split without reading wrong when one half is empty.
 *
 * THE SAME DOLLARS IN NEW PLACES. Every figure is one computeOwnerMoney already makes; this only says
 * where each one sits. Net Profit IS the engine's `left`, to the cent: it is read straight off it,
 * never re-added, and the tests prove on the engine's own fixtures (every window, every month) that
 * Gross Profit less Total Overhead lands on it. Revenue is the engine's Received.
 *
 * THE SPLIT IS DATA. A business-cost bucket is COGS or Overhead by BUCKET_SECTION
 * (business-cost-buckets.ts), and nowhere else; the job-cost lines (materials, stock, crew pay and
 * mileage) are COGS by what they are. Flip a bucket there and every surface moves it: that is all
 * moving Fuel to Overhead was.
 *
 * EVERY SURFACE READS THIS: the Net Profit card and Money by Month on /analytics, the accountant's
 * Summary and Costs tabs, the accountant page's two figures, and Nort's words. One layout, one set
 * of words, so no two screens can say the same money two ways.
 *
 * THE OWNER'S SWITCH: for an office viewer the owner hasn't shared the owner's money with, the lines
 * that are the owner's (`ownerOnly`: Revenue, every total, Gross Profit and its margin, Net Profit,
 * the owner's build-time pair and his draw) are left out. What is left is the cost rows one by one
 * under their two headings: nothing on it is a subtraction away from the bottom line.
 *
 * ── THE OWNER'S OWN BUILD TIME, AND WHY IT IS BOTH A COST AND NOT A DEDUCTION ─────────────────────
 *
 * Erik, 2026-10-01: "build time, including my build time is considered COGS, so it would be
 * considered a direct cost and should be counted that way". He is right about the JOB: an hour he
 * spends on site costs the business something, and a job's margin that pretends otherwise is a
 * fiction. Standard practice is equally blunt the other way about the TAX report: a sole proprietor
 * cannot deduct his own labour, as wages or inside COGS, because the business is not separate from
 * him and every dollar of profit is already his personal income on Schedule C. There is no owner wage
 * expense, full stop - which is what migration 0286 was protecting, and on this report it was right.
 *
 * Both halves hold at once through an ALLOCATION WITH A CONTRA (pnl-shape.ts's PnlNetting): Owner
 * Build Time On Jobs charges his on-site hours inside COGS at his cost rate, and Owner Build Time
 * Allocation (Contra) books the identical amount straight back on the next line. The pair sums to
 * zero, so Total COGS, Gross Profit, Gross Margin % and NET PROFIT are every one of them unchanged to
 * the cent, and his Schedule C figure is untouched. His OFFICE time is not in it at all: office time
 * is Overhead, never a job cost, so the allocation counts only hours against a job.
 *
 * BOTH LINES OR NEITHER. They are emitted by one function, ownerLabourPair, and the contra's figure is
 * the charged line's own closure negated. A charged line without its contra would understate his net
 * profit by all of his labour - the exact deduction he is not allowed - so it is not something a
 * reader can do by hand.
 *
 * THE OWNER'S DRAW IS THE LINE BELOW. What he actually takes out is EQUITY, not an expense: it sits
 * under Net Profit, is never subtracted from anything, and the words "Owner's Draw" now name only it.
 */

/** The words, exactly. Title Case: they are row names. */
export const PNL_WORDS = {
  revenue: "Revenue",
  otherIncome: "Other Income (Inside Revenue)",
  cogs: "Cost of Goods Sold (COGS)",
  materials: "Materials & Bills",
  stockBought: "Stock Bought",
  stockLost: "Stock Lost (Written Off, Counted Short, Returned)",
  /** The same line where its name stands alone (a chart's chip, a sentence pointing at it). */
  stockLostShort: "Stock Lost",
  crewPay: "Crew Pay (1099)",
  crewMileage: "Crew Mileage Paid",
  /** The owner's ON-SITE hours at his cost rate: a direct cost of the job, inside COGS. */
  ownerBuildTime: "Owner Build Time On Jobs",
  /** The same amount straight back, so the allocation nets to zero and Net Profit does not move. */
  ownerBuildTimeContra: "Owner Build Time Allocation (Contra)",
  /** Standing alone, where a chip or a sentence names the contra. */
  ownerBuildTimeContraShort: "Owner Build Time (Contra)",
  totalCogs: "Total COGS",
  grossProfit: "Gross Profit",
  /** A percent, not money: the row's name carries the unit, so a spreadsheet's plain 42.3 reads right. */
  grossMargin: "Gross Margin %",
  overhead: "Overhead",
  totalOverhead: "Total Overhead",
  /** THE BOTTOM LINE, plain (Erik, 2026-10-01: "lets get rid of the terminology owners draw and use
   *  only net profit"). It said "Net Profit (Owner's Draw)" until then, which conflated the bottom
   *  line with the equity line below it; `ownerDraw` is the only line those words name now. */
  netProfit: "Net Profit",
  /** EQUITY, BELOW THE LINE: what the owner actually took out this period. Never an expense, never
   *  subtracted (Erik: "an actual draw from the owner is considered equity and should be a line item
   *  below net profit stating what Ive taken out this month"). */
  ownerDraw: "Owner's Draw",
} as const;

/** What a line's name is when it stands alone (a chart's chip), where the row name is longer. */
const SHORT: Partial<Record<PnlKey, string>> = {
  stock_lost: PNL_WORDS.stockLostShort,
  total_overhead: PNL_WORDS.overhead,
  owner_build_time_contra: PNL_WORDS.ownerBuildTimeContraShort,
};

export type PnlKey =
  | "revenue"
  | "other_income"
  | "cogs"
  | "materials"
  | "stock_bought"
  | "stock_lost"
  | "crew_pay"
  | "crew_mileage"
  | "owner_build_time"
  | "owner_build_time_contra"
  | `bucket:${BusinessCostBucket}`
  | "total_cogs"
  | "gross_profit"
  | "gross_margin"
  | "overhead"
  | "total_overhead"
  | "net_profit"
  | "owner_draw";

/**
 * The figures a profit and loss is made from: computeOwnerMoney's own. THE PICK IS THE ENFORCEMENT -
 * add a figure here and the compiler walks every surface that builds a set of figures until each one
 * supplies it, which is how a new line cannot quietly read 0 on a screen nobody remembered.
 */
export type PnlFigures = Pick<
  OwnerMoneyFigures,
  | "received"
  | "otherIncome"
  | "materialsAndBills"
  | "putOnShelf"
  | "shopStockLost"
  | "crewPay"
  | "crewMileagePaid"
  | "ownerBuildTimeOnJobs"
  | "ownerDraw"
  | "fuel"
  | "businessCosts"
  | "left"
>;

export type PnlLine = {
  key: PnlKey;
  /** The row's name, exactly. */
  label: string;
  /** Its name standing alone (a chart's chip); the label unless that is longer than a chip holds. */
  short: string;
  kind: PnlKind;
  /** COGS, Overhead or Equity for a heading, a cost and a total; null for Revenue and the profits. */
  section: PnlSection | null;
  /** The owner's: never shown to an office viewer the owner hasn't shared the owner's money with. */
  ownerOnly: boolean;
  /** One half of an amount booked twice (pnl-shape.ts's PnlNetting), null on an ordinary line. A
   *  `charged` line and its `contra` are the same cents with opposite signs, so the pair adds nothing
   *  to its section's total: a reader totalling a section needs no special case, and a reader DRAWING
   *  one (a chart bar, a costs-tab row) can skip the pair knowing it accounts for no money. */
  netting: PnlNetting | null;
  /** The line's money in whole cents, for one set of figures. Null for a heading and the margin. */
  cents: (f: PnlFigures) => number | null;
  /** The margin line's percent (one decimal); null when there is no Revenue to be a percent of.
   *  Null on every other line. */
  pct: (f: PnlFigures) => number | null;
};

export type PnlOptions = {
  /** Say Other Income inside Revenue (a surface passes true when any figure it shows has some). */
  otherIncome?: boolean;
  /** Stock Bought inside Materials & Bills, with no row of its own: the Owner's Draw card and Money
   *  by Month (Erik, 2026-09-27: "we dont need a put on the shelf on the bar graph"). The same
   *  money either way; the accountant's Summary keeps it its own row. */
  stockInMaterials?: boolean;
  /** Gross Margin %, where a percent fits. */
  margin?: boolean;
  /** Say the owner's build time inside COGS with its contra under it. A surface passes true when any
   *  figure it shows has some - i.e. when he has set a cost rate AND worked on a job. BOTH LINES OR
   *  NEITHER: this one switch turns on the pair, never half of it. */
  ownerBuildTime?: boolean;
  /** Say Owner's Draw below the bottom line: what the owner actually took out. A surface passes true
   *  when any figure it shows has some. */
  ownerDraw?: boolean;
  /** False for an office viewer the owner hasn't shared the owner's money with: no `ownerOnly` line.
   *  True (the default) for the owner, or an office the owner has shared it with. */
  showOwner?: boolean;
};

/** Whole cents from a figure the engine rounded to cents. */
export const pnlCents = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : 0;
};

/** One bucket's money in a set of figures. The engine says Fuel on its own line (`fuel`, 0362) and
 *  every other bucket in `businessCosts`: this is the one place that knows that shape. */
export function bucketAmount(f: Pick<PnlFigures, "fuel" | "businessCosts">, b: BusinessCostBucket): number {
  if (b === "Fuel") return Number(f.fuel) || 0;
  return Number((f.businessCosts as Record<string, number>)[b]) || 0;
}

/**
 * MATERIALS & BILLS AS THE CARD AND THE CHART SAY IT (Erik, 2026-09-27: "we dont need a put on the
 * shelf on the bar graph"). Shop stock bought is money gone on materials, so both readers show it
 * INSIDE Materials & Bills, still in the month the ticket is dated (decision 1 is unchanged). The
 * engine keeps it apart (putOnShelf), because the accountant download's Summary shows it as Stock
 * Bought; this one sum is the only place the two are joined, so the card and the chart never
 * disagree and the card's lines still add up to the draw to the cent.
 */
export function materialsWithStock(f: Pick<PnlFigures, "materialsAndBills" | "putOnShelf">): number {
  return (pnlCents(f.materialsAndBills) + pnlCents(f.putOnShelf)) / 100;
}

/** Where one of the engine's cost lines (ownerMoneyCostLines) lands on the profit and loss. */
export function pnlKeyOfCostTarget(to: OwnerMoneyCostTarget): PnlKey {
  if (to === "materials") return "materials";
  if (to === "stock") return "stock_bought";
  if (to === "stock_lost") return "stock_lost";
  return `bucket:${to}`;
}

/** Gross Profit as a percent of Revenue, one decimal. Null with no Revenue (or less than none):
 *  a margin on nothing is not a number anyone should read. */
export function grossMarginPct(revenueCents: number, grossCents: number): number | null {
  if (!(revenueCents > 0)) return null;
  return Math.round((grossCents * 1000) / revenueCents) / 10 + 0; // + 0: never -0
}

type Def = {
  key: PnlKey;
  label: string;
  kind: PnlKind;
  section: PnlSection | null;
  ownerOnly: boolean;
  netting?: PnlNetting | null;
  cents?: (f: PnlFigures) => number | null;
  pct?: (f: PnlFigures) => number | null;
};

/**
 * THE OWNER'S BUILD TIME AND ITS CONTRA, AS ONE THING YOU CANNOT HALF-DO.
 *
 * Both lines come back from this function or neither does, and the contra's arithmetic is the charged
 * line's OWN closure with a minus in front - not a second read of `ownerBuildTimeOnJobs`. So there is
 * one amount and one negation: no edit can leave the two reading different figures, and no caller can
 * take one line and leave the other.
 *
 * WHY BOTH SIT INSIDE COGS rather than the contra going after Total COGS. Inside, the section's own
 * sum nets them to nothing, so Total COGS, Gross Profit, Gross Margin %, the chart's stated identity
 * (money-chart.ts: the COGS bars plus Overhead plus Net Profit account for every cent of Revenue),
 * the accountant's Costs-tab total and Net Profit are all unchanged to the cent with no arithmetic
 * edited anywhere. A contra placed after the total would have needed `gross` rewritten and would have
 * left the COGS bars over-summing by the allocation. His build time is still visibly a direct cost, on
 * its own line, where Erik said it belongs - one fewer thing to break for the same two rows.
 */
function ownerBuildTimePair(): Def[] {
  const charged = (f: PnlFigures) => pnlCents(f.ownerBuildTimeOnJobs ?? 0);
  return [
    {
      key: "owner_build_time",
      label: PNL_WORDS.ownerBuildTime,
      kind: "cost",
      section: "cogs",
      ownerOnly: true,
      netting: "charged",
      cents: charged,
    },
    {
      key: "owner_build_time_contra",
      label: PNL_WORDS.ownerBuildTimeContra,
      kind: "cost",
      section: "cogs",
      ownerOnly: true,
      netting: "contra",
      // THE SAME CLOSURE, NEGATED. Never `-pnlCents(f.ownerBuildTimeOnJobs)`: that is a second
      // reading, and two readings can be edited apart. This one cannot.
      cents: (f) => -charged(f),
    },
  ];
}

/**
 * THE LAYOUT: every line, in order, for these options. The lines carry their own arithmetic, so a
 * surface with columns (the accountant's months) asks each line for each column's figures.
 */
export function pnlLines(opts: PnlOptions = {}): PnlLine[] {
  const showOwner = opts.showOwner !== false;
  const nothing = () => null;

  const bucketLine = (b: BusinessCostBucket): Def => ({
    key: `bucket:${b}`,
    label: b,
    kind: "cost",
    section: BUCKET_SECTION[b],
    ownerOnly: false,
    cents: (f) => pnlCents(bucketAmount(f, b)),
  });

  // COGS: the job-cost lines, by what they are, then every bucket the data calls COGS.
  const materials: Def = {
    key: "materials",
    label: PNL_WORDS.materials,
    kind: "cost",
    section: "cogs",
    ownerOnly: false,
    cents: (f) => pnlCents(opts.stockInMaterials ? materialsWithStock(f) : f.materialsAndBills),
  };
  const stockBought: Def[] = opts.stockInMaterials
    ? []
    : [{ key: "stock_bought", label: PNL_WORDS.stockBought, kind: "cost", section: "cogs", ownerOnly: false, cents: (f) => pnlCents(f.putOnShelf) }];
  const cogs: Def[] = [
    materials,
    ...stockBought,
    { key: "stock_lost", label: PNL_WORDS.stockLost, kind: "cost", section: "cogs", ownerOnly: false, cents: (f) => pnlCents(f.shopStockLost) },
    { key: "crew_pay", label: PNL_WORDS.crewPay, kind: "cost", section: "cogs", ownerOnly: false, cents: (f) => pnlCents(f.crewPay) },
    { key: "crew_mileage", label: PNL_WORDS.crewMileage, kind: "cost", section: "cogs", ownerOnly: false, cents: (f) => pnlCents(f.crewMileagePaid) },
    // BUILD TIME IS A DIRECT COST, WHOEVER WORKED IT - beside Crew Pay, where Erik put it, with its
    // contra immediately under so the pair nets to nothing. Both or neither: ownerBuildTimePair().
    ...(opts.ownerBuildTime ? ownerBuildTimePair() : []),
    ...bucketsIn("cogs").map(bucketLine),
  ];
  const overhead: Def[] = bucketsIn("overhead").map(bucketLine);

  // A SECTION'S TOTAL ADDS ONLY WHAT ITS SECTION IS SUBTRACTED. PNL_SECTION_SHAPE decides, not this
  // file: a line in a section the shape calls `subtracted: false` (equity) contributes nothing to any
  // total even if somebody puts it in one of these arrays. That is the difference between a comment
  // saying "never sum the draw" and a bottom line that cannot be off by it.
  const sum = (list: Def[]) => (f: PnlFigures) => list.reduce((s, d) => s + (isSubtracted(d.section) ? (d.cents?.(f) ?? 0) : 0), 0);
  const totalCogs = sum(cogs);
  const totalOverhead = sum(overhead);
  const revenue = (f: PnlFigures) => pnlCents(f.received);
  const gross = (f: PnlFigures) => revenue(f) - totalCogs(f);

  const otherIncome: Def[] = opts.otherIncome
    ? [{ key: "other_income", label: PNL_WORDS.otherIncome, kind: "part", section: null, ownerOnly: true, cents: (f) => pnlCents(f.otherIncome ?? 0) }]
    : [];
  const margin: Def[] = opts.margin
    ? [{ key: "gross_margin", label: PNL_WORDS.grossMargin, kind: "margin", section: null, ownerOnly: true, pct: (f) => grossMarginPct(revenue(f), gross(f)) }]
    : [];
  const ownerDraw: Def[] = opts.ownerDraw
    ? [{ key: "owner_draw", label: PNL_WORDS.ownerDraw, kind: "equity", section: "equity", ownerOnly: true, cents: (f) => pnlCents(f.ownerDraw ?? 0) }]
    : [];

  const defs: Def[] = [
    { key: "revenue", label: PNL_WORDS.revenue, kind: "revenue", section: null, ownerOnly: true, cents: revenue },
    ...otherIncome,
    { key: "cogs", label: PNL_WORDS.cogs, kind: "heading", section: "cogs", ownerOnly: false },
    ...cogs,
    { key: "total_cogs", label: PNL_WORDS.totalCogs, kind: "total", section: "cogs", ownerOnly: true, cents: totalCogs },
    { key: "gross_profit", label: PNL_WORDS.grossProfit, kind: "profit", section: null, ownerOnly: true, cents: gross },
    ...margin,
    { key: "overhead", label: PNL_WORDS.overhead, kind: "heading", section: "overhead", ownerOnly: false },
    ...overhead,
    { key: "total_overhead", label: PNL_WORDS.totalOverhead, kind: "total", section: "overhead", ownerOnly: true, cents: totalOverhead },
    // THE BOTTOM LINE IS THE ENGINE'S OWN `left`, never re-added here: the same dollars, to the cent.
    // The owner's build-time pair above nets to zero inside COGS, so this figure does not move when
    // the allocation is switched on - which is the whole point of the contra, and is pinned by test.
    { key: "net_profit", label: PNL_WORDS.netProfit, kind: "profit", section: null, ownerOnly: true, cents: (f) => pnlCents(f.left) },
    // ── BELOW THE BOTTOM LINE: EQUITY, NEVER SUBTRACTED ──────────────────────────────────────────
    // What the owner actually took out. It is in no section the shape calls `subtracted`, so no sum()
    // above can reach it (PNL_SECTION_SHAPE.equity.subtracted === false), and `kind: "equity"` tells
    // every surface to draw it as a line below the rule, never as a total.
    ...ownerDraw,
  ];

  return defs
    .filter((d) => showOwner || !d.ownerOnly)
    .map((d) => ({
      key: d.key,
      label: d.label,
      short: SHORT[d.key] ?? d.label,
      kind: d.kind,
      section: d.section,
      ownerOnly: d.ownerOnly,
      netting: d.netting ?? null,
      cents: d.cents ?? nothing,
      pct: d.pct ?? nothing,
    }));
}

/** One line, worked out for one set of figures. */
export type PnlRow = Omit<PnlLine, "cents" | "pct"> & {
  /** Whole cents; null for a heading and the margin line. */
  cents: number | null;
  /** Dollars, from those cents; null where cents is. */
  amount: number | null;
  /** The margin's percent; null on every other line (and on the margin with no Revenue). */
  pct: number | null;
};

/** The profit and loss for one set of figures (a month, a window's total), in order. */
export function profitAndLoss(f: PnlFigures, opts: PnlOptions = {}): PnlRow[] {
  return pnlLines(opts).map((l) => {
    const cents = l.cents(f);
    return {
      key: l.key,
      label: l.label,
      short: l.short,
      kind: l.kind,
      section: l.section,
      ownerOnly: l.ownerOnly,
      netting: l.netting,
      cents,
      amount: cents == null ? null : cents / 100,
      pct: l.pct(f),
    };
  });
}

/** One row of a worked-out profit and loss by its key, or undefined when these options leave it out. */
export function pnlRow(rows: PnlRow[], key: PnlKey): PnlRow | undefined {
  return rows.find((r) => r.key === key);
}

/** "42.3%", "−12.5%": a margin as it is read. */
export function sayPct(pct: number): string {
  const s = `${Math.abs(pct).toFixed(1)}%`;
  return pct < 0 ? `−${s}` : s;
}

/** The COGS lines' names, as a sentence reads them ("Materials & Bills, … and Crew Mileage Paid"):
 *  from the data, so a line moved between the halves moves in every sentence too. */
export function cogsWords(opts: Pick<PnlOptions, "stockInMaterials"> = {}): string {
  const names = pnlLines({ ...opts, showOwner: false })
    .filter((l) => l.kind === "cost" && l.section === "cogs")
    .map((l) => l.short);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The Overhead lines' names, the same way ("Fuel, Auto, …, Fees and Other"). */
export function overheadWords(): string {
  const names = bucketsIn("overhead") as string[];
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * WHICH HALF THE BUSINESS-COST BUCKETS ARE IN, as a sentence says it, from BUCKET_SECTION: today
 * "every bucket is in Overhead", because Fuel moved there on 2026-09-30 and COGS holds no bucket at
 * all. Move one back and it reads "Fuel is in Cost of Goods Sold (COGS) and the rest in Overhead".
 *
 * IT EXISTS BECAUSE A JOINED LIST CAN BE EMPTY. Nort's get_bill description built that sentence by
 * joining bucketsIn("cogs") itself, and the day COGS emptied it read "on the company's profit and
 * loss  are in Cost of Goods Sold (COGS) and the rest in Overhead" — a half-sentence about nothing,
 * in a tool description a model reads as fact. Whoever says the split says it through this.
 */
export function bucketHalvesWords(): string {
  const cogs = bucketsIn("cogs") as string[];
  const overhead = bucketsIn("overhead") as string[];
  const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
  if (!cogs.length) return `every bucket is in ${PNL_WORDS.overhead}`;
  if (!overhead.length) return `every bucket is in ${PNL_WORDS.cogs}`;
  return `${list(cogs)} ${cogs.length === 1 ? "is" : "are"} in ${PNL_WORDS.cogs} and the rest in ${PNL_WORDS.overhead}`;
}
