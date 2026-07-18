import { describe, it, expect } from "vitest";
import { effectiveMarkupPct } from "@/lib/pricing/markup";

describe("effectiveMarkupPct — the ONE markup fallback chain (level → item > 0 → org default → 0)", () => {
  it("customer pricing-level markup wins over everything", () => {
    expect(effectiveMarkupPct({ levelPct: 15, itemPct: 40, orgDefaultPct: 25 })).toBe(15);
  });

  it("a level at 0% still wins — the customer explicitly sells at net", () => {
    expect(effectiveMarkupPct({ levelPct: 0, itemPct: 40, orgDefaultPct: 25 })).toBe(0);
  });

  it("no level → the item's own markup when > 0 (Tahoe's real book markups unaffected)", () => {
    expect(effectiveMarkupPct({ levelPct: null, itemPct: 40, orgDefaultPct: 25 })).toBe(40);
    expect(effectiveMarkupPct({ itemPct: 40 })).toBe(40);
  });

  it("no level, item markup 0 → the org default (the CED net-cost import case)", () => {
    expect(effectiveMarkupPct({ levelPct: null, itemPct: 0, orgDefaultPct: 25 })).toBe(25);
    expect(effectiveMarkupPct({ itemPct: 0, orgDefaultPct: 25 })).toBe(25);
  });

  it("org default 0 = disabled → byte-identical to the old level ?? item behavior", () => {
    expect(effectiveMarkupPct({ levelPct: null, itemPct: 0, orgDefaultPct: 0 })).toBe(0);
    expect(effectiveMarkupPct({ levelPct: 15, itemPct: 0, orgDefaultPct: 0 })).toBe(15);
    expect(effectiveMarkupPct({ levelPct: null, itemPct: 40, orgDefaultPct: 0 })).toBe(40);
  });

  it("everything absent/zero → 0", () => {
    expect(effectiveMarkupPct({})).toBe(0);
    expect(effectiveMarkupPct({ levelPct: null, itemPct: null, orgDefaultPct: null })).toBe(0);
  });

  it("garbage in (NaN) never poisons the chain", () => {
    expect(effectiveMarkupPct({ levelPct: Number.NaN, itemPct: Number.NaN, orgDefaultPct: 25 })).toBe(25);
    expect(effectiveMarkupPct({ levelPct: Number.NaN, itemPct: 40, orgDefaultPct: 25 })).toBe(40);
  });

  it("a negative item/default markup counts as unset (only a LEVEL may discount below cost)", () => {
    expect(effectiveMarkupPct({ itemPct: -10, orgDefaultPct: 25 })).toBe(25);
    expect(effectiveMarkupPct({ itemPct: -10, orgDefaultPct: -5 })).toBe(0);
    expect(effectiveMarkupPct({ levelPct: -10, itemPct: 40, orgDefaultPct: 25 })).toBe(-10);
  });
});
