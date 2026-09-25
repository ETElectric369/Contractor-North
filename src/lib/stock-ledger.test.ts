import { describe, it, expect, vi } from "vitest";

// The server half needs a request and a session; the pure half, tested here, needs neither.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ error: "not in a test" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import {
  guessUnit,
  lotCostDrift,
  matchItem,
  normaliseName,
  normalisePartNumber,
  planFifoTake,
  putOnShelfProblem,
  restampLotsForBill,
  restampPlan,
  type ItemCandidate,
  type LotForTake,
} from "@/lib/stock-ledger";
import type { BillLine } from "@/lib/bill-itemisation";

/* ── Moved from stock-flow.test.ts with the matching (Shop Stock, 0303) ───────────────────────── */
describe("normalising the two keys", () => {
  it("reads every way a supply house writes one part number as the same part", () => {
    for (const raw of ["30641", "30-641", "30 641", " 30.641 ", "30/641"]) expect(normalisePartNumber(raw)).toBe("30641");
  });
  it("treats blank, missing and punctuation-only as no part number at all", () => {
    for (const raw of ["", "   ", null, undefined, "--", "#"]) expect(normalisePartNumber(raw)).toBeNull();
  });
  it("folds case and punctuation in a description but never digits", () => {
    expect(normaliseName("IDEAL 30641 500/5000 Twister 341-Tan")).toBe("IDEAL 30641 500 5000 TWISTER 341 TAN");
    expect(normaliseName("Twister 341-Tan")).not.toBe(normaliseName("Twister 342-Red"));
  });
});

describe("matchItem: the second box lands on the first box's item, never on a different part", () => {
  const nuts: ItemCandidate = { id: "inv-nuts", name: "IDEAL 30641 500/5000 Twister 341-Tan", key_part: "30641", created_at: "2026-09-01T00:00:00Z" };

  it("matches on the part number however either side punctuates it", () => {
    expect(matchItem([nuts], { partNumber: "30-641", description: "Twister nuts, tan" })).toEqual({ kind: "match", id: "inv-nuts", why: "same part number" });
  });
  it("reads a legacy part_number when the item has no key_part", () => {
    const legacy = { ...nuts, key_part: null, part_number: "30 641" };
    expect(matchItem([legacy], { partNumber: "30641", description: "x" })).toMatchObject({ kind: "match", id: "inv-nuts" });
  });
  it("NEVER merges two different part numbers, however alike the names read", () => {
    const red = { ...nuts, id: "inv-red", key_part: "30644" };
    expect(matchItem([red], { partNumber: "30641", description: nuts.name }).kind).toBe("create");
  });
  it("matches on the same price-list item", () => {
    const priced = { ...nuts, key_part: null, price_item_id: "pl-1" };
    expect(matchItem([priced], { priceItemId: "pl-1", description: "anything" })).toMatchObject({ kind: "match", why: "same price-list item" });
  });
  it("adopts an item with no part number of its own on the exact name, and says why", () => {
    const typed = { ...nuts, id: "inv-typed", key_part: null };
    expect(matchItem([typed], { partNumber: "30641", description: "ideal 30641 500/5000 twister 341-tan" })).toMatchObject({ kind: "match", id: "inv-typed" });
  });
  it("is exact, never fuzzy: a near name is a new item", () => {
    const typed = { ...nuts, key_part: null };
    expect(matchItem([typed], { description: "IDEAL 30641 Twister 341-Tan" }).kind).toBe("create");
  });
  it("adds to the oldest of existing twins rather than making a third", () => {
    const older = { ...nuts, id: "inv-older", created_at: "2026-08-01T00:00:00Z" };
    const newer = { ...nuts, id: "inv-newer", created_at: "2026-09-15T00:00:00Z" };
    expect(matchItem([newer, older], { partNumber: "30641", description: nuts.name })).toMatchObject({ id: "inv-older" });
  });
  it("creates when the shelf is empty, which is where every org starts", () => {
    expect(matchItem([], { partNumber: "30641", description: nuts.name }).kind).toBe("create");
  });
});

describe("guessUnit: a suggestion a person confirms, never a count read off the quantity column", () => {
  it("reads feet off a coil or a reel", () => {
    expect(guessUnit("NMB 12/2 w/gnd 250 ft coil")).toMatchObject({ unit: "ft", perContainer: 250 });
    expect(guessUnit("NMB 6/3 W/GND (1000' REEL)")).toMatchObject({ unit: "ft", perContainer: 1000 });
    expect(guessUnit("THHN 12 STR BLK REEL 2,500 FT")).toMatchObject({ unit: "ft", perContainer: 2500 });
    expect(guessUnit("Romex coil")).toMatchObject({ unit: "ft", perContainer: null });
  });
  it("reads a pack count", () => {
    expect(guessUnit("Wago 221-412 PK100")).toMatchObject({ unit: "ea", perContainer: 100 });
    expect(guessUnit("Staples 50PK")).toMatchObject({ unit: "ea", perContainer: 50 });
  });
  it("prefers the price list's own unit", () => {
    expect(guessUnit("NMB 12/2 250 ft coil", "ea")).toMatchObject({ unit: "ea" });
  });
  it("says nothing when the words say nothing: the Twister box's 500/5000 is not guessed", () => {
    expect(guessUnit("IDEAL 30641 500/5000 Twister 341-Tan")).toEqual({ unit: null, perContainer: null, why: "the description doesn't say; ask" });
  });
});

describe("planFifoTake: the take the database stamps, worked out for a preview", () => {
  const lot = (id: string, bought_on: string, pieces: number, cost: number, piecesLeft = pieces, costLeft = cost): LotForTake => ({
    id,
    bought_on,
    created_at: `${bought_on}T12:00:00Z`,
    pieces,
    cost,
    piecesLeft,
    costLeft,
  });

  it("Herringbone: 60 ft of the 8/19 coil ($180.17 for 250 ft) is $43.24, and the shelf keeps $136.93", () => {
    const plan = planFifoTake([lot("L819", "2026-08-19", 250, 180.17)], 60);
    expect(plan).toEqual({ takes: [{ lotId: "L819", qty: 60, cost: 43.24 }], short: 0, cost: 43.24 });
    expect(Math.round((180.17 - plan.cost) * 100) / 100).toBe(136.93);
  });

  it("walks FIFO across two lots, oldest first, one take per lot touched", () => {
    const older = lot("A", "2026-07-31", 250, 180.17, 10, 7.21);
    const newer = lot("B", "2026-08-19", 250, 180.17);
    const plan = planFifoTake([newer, older], 30);
    // The 10 ft left on the older coil go first, at exactly what that coil has left; 20 ft of the newer.
    expect(plan.takes).toEqual([
      { lotId: "A", qty: 10, cost: 7.21 },
      { lotId: "B", qty: 20, cost: 14.41 },
    ]);
    expect(plan.short).toBe(0);
    expect(plan.cost).toBe(21.62);
  });

  it("the take that empties a lot takes its exact remaining dollars, so the lot adds up to the cent", () => {
    const l = lot("C", "2026-08-01", 3, 1);
    const first = planFifoTake([l], 1).takes[0].cost; // 0.33
    const second = planFifoTake([{ ...l, piecesLeft: 2, costLeft: 0.67 }], 1).takes[0].cost; // 0.33
    const last = planFifoTake([{ ...l, piecesLeft: 1, costLeft: 0.34 }], 1).takes[0].cost; // what is left
    expect([first, second, last]).toEqual([0.33, 0.33, 0.34]);
    expect(Math.round((first + second + last) * 100) / 100).toBe(1);
  });

  it("never takes more dollars than a lot has left, however the rounding falls", () => {
    const l = lot("D", "2026-08-01", 4, 0.02, 1.5, 0.0);
    expect(planFifoTake([l], 1).takes[0].cost).toBe(0);
  });

  it("past the shelf is a SHORT at $0, never a cost invented at the newest lot's rate", () => {
    const plan = planFifoTake([lot("E", "2026-08-01", 250, 180.17, 5, 3.6)], 20);
    expect(plan.takes).toEqual([{ lotId: "E", qty: 5, cost: 3.6 }]);
    expect(plan.short).toBe(15);
    expect(plan.cost).toBe(3.6);
  });

  it("skips an emptied lot, and an empty shelf is all short", () => {
    expect(planFifoTake([lot("F", "2026-08-01", 10, 5, 0, 0)], 4)).toEqual({ takes: [], short: 4, cost: 0 });
  });
});

/** Herringbone's 8/19 ticket, with the 12/2 coil at 0 used: the lot is $180.17. */
const ticket = (): (BillLine & { id: string })[] => [
  { id: "a", description: "Flexbox BH bar hanger ground", quantity: 1, amount: 8.82, category: "Electrical" },
  { id: "b", description: "NMB 12/2 w/gnd wire 250 ft coil", quantity: 250, amount: 165.29, category: "Electrical", billed_amount: 0 },
  { id: "c", description: "Flexbox single gang 16 cu in", quantity: 2, amount: 8.9, category: "Electrical" },
  { id: "t", description: "Tax at 9.000 percent", quantity: 1, amount: 16.47, category: "Tax" },
];

describe("restampPlan and lotCostDrift: a lot's stored cost against the paper as it stands", () => {
  it("keeps a lot that is right, restamps one the receipt moved under, unshelves one whose line is gone", () => {
    const lines = ticket();
    const plan = restampPlan(
      [
        { lot_id: "ok", bill_line_id: "b", cost: "180.17", live: true, live_moves: 0 },
        { lot_id: "moved", bill_line_id: "b", cost: "170.00", live: true, live_moves: 0 },
        { lot_id: "gone", bill_line_id: "zzz", cost: "5.00", live: true, live_moves: 0 },
      ],
      lines,
    );
    expect(plan).toEqual([
      { lotId: "ok", action: "keep", cost: 180.17 },
      { lotId: "moved", action: "restamp", cost: 180.17 },
      { lotId: "gone", action: "unshelve", cost: null },
    ]);
  });

  it("never restamps a lot with takes on it: a stamped take's cost never moves after the fact", () => {
    expect(restampPlan([{ lot_id: "used", bill_line_id: "b", cost: "170.00", live: true, live_moves: 3 }], ticket())).toEqual([
      { lotId: "used", action: "keep", cost: null },
    ]);
  });

  it("unshelves a lot whose line's extension went to $0.00: nothing shipped", () => {
    const lines = ticket();
    lines[1] = { ...lines[1], amount: 0 };
    expect(restampPlan([{ lot_id: "L", bill_line_id: "b", cost: "180.17", live: true, live_moves: 0 }], lines)[0].action).toBe("unshelve");
  });

  it("names drift for the daily check, and nothing when the shelf agrees with the paper", () => {
    const lines = ticket();
    expect(lotCostDrift([{ lot_id: "ok", bill_line_id: "b", cost: 180.17 }], lines)).toEqual([]);
    expect(lotCostDrift([{ lot_id: "off", bill_line_id: "b", cost: 180.18 }], lines)).toEqual([{ lotId: "off", stored: 180.18, today: 180.17 }]);
    expect(lotCostDrift([{ lot_id: "old", bill_line_id: "b", cost: 1, live: false }], lines)).toEqual([]);
  });
});

describe("putOnShelfProblem: the refusals, each one a sentence he can act on", () => {
  const ok = { pieces: 250, unit: "ft", lineAmount: 165.29, isTax: false, share: 180.17 };
  it("lets the real coil through", () => expect(putOnShelfProblem(ok)).toBeNull());
  it("wants a count and a unit a person confirmed", () => {
    expect(putOnShelfProblem({ ...ok, pieces: 0 })).toContain("how many");
    expect(putOnShelfProblem({ ...ok, unit: " " })).toContain("counted in");
  });
  it("refuses tax, a $0.00 extension, and a line the job still bills in full", () => {
    expect(putOnShelfProblem({ ...ok, isTax: true })).toContain("tax");
    expect(putOnShelfProblem({ ...ok, lineAmount: 0 })).toContain("$0.00");
    expect(putOnShelfProblem({ ...ok, share: 0 })).toContain("still billed to the job");
  });
});

describe("restampLotsForBill with no lots on the bill", () => {
  it("does nothing and says so, including on a database before 0303", async () => {
    const q = (result: any) => {
      const b: any = { select: () => b, eq: () => b, then: (ok: any) => Promise.resolve(result).then(ok) };
      return b;
    };
    const none = { from: () => q({ data: [], error: null }) };
    expect(await restampLotsForBill(none, "org", "bill")).toEqual({ ok: true, restamped: 0, unshelved: 0 });
    const before = { from: () => q({ data: null, error: { code: "42P01", message: 'relation "public.stock_lot_balance" does not exist' } }) };
    expect(await restampLotsForBill(before, "org", "bill")).toEqual({ ok: true, restamped: 0, unshelved: 0 });
    const broken = { from: () => q({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) };
    expect((await restampLotsForBill(broken, "org", "bill")).ok).toBe(false);
  });
});
