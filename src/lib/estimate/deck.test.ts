import { describe, it, expect } from "vitest";
import { computeDeckEstimate, buildDeckRates, type DeckAnswers } from "@/lib/estimate/deck";

// Chris's real Tahoe Deck / GiddyUp catalog rates (by his reference code), so the math is his math.
const RATES: Record<string, number> = {
  "D1": 75, "DS8": 40, "DS2": 12,
  "DS5A": 12, "DS5B": 40, "DS5C": 80,
  "DS6C": 15, "DS6D": 10,
  "D2": 175, "D5": 295, "D4": 750,
  "DS1B": 1250, "DS1A": 1650, "DS9": 1500,
  "DS3C": 6000, "DS3D": 8,
};
const rate = (c: string) => RATES[c] ?? 0;

const base = (o: Partial<DeckAnswers> = {}): DeckAnswers => ({
  projectType: "new_deck", material: "wood", lengthFt: 0, widthFt: 0, heightFt: 0,
  railingLf: null, stairFlights: 0, stairSteps: 0, stairRailing: false, stairRailingLf: 0,
  shape: "rectangle", wrapAround: false, manDoors: 0, sliderDoors: 0, trpa: false, ...o,
});

describe("computeDeckEstimate — a plain new deck", () => {
  const e = computeDeckEstimate(base({ lengthFt: 20, widthFt: 15, heightFt: 8 }), rate);
  it("bills the build, derives railing from the footprint, and adds footings", () => {
    // 300sqft*75 + (2*20+15=55)LF*175 + max(4,ceil(300/60)=5)*1500
    expect(e.area).toBe(300);
    expect(e.total).toBe(22500 + 9625 + 7500);
    expect(e.lines.map((l) => l.description)).toEqual([
      "Deck build", "Deck railing", "Concrete footings & piers",
    ]);
  });
  it("flags the railing + footing assumptions", () => {
    expect(e.assumptions.some((a) => a.includes("Railing estimated"))).toBe(true);
    expect(e.assumptions.some((a) => a.includes("Footings estimated"))).toBe(true);
  });
});

describe("computeDeckEstimate — composite, tall, irregular, wrap-around", () => {
  it("stacks composite + the right height band + shape + wrap adders", () => {
    const e = computeDeckEstimate(
      base({ lengthFt: 20, widthFt: 15, heightFt: 25, material: "composite", shape: "irregular", wrapAround: true }),
      rate,
    );
    // build 22500 + composite 3600 + DS5B(20<h≤30? h=25 → >20) 12000 + irregular 4500
    // + wrap 3000 + railing (wrap 2*20+2*15=70)*175=12250 + footings 5*1500=7500
    expect(e.total).toBe(22500 + 3600 + 12000 + 4500 + 3000 + 12250 + 7500);
  });
  it("picks exactly one height band (>30 uses DS5C only)", () => {
    const e = computeDeckEstimate(base({ lengthFt: 10, widthFt: 10, heightFt: 35 }), rate);
    const heightLines = e.lines.filter((l) => l.description.startsWith("Height supplement"));
    expect(heightLines).toHaveLength(1);
    expect(heightLines[0].description).toContain("over 30");
  });
});

describe("computeDeckEstimate — partial jobs compose", () => {
  it("railing-only: just the measured railing line, no base/footings", () => {
    const e = computeDeckEstimate(base({ projectType: "railing", railingLf: 40 }), rate);
    expect(e.lines).toHaveLength(1);
    expect(e.total).toBe(40 * 175);
  });
  it("resurface reuses the frame: cheaper board rate, no invented railing, no footings", () => {
    const e = computeDeckEstimate(base({ projectType: "resurface", lengthFt: 10, widthFt: 10 }), rate);
    expect(e.lines).toHaveLength(1);
    expect(e.total).toBe(100 * 40); // DS8, not D1; no derived railing; no footings
  });
});

describe("computeDeckEstimate — stairs bill per STEP, sets flag the engineering", () => {
  it("15 steps in one set bills D4 at qty 15 (matches Chris's real GiddyUp bid)", () => {
    const e = computeDeckEstimate(base({ projectType: "stairs", stairFlights: 1, stairSteps: 15 }), rate);
    const d4 = e.lines.find((l) => l.description.startsWith("Stairs"));
    expect(d4?.quantity).toBe(15);
    expect(e.total).toBe(15 * 750);
    expect(e.assumptions.some((a) => a.includes("Multiple stair sets"))).toBe(false);
  });
  it("steps with sets left at 0 are treated as one set — no landings flag", () => {
    const e = computeDeckEstimate(base({ stairSteps: 8 }), rate);
    expect(e.lines.find((l) => l.description.startsWith("Stairs"))?.quantity).toBe(8);
    expect(e.assumptions.some((a) => a.includes("Multiple stair sets"))).toBe(false);
  });
  it("two sets adds the landings / extra-engineering assumption", () => {
    const e = computeDeckEstimate(base({ stairFlights: 2, stairSteps: 12 }), rate);
    expect(e.lines.find((l) => l.description.startsWith("Stairs"))?.quantity).toBe(12);
    expect(e.assumptions.some((a) => a.includes("Multiple stair sets"))).toBe(true);
  });
  it("stairRailing yes derives LF from the step count (both sides), flagged", () => {
    const e = computeDeckEstimate(base({ stairFlights: 1, stairSteps: 15, stairRailing: true }), rate);
    const d5 = e.lines.find((l) => l.description === "Stair railing");
    expect(d5?.quantity).toBe(Math.ceil(15 * 1.12 * 2)); // 34 LF
    expect(e.assumptions.some((a) => a.includes("Stair railing estimated"))).toBe(true);
  });
  it("an explicit measured stair-railing LF wins over the derivation (office path)", () => {
    const e = computeDeckEstimate(base({ stairSteps: 15, stairRailing: true, stairRailingLf: 20 }), rate);
    expect(e.lines.find((l) => l.description === "Stair railing")?.quantity).toBe(20);
    expect(e.assumptions.some((a) => a.includes("Stair railing estimated"))).toBe(false);
  });
  it("stairRailing yes with zero steps prices nothing and flags nothing", () => {
    const e = computeDeckEstimate(base({ stairRailing: true }), rate);
    expect(e.lines).toHaveLength(0);
    expect(e.assumptions.some((a) => a.includes("Stair railing"))).toBe(false);
  });
});

describe("buildDeckRates — markup + deterministic dedup", () => {
  it("applies markup so the rate is the customer SELL price (buy × (1+markup))", () => {
    const r = buildDeckRates([{ code: "D1", buy_price: 60, markup_pct: 25 }]);
    expect(r["D1"]).toBe(75); // 60 * 1.25 — matches the rest of the app's pricing
  });
  it("markup 0 leaves the buy price as-is (Chris's current catalog)", () => {
    const r = buildDeckRates([{ code: "D1", buy_price: 75, markup_pct: 0 }]);
    expect(r["D1"]).toBe(75);
  });
  it("dedups a duplicate active code deterministically — first (newest) row wins", () => {
    // Caller passes rows newest-first; a stale duplicate must not override the current one.
    const r = buildDeckRates([
      { code: "DS5A", buy_price: 12, markup_pct: 0 },
      { code: "DS5A", buy_price: 999, markup_pct: 0 },
    ]);
    expect(r["DS5A"]).toBe(12);
  });
  it("ignores blank codes and coerces bad numbers to 0", () => {
    const r = buildDeckRates([{ code: "", buy_price: 5, markup_pct: 0 }, { code: "X", buy_price: null, markup_pct: null }]);
    expect(r[""]).toBeUndefined();
    expect(r["X"]).toBe(0);
  });
});

describe("computeDeckEstimate — robustness", () => {
  it("skips any line whose catalog code is missing (rate 0), never emits a $0 line", () => {
    const onlyDeck = (c: string) => (c === "D1" ? 75 : 0);
    const e = computeDeckEstimate(base({ lengthFt: 10, widthFt: 10, railingLf: 30 }), onlyDeck);
    expect(e.lines).toHaveLength(1); // railing + footings codes absent → skipped
    expect(e.total).toBe(7500);
    expect(e.lines.every((l) => l.unit_price > 0 && l.quantity > 0)).toBe(true);
  });
  it("full replacement adds demo + TRPA when in the basin", () => {
    const e = computeDeckEstimate(base({ projectType: "full_replacement", lengthFt: 10, widthFt: 10, trpa: true }), rate);
    // 7500 build + railing 30*175=5250 + footings 4*1500=6000 + demo 100*8=800 + TRPA 6000
    expect(e.total).toBe(7500 + 5250 + 6000 + 800 + 6000);
    expect(e.lines.some((l) => l.description.includes("TRPA"))).toBe(true);
    expect(e.lines.some((l) => l.description.includes("Demo"))).toBe(true);
  });
});
