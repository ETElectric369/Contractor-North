import { searchPriceBook, LOOSE_RUNGS } from "./price-book-search";
import { searchPaidPrices } from "./learned-prices";
import { effectiveMarkupPct } from "./markup";
import { describeChoice, normalizeItemOptions, priceBookLine, type OptionedPriceItem } from "./item-options";

/**
 * ONE CALL THAT PRICES A MATERIAL — the sourcing ladder as CODE instead of prose.
 *
 * The rule "price book first, then what you've actually paid, then the web, and flag the web ones"
 * was written into four separate prompts (lib/anthropic.ts, two places in the chat route, and the
 * search_price_list tool description). Four restatements of the same sequence is the tell that it
 * was never instructions — it was control flow, being re-explained to a model that could skip a
 * rung any time it felt confident. Skipping the first rung is exactly what produced a $200 web
 * guess for a panel the book listed at $331.86.
 *
 * Now the ladder runs here, in order, every time:
 *   1. PRICE BOOK   — the company's own catalog. Their real net cost. Authoritative.
 *   2. PAID HISTORY — what they actually paid on their own bills. Ground truth, slightly stale.
 *   3. neither      — we say so and hand the model the one job it's genuinely needed for: go
 *                     research a current price. That line comes back flagged, always.
 *
 * MARKUP is applied here too, with the customer's pricing level included. The old flow asked the
 * model to notice the customer had a level and multiply accordingly — in-head arithmetic on the
 * customer's money, which is precisely the thing that must never be a model's job.
 */

export type PriceSource = "book" | "paid" | "none";

export type PricedMaterial = {
  description: string;
  /** What we'd BUY it for. Null when nothing was found. */
  buy_price: number | null;
  /** What to put on the quote line — buy_price with the governing markup applied. */
  sell_price: number | null;
  unit: string | null;
  /** Catalog code, when the book matched. Belongs on the quote line as [CODE]. */
  code: string | null;
  /** The vendor the book row priced at: the org's DEFAULT vendor under that code (0282), named
   *  in `description` too. Null when the code priced at its own number. */
  vendor?: string | null;
  source: PriceSource;
  markup_pct_used: number;
  /** Which markup rule won, in plain words — so the readback can say it. */
  markup_basis: string;
  /** True when this line must be confirmed by a human before it goes to a customer. */
  flagged: boolean;
  note: string;
  /** Only when the book missed AND there's no purchase history. */
  needs_web_price?: true;
  /** Populated on a loose match so the model can reject a bad row instead of accepting rung 6. */
  alternatives?: { code: string | null; description: string | null; buy_price: number }[];
};

const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

type Client = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

export async function priceMaterial(
  supabase: Client,
  args: { description: string; levelPct: number | null; orgDefaultPct: number },
): Promise<PricedMaterial> {
  const description = String(args.description ?? "").trim();
  if (!description) {
    return {
      description: "",
      buy_price: null, sell_price: null, unit: null, code: null,
      source: "none", markup_pct_used: 0, markup_basis: "none",
      flagged: true, note: "No item description given — say what the material is.",
    };
  }

  // ── RUNG 1: the price book ────────────────────────────────────────────────
  const hit = await searchPriceBook(supabase, description, 5);
  const top = hit.rows[0];
  // THE ONE PRICE (priceBookLine): the default vendor under the code when the org made one, else
  // the code's own number, through the same rule and the same two inputs as every quote picker.
  // This read the item's own buy_price and markup directly, so Nort quoted an 830 Windows at its
  // $830 allowance while the picker quoted the Marvin the org had made the default (VP2).
  const line = top ? priceBookLine(top as unknown as OptionedPriceItem, { levelPct: args.levelPct, orgDefaultPct: args.orgDefaultPct }) : null;
  if (top && line && line.buyPrice > 0) {
    const itemPct = Number(top.markup_pct) || 0;
    const loose = hit.matched_by ? LOOSE_RUNGS.has(hit.matched_by) : false;
    return {
      description: describeChoice(top.description ?? description, top as unknown as OptionedPriceItem, line),
      buy_price: money(line.buyPrice),
      sell_price: line.unitPrice,
      unit: line.isItemOwn ? top.unit ?? null : line.unit,
      code: top.code ?? null,
      vendor: line.isItemOwn ? null : line.makerLabel,
      source: "book",
      markup_pct_used: line.markupPct,
      markup_basis: line.isItemOwn
        ? markupBasis(args.levelPct, itemPct)
        : `${markupBasis(args.levelPct, itemPct, vendorStatesMarkup(top as unknown as OptionedPriceItem, line.id))}, on ${line.makerLabel}, the default vendor for this code`,
      // A loose rung found SOMETHING word-shaped; it may not be the right part. Cheap to confirm,
      // expensive to discover on the invoice.
      flagged: loose,
      note: loose
        ? `Matched loosely (${hit.matched_by}) — check this is the right part before quoting it.`
        : "The company's own book price. Keep the [CODE] on the quote line.",
      ...(loose && hit.rows.length > 1
        ? { alternatives: hit.rows.slice(1, 4).map((r) => ({ code: r.code, description: r.description, buy_price: money(r.buy_price) })) }
        : {}),
    };
  }

  // ── RUNG 2: what they've actually paid ────────────────────────────────────
  const paid = await searchPaidPrices(supabase, description, 3);
  const best = paid.find((p) => p.lastPrice > 0);
  if (best) {
    const pct = effectiveMarkupPct({ levelPct: args.levelPct, itemPct: 0, orgDefaultPct: args.orgDefaultPct });
    return {
      description: best.item || description,
      buy_price: money(best.lastPrice),
      sell_price: money(best.lastPrice * (1 + pct / 100)),
      unit: null,
      code: null,
      source: "paid",
      markup_pct_used: pct,
      markup_basis: markupBasis(args.levelPct, 0),
      // Not in the book, so nobody curated it — but it IS a real receipt, so it's a soft flag.
      flagged: true,
      note: `Last paid $${money(best.lastPrice)}${best.lastSupplier ? ` at ${best.lastSupplier}` : ""}${
        best.lastDate ? ` on ${String(best.lastDate).slice(0, 10)}` : ""
      } (bought ${best.timesBought}×, range $${money(best.lowPrice)}–$${money(best.highPrice)}). Not in the price book — confirm before sending.`,
    };
  }

  // ── RUNG 3: genuinely unknown ─────────────────────────────────────────────
  return {
    description,
    buy_price: null, sell_price: null, unit: null, code: null,
    source: "none",
    markup_pct_used: effectiveMarkupPct({ levelPct: args.levelPct, itemPct: 0, orgDefaultPct: args.orgDefaultPct }),
    markup_basis: markupBasis(args.levelPct, 0),
    flagged: true,
    needs_web_price: true,
    note:
      "Not in the price book and never bought on a recorded bill. NOW research a current price " +
      "(web_search), apply the markup above, and tell the user this line is an estimate to confirm.",
  };
}

function markupBasis(levelPct: number | null, itemPct: number, vendorStated = false): string {
  if (levelPct != null && levelPct >= 0) return "the customer's pricing level"; // a 0% level is a real level
  if (vendorStated) return "the vendor's own markup";
  if (itemPct > 0) return "this item's own book markup";
  return "the org default markup";
}

/** Did the vendor row type its own markup? A blank falls through to the item, then the org
 *  default, which is how optionMarkupPct prices it. Only for the words in markup_basis. */
function vendorStatesMarkup(item: OptionedPriceItem, optionId: string): boolean {
  const raw = normalizeItemOptions(item.price_list_item_options).find((o) => o.id === optionId)?.markup_pct;
  return raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw));
}
