import { effectiveMarkupPct, sellPrice } from "@/lib/pricing/markup";

/**
 * TURNING THE ESTIMATOR'S JSON INTO PRICED LINES — the last place a model's number can become a
 * customer's number, extracted from the server action so it can be TESTED.
 *
 * It lived inline in runEstimator, where nothing could reach it, and it carried two money bugs
 * that survived every review precisely because no test could see them:
 *
 *   1. `unit_price: Number(i.unit_cost) || rate` — the ECHOED hourly won over the rate resolved
 *      from the customer's pricing level. One hallucinated digit rewrote a contractual rate on the
 *      biggest line of the estimate, in the direction nobody audits.
 *   2. `unit: i.unit ?? pl.unit` — the model's unit won over the price book's. The book prices wire
 *      by the 500 ft ROLL; the model says "ft"; the line reads 250 × the roll price.
 *
 * THE RULE both fixes share: when the app already knows a fact, the model may not restate it. The
 * model chooses WHICH item and HOW MANY; the book and the customer's rate card decide what things
 * cost. Where the two disagree in a way we cannot reconcile — a unit mismatch — the line is
 * flagged for a human rather than silently multiplied into a confident wrong number.
 */

export interface DraftLineItem {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  /** Optional group this line belongs to (a kit/"job code group" like Stairs, Decking) — a
   *  build-time organizer so the estimate reads as collapsible groups. Not persisted yet. */
  group?: string;
  /** Set when the estimator priced this line from a FALLBACK (Home Depot / rough estimate) instead
   *  of the price book, or when the book and the model disagree about the unit. Build-time only. */
  flag?: string;
}

/** One row of the org's price book, as selected by runEstimator. */
export type BookRow = {
  code?: string | null;
  description?: string | null;
  buy_price?: number | string | null;
  markup_pct?: number | string | null;
  unit?: string | null;
  category?: string | null;
};

/** One entry of the model's `items` array. Every field is untrusted. */
export type EstimatorRawItem = {
  description?: unknown;
  quantity?: unknown;
  unit?: unknown;
  kind?: unknown;
  catalog?: unknown;
  unit_cost?: unknown;
};

/** What the sourcing ladder found for a line the model couldn't tie to a catalog code. */
export type LadderPrice = {
  buy_price: number | null;
  sell_price: number | null;
  unit: string | null;
  code: string | null;
  source: "book" | "paid" | "none";
  flagged: boolean;
  note: string;
};

export type LineMapContext = {
  /** The company/customer bill rate, already resolved. Authoritative whenever it is > 0. */
  rate: number;
  /**
   * A RATE HE TYPED INTO THE SCOPE, read out of his own words by statedLaborRate — never taken
   * from the model. Beats `rate` when present, because a rate he dictated is not a guess.
   */
  statedRate?: number | null;
  /** Price book indexed by UPPERCASE code. */
  byCode: Map<string, BookRow>;
  /** Customer pricing-level markup, or null. */
  levelPct: number | null;
  /** Org default markup. */
  orgDefaultPct: number;
  /**
   * Ladder results for lines the model did NOT resolve to a catalog code, keyed by lowercased
   * description. The model gets ONE chance to name a code; after that the app looks the part up
   * itself rather than accepting a guessed price, because "I couldn't find it in the book" and
   * "I didn't think to look" produce the same JSON.
   */
  laddered?: Map<string, LadderPrice>;
};

export function mapEstimatorLine(i: EstimatorRawItem, ctx: LineMapContext): DraftLineItem {
  const kind = i.kind === "labor" ? "labor" : "material";

  if (kind === "labor") {
    // THREE SOURCES, IN THIS ORDER, AND THE ORDER IS THE WHOLE POINT.
    //
    //   1. what HE SAID in the scope — read out of his text by statedLaborRate, never from the
    //      model. Erik wrote "a 2 man labor rate of 200 per hour", got 145 back (his company
    //      default) and corrected every labor line by hand: "it didnt catch the 2 man labor rate
    //      of 200 per hour statement … i edited it". A two-man crew rate is not his one-man rate,
    //      and he is the one who sets both.
    //   2. the COMPANY rate the app resolved, for the ordinary case where he said nothing.
    //   3. the model's echo, only for an org that has never set one — and then we say so, rather
    //      than presenting a guessed hourly as though it were the company's.
    //
    // The old code stopped at 2, and its comment defended that as anti-invention. It was right
    // about invention and wrong about dictation, which is the same distinction as the outlet
    // count: add whatever is stated.
    const echoed = Number(i.unit_cost) || 0;
    const stated = ctx.statedRate && ctx.statedRate > 0 ? ctx.statedRate : null;
    return {
      description: String(i.description ?? "Labor"),
      quantity: Number(i.quantity) || 1,
      unit: "hr",
      unit_price: stated ?? (ctx.rate > 0 ? ctx.rate : echoed),
      flag: stated || ctx.rate > 0 ? undefined : "no company labor rate set — confirm this hourly",
    };
  }

  const cat = i.catalog ? String(i.catalog).trim() : null;
  const pl = cat ? ctx.byCode.get(cat.toUpperCase()) ?? null : null;
  const desc = String(i.description ?? "").trim();

  // THE LADDER, for anything the model didn't tie to a catalog code. It already ran server-side,
  // so a real book or purchase-history price replaces the model's guess outright — including its
  // markup, which the ladder computed with the customer's level in hand.
  const found = !pl ? ctx.laddered?.get(desc.toLowerCase()) : undefined;
  if (found && found.sell_price != null && found.buy_price != null) {
    return {
      description: found.code ? `${desc || found.code} [${found.code}]` : desc,
      quantity: Number(i.quantity) || 1,
      unit: found.unit || (i.unit ? String(i.unit).trim() : "") || "ea",
      unit_price: found.sell_price,
      flag: found.flagged ? found.note : undefined,
    };
  }

  const cost = pl ? Number(pl.buy_price) || 0 : Number(i.unit_cost) || 0;

  // Markup, per item: customer level → the book item's own markup → org default. (An off-book
  // line has no item markup, so it's level → org default.)
  const pct = effectiveMarkupPct({
    levelPct: ctx.levelPct,
    itemPct: pl ? Number(pl.markup_pct) || 0 : 0,
    orgDefaultPct: ctx.orgDefaultPct,
  });

  const modelUnit = i.unit ? String(i.unit).trim() : "";
  const bookUnit = pl?.unit ? String(pl.unit).trim() : "";
  // A mismatch cannot be converted away — we don't know how many feet are on a roll — so it is
  // surfaced. Silently trusting either side produces a number that looks authoritative and isn't.
  const unitMismatch = !!(bookUnit && modelUnit && bookUnit.toLowerCase() !== modelUnit.toLowerCase());

  const base = String(i.description ?? pl?.description ?? "");
  return {
    description: pl ? `${base} [${pl.code}]` : base, // book items carry [CODE] so the order sheet resolves them
    quantity: Number(i.quantity) || 1,
    unit: bookUnit || modelUnit || "ea",
    unit_price: sellPrice(cost, pct),
    flag: pl
      ? unitMismatch
        ? `priced per ${bookUnit} — quantity was given in ${modelUnit}; check it`
        : undefined
      : "est · Home Depot — confirm",
  };
}
