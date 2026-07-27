import { describe, it, expect, vi } from "vitest";
import { priceMaterial } from "./price-material";

/**
 * A fake supabase that answers the price-book query with `book` and the learned_prices RPC with
 * `paid`. Enough to drive the ladder end to end without a database — the point of the tool is the
 * ORDER it consults things in, and order is testable.
 */
function client(opts: { book?: any[]; paid?: any[]; customer?: any } = {}) {
  const rows = opts.book ?? [];
  const q: any = {
    select: () => q, eq: () => q, order: () => q, limit: () => q, ilike: () => q, or: () => q,
    maybeSingle: async () => ({ data: opts.customer ?? { settings: {} } }),
    then: (res: any) => res({ data: rows, error: null }),
  };
  return {
    from: vi.fn(() => q),
    rpc: vi.fn(async () => ({ data: opts.paid ?? [], error: null })),
  } as any;
}

const args = (over = {}) => ({ description: "12-2 romex", levelPct: null, orgDefaultPct: 20, ...over });

describe("the sourcing ladder runs in order, in code", () => {
  it("RUNG 1 — a price-book match wins and never touches purchase history", async () => {
    const sb = client({
      book: [{ code: "RMX122", description: "12-2 NM-B", unit: "roll", buy_price: 180, markup_pct: 10, category: null, supplier: "CED" }],
      paid: [{ item: "romex", last_price: 999, avg_price: 999, low_price: 999, high_price: 999, times_bought: 3 }],
    });
    const r = await priceMaterial(sb, args());
    expect(r.source).toBe("book");
    expect(r.buy_price).toBe(180);
    expect(r.sell_price).toBe(198); // item markup 10% beats the org default
    expect(r.code).toBe("RMX122");
    // The expensive rung must not have been consulted at all.
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("RUNG 2 — no book match falls through to what they ACTUALLY paid", async () => {
    const sb = client({
      book: [],
      paid: [{ item: "12-2 romex 250ft", last_price: 150, avg_price: 155, low_price: 140, high_price: 170, times_bought: 4, last_supplier: "CED", last_date: "2026-06-01" }],
    });
    const r = await priceMaterial(sb, args());
    expect(r.source).toBe("paid");
    expect(r.buy_price).toBe(150);
    expect(r.sell_price).toBe(180); // org default 20%
    expect(r.flagged).toBe(true); // nobody curated this — confirm before sending
    expect(r.note).toMatch(/CED/);
  });

  it("RUNG 3 — nothing anywhere returns needs_web_price WITH the markup to apply", async () => {
    const r = await priceMaterial(client({ book: [], paid: [] }), args());
    expect(r.source).toBe("none");
    expect(r.needs_web_price).toBe(true);
    expect(r.buy_price).toBeNull();
    // The model still must not do markup arithmetic — hand it the number.
    expect(r.markup_pct_used).toBe(20);
    expect(r.flagged).toBe(true);
  });
});

describe("markup is applied here, never asked of the model", () => {
  it("the customer's pricing level beats the item's own markup", async () => {
    const sb = client({ book: [{ code: "P200", description: "200A panel", unit: "ea", buy_price: 100, markup_pct: 10, category: null, supplier: null }] });
    const r = await priceMaterial(sb, args({ levelPct: 35 }));
    expect(r.sell_price).toBe(135);
    expect(r.markup_basis).toMatch(/pricing level/i);
  });

  it("with no level, the item's own markup beats the org default", async () => {
    const sb = client({ book: [{ code: "P200", description: "200A panel", unit: "ea", buy_price: 100, markup_pct: 45, category: null, supplier: null }] });
    const r = await priceMaterial(sb, args());
    expect(r.sell_price).toBe(145);
    expect(r.markup_basis).toMatch(/item/i);
  });

  it("a net-cost import (item markup 0) falls back to the org default, never sells at cost", async () => {
    const sb = client({ book: [{ code: "P200", description: "200A panel", unit: "ea", buy_price: 100, markup_pct: 0, category: null, supplier: null }] });
    const r = await priceMaterial(sb, args({ orgDefaultPct: 30 }));
    expect(r.sell_price).toBe(130);
    expect(r.markup_basis).toMatch(/org default/i);
  });
});

describe("it refuses to be confidently wrong", () => {
  it("an empty description is refused rather than priced", async () => {
    const r = await priceMaterial(client(), args({ description: "  " }));
    expect(r.source).toBe("none");
    expect(r.flagged).toBe(true);
    expect(r.buy_price).toBeNull();
  });

  it("a book row with no usable price falls through instead of quoting $0", async () => {
    const sb = client({
      book: [{ code: "X", description: "unpriced item", unit: "ea", buy_price: 0, markup_pct: 0, category: null, supplier: null }],
      paid: [{ item: "x", last_price: 12, avg_price: 12, low_price: 12, high_price: 12, times_bought: 1 }],
    });
    const r = await priceMaterial(sb, args());
    expect(r.source).toBe("paid");
    expect(r.sell_price).toBe(14.4);
  });
});
