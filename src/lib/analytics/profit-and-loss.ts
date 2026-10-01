import { BUCKET_SECTION, bucketsIn, type BusinessCostBucket, type PnlSection } from "@/lib/business-cost-buckets";
import type { OwnerMoneyCostTarget, OwnerMoneyFigures } from "@/lib/analytics/owner-money";

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
 *     Total COGS
 *   Gross Profit                             Revenue less Total COGS
 *   Gross Margin %                           where a percent fits
 *   Overhead
 *     Fuel, Auto, Tools & Supplies, Phone & Office, Insurance & Licenses, Fees, Other
 *     Total Overhead
 *   Net Profit (Owner's Draw)                Gross Profit less Total Overhead
 *
 * COGS CAN HOLD NO BUCKET AT ALL, and does today: its lines are the job-side ones by what they are.
 * Nothing here needs a bucket in it (no sentence joins a list that could be empty, and the one
 * division is by Revenue, never by a cost), and bucketHalvesWords below is how a sentence says the
 * split without reading wrong when one half is empty.
 *
 * THE SAME DOLLARS IN NEW PLACES. Every figure is one computeOwnerMoney already makes; this only says
 * where each one sits. Net Profit (Owner's Draw) IS the engine's `left`, to the cent: it is read
 * straight off it, never re-added, and the tests prove on the engine's own fixtures (every window,
 * every month) that Gross Profit less Total Overhead lands on it. Revenue is the engine's Received.
 *
 * THE SPLIT IS DATA. A business-cost bucket is COGS or Overhead by BUCKET_SECTION
 * (business-cost-buckets.ts), and nowhere else; the job-cost lines (materials, stock, crew pay and
 * mileage) are COGS by what they are. Flip a bucket there and every surface moves it: that is all
 * moving Fuel to Overhead was.
 *
 * EVERY SURFACE READS THIS: the Owner's Draw card and Money by Month on /analytics, the accountant's
 * Summary and Costs tabs, the accountant page's two figures, and Nort's words. One layout, one set
 * of words, so no two screens can say the same money two ways.
 *
 * THE OWNER'S SWITCH: for an office viewer the owner hasn't shared Owner's Draw with, the lines that
 * are the owner's (`ownerOnly`: Revenue, every total, Gross Profit and its margin, Net Profit) are
 * left out. What is left is the cost rows one by one under their two headings: nothing on it is a
 * subtraction away from the bottom line.
 *
 * THE OWNER'S TIME IS NEVER A COST: the owner's hours are not a line here. Whoever shows them says
 * them as hours, below the line.
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
  totalCogs: "Total COGS",
  grossProfit: "Gross Profit",
  /** A percent, not money: the row's name carries the unit, so a spreadsheet's plain 42.3 reads right. */
  grossMargin: "Gross Margin %",
  overhead: "Overhead",
  totalOverhead: "Total Overhead",
  netProfit: "Net Profit (Owner's Draw)",
} as const;

/** What a line's name is when it stands alone (a chart's chip), where the row name is longer. */
const SHORT: Partial<Record<PnlKey, string>> = {
  stock_lost: PNL_WORDS.stockLostShort,
  total_overhead: PNL_WORDS.overhead,
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
  | `bucket:${BusinessCostBucket}`
  | "total_cogs"
  | "gross_profit"
  | "gross_margin"
  | "overhead"
  | "total_overhead"
  | "net_profit";

/**
 *   revenue   Revenue
 *   part      a part of the line above it, already inside it (Other Income inside Revenue)
 *   heading   a section's name, no figure (Cost of Goods Sold (COGS), Overhead)
 *   cost      one cost, in its section
 *   total     a section's total (Total COGS, Total Overhead)
 *   profit    Gross Profit, Net Profit (Owner's Draw)
 *   margin    Gross Margin %: a percent, not money
 */
export type PnlKind = "revenue" | "part" | "heading" | "cost" | "total" | "profit" | "margin";

/** The figures a profit and loss is made from: computeOwnerMoney's own. */
export type PnlFigures = Pick<
  OwnerMoneyFigures,
  "received" | "otherIncome" | "materialsAndBills" | "putOnShelf" | "shopStockLost" | "crewPay" | "crewMileagePaid" | "fuel" | "businessCosts" | "left"
>;

export type PnlLine = {
  key: PnlKey;
  /** The row's name, exactly. */
  label: string;
  /** Its name standing alone (a chart's chip); the label unless that is longer than a chip holds. */
  short: string;
  kind: PnlKind;
  /** COGS or Overhead for a heading, a cost and a total; null for Revenue and the profits. */
  section: PnlSection | null;
  /** The owner's: never shown to an office viewer the owner hasn't shared Owner's Draw with. */
  ownerOnly: boolean;
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
  /** False for an office viewer the owner hasn't shared Owner's Draw with: no `ownerOnly` line.
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

type Def = { key: PnlKey; label: string; kind: PnlKind; section: PnlSection | null; ownerOnly: boolean; cents?: (f: PnlFigures) => number | null; pct?: (f: PnlFigures) => number | null };

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
    ...bucketsIn("cogs").map(bucketLine),
  ];
  const overhead: Def[] = bucketsIn("overhead").map(bucketLine);

  const sum = (list: Def[]) => (f: PnlFigures) => list.reduce((s, d) => s + (d.cents?.(f) ?? 0), 0);
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
    { key: "net_profit", label: PNL_WORDS.netProfit, kind: "profit", section: null, ownerOnly: true, cents: (f) => pnlCents(f.left) },
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
