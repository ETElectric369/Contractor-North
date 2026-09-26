import { describe, it, expect } from "vitest";
import {
  markStock,
  qtyWords,
  stockImportRows,
  stockLineWords,
  stockShortsSentence,
  stockTakesOnJob,
  stockTotals,
  stockZeroCostSentence,
  unclaimedTakes,
  type StockMoveRow,
} from "./stock-billing";
import { billedWorkOnInvoices, computeJobProgress } from "./job-progress-math";
import { computeUnbilledWork, foldClaims } from "./unbilled-work";
import { finishWouldLeaveOffBill } from "./finish-job-words";
import { pulledIntoSentence } from "./actuals-draw";
import { groupJobCosts } from "./job-cost-groups";

const ITEM = { id: "i1", name: "12/2 NM-B", unit: "ft" };
const NUTS = { id: "i2", name: "Twister wire nut", unit: "ea" };
const move = (m: Partial<StockMoveRow> & { id: string }): StockMoveRow => ({
  item_id: "i1",
  draw_group: "g1",
  kind: "draw",
  qty: 0,
  cost: 0,
  created_at: "2026-09-24T16:00:00Z",
  ...m,
});

describe("the customer's words for a take", () => {
  it("names the item and the count in its unit, and nothing about where it sat", () => {
    expect(stockLineWords("12/2 NM-B cable", 40, "ft")).toBe("12/2 NM-B cable, 40 ft");
    expect(stockLineWords("  Twister   wire nut ", 25, "ea")).toBe("Twister wire nut, 25 ea");
    expect(stockLineWords("12/2 NM-B", 12.125, "ft")).toBe("12/2 NM-B, 12.125 ft");
    const w = stockLineWords("12/2 NM-B", 60, "ft").toLowerCase();
    for (const word of ["shelf", "lot", "roll", "stock", "supplier", "ced"]) expect(w).not.toContain(word);
  });
  it("writes a count the way a person does", () => {
    expect(qtyWords(60)).toBe("60");
    expect(qtyWords(12.5)).toBe("12.5");
    expect(qtyWords(0.125)).toBe("0.125");
    expect(qtyWords(1.0004)).toBe("1");
  });
});

describe("a job's moves fold into takes and shorts", () => {
  it("one take across two rolls is one take, at the sum the database stamped", () => {
    const { takes, shorts } = stockTakesOnJob(
      [move({ id: "m2", qty: 20, cost: 14.41 }), move({ id: "m1", qty: 10, cost: 7.21, created_at: "2026-09-24T15:59:59Z" })],
      [ITEM],
    );
    expect(shorts).toEqual([]);
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ group: "g1", item: "12/2 NM-B", unit: "ft", qty: 30, cost: 21.62, moveIds: ["m1", "m2"], takenAt: "2026-09-24T15:59:59Z" });
  });
  it("pieces carried back come off the take; a take carried back whole bills nothing", () => {
    const { takes } = stockTakesOnJob(
      [
        move({ id: "d1", draw_group: "g1", qty: 60, cost: 43.24 }),
        move({ id: "r1", draw_group: null, kind: "job_return", qty: 15, cost: 10.81, returns_move_id: "d1" }),
        move({ id: "d2", draw_group: "g2", qty: 5, cost: 3.6 }),
        move({ id: "r2", draw_group: null, kind: "job_return", qty: 5, cost: 3.6, returns_move_id: "d2" }),
      ],
      [ITEM],
    );
    expect(takes.map((t) => [t.group, t.qty, t.cost])).toEqual([["g1", 45, 32.43]]);
  });
  it("an unsettled short is a short, a settled one is not, and neither is a take", () => {
    const { takes, shorts } = stockTakesOnJob(
      [
        move({ id: "s1", draw_group: "g1", kind: "short", qty: 20 }),
        move({ id: "s2", draw_group: "g2", kind: "short", qty: 5, settled_by: "g3" }),
        move({ id: "d3", draw_group: "g3", qty: 5, cost: 3.6 }),
        move({ id: "s3", draw_group: "g4", item_id: "i2", kind: "short", qty: 12 }),
      ],
      [ITEM, NUTS],
    );
    expect(takes.map((t) => t.group)).toEqual(["g3"]);
    expect(shorts.map((s) => [s.item, s.qty])).toEqual([
      ["12/2 NM-B", 20],
      ["Twister wire nut", 12],
    ]);
  });
  it("a take any of whose moves another invoice holds is held whole", () => {
    const { takes } = stockTakesOnJob([move({ id: "a", qty: 10, cost: 7.21 }), move({ id: "b", qty: 20, cost: 14.41 }), move({ id: "c", draw_group: "g2", qty: 5, cost: 3.6 })], [ITEM]);
    const split = unclaimedTakes(takes, new Set(["b"]));
    expect(split.held.map((t) => t.group)).toEqual(["g1"]);
    expect(split.free.map((t) => t.group)).toEqual(["g2"]);
  });
});

describe("a take's line bills exactly its cost at the invoice's markup", () => {
  const take = (qty: number, cost: number, group = "g1") => ({ group, itemId: "i1", item: "12/2 NM-B", unit: "ft", qty, cost, zeroQty: 0, moveIds: [`${group}-m`], takenAt: "2026-09-24T16:00:00Z" });
  it("60 ft for Andrew at 15%: $43.24 of cost bills $49.73, as one line with the count in its words", () => {
    const { rows } = stockImportRows([take(60, 43.24)], 15);
    expect(rows).toEqual([{ import_key: "stock:g1", description: "12/2 NM-B, 60 ft", quantity: 1, unit: "ea", unit_price: 49.73, source_ids: ["g1-m"] }]);
  });
  it("shows count x price only when it lands on the sell to the cent (60 ft at 11%: 60 ft x $0.80 = $48.00)", () => {
    expect(markStock(43.24, 11)).toBe(48);
    const { rows } = stockImportRows([take(60, 43.24)], 11);
    expect(rows[0]).toMatchObject({ quantity: 60, unit: "ft", unit_price: 0.8, description: "12/2 NM-B, 60 ft" });
    expect(Math.round(rows[0].quantity * rows[0].unit_price * 100) / 100).toBe(48);
  });
  it("a count finer than the invoice's two decimals is never rounded onto the bill", () => {
    const { rows } = stockImportRows([take(12.125, 8.74)], 0);
    expect(rows[0]).toMatchObject({ quantity: 1, unit_price: 8.74, description: "12/2 NM-B, 12.125 ft" });
  });
  it("one line per take, never merged, each claimed by its own moves", () => {
    const { rows } = stockImportRows([take(60, 43.24, "g1"), take(20, 14.41, "g2")], 15);
    expect(rows.map((r) => [r.import_key, r.source_ids])).toEqual([
      ["stock:g1", ["g1-m"]],
      ["stock:g2", ["g2-m"]],
    ]);
    // Every row lands on mark(cost) exactly: the line total is the promise.
    for (const [r, cost] of [[rows[0], 43.24], [rows[1], 14.41]] as const) expect(Math.round(r.quantity * r.unit_price * 100) / 100).toBe(markStock(cost, 15));
    expect(stockTotals([take(60, 43.24, "g1"), take(20, 14.41, "g2")], 15)).toEqual({ count: 2, cost: 57.65, billed: 66.3 });
  });
  it("a take off a roll with no cost bills nothing, and is said", () => {
    const zero = { ...take(10, 0), zeroQty: 10 };
    const { rows, zeroCost } = stockImportRows([zero], 25);
    expect(rows).toEqual([]);
    expect(zeroCost).toHaveLength(1);
    expect(stockZeroCostSentence(zeroCost)).toBe("12/2 NM-B, 10 ft came off a roll with no cost on it, so it isn't on the bill - add the line to the invoice by hand");
  });
});

describe("a take that runs from a roll with no cost into a costed one (audit v1018, stock-1)", () => {
  // 40 ft off a roll counted in with no cost (lot Z), then 20 ft off a $100 / 100 ft receipt roll (lot C).
  const LOTS = [
    { id: "Z", cost: 0 },
    { id: "C", cost: 100 },
  ];
  const moves = [move({ id: "a", qty: 40, cost: 0, lot_id: "Z" }), move({ id: "b", qty: 20, cost: 20, lot_id: "C" })];
  it("the take carries how many of its pieces came off a roll with no cost on it", () => {
    const { takes } = stockTakesOnJob(moves, [ITEM], LOTS);
    expect(takes[0]).toMatchObject({ qty: 60, cost: 20, zeroQty: 40, moveIds: ["a", "b"] });
    // Pieces carried back off the $0 roll come off the $0 count too.
    const back = stockTakesOnJob([...moves, move({ id: "r", draw_group: null, kind: "job_return", qty: 15, cost: 0, returns_move_id: "a" })], [ITEM], LOTS);
    expect(back.takes[0]).toMatchObject({ qty: 45, cost: 20, zeroQty: 25 });
    // Every piece with a cost: nothing to say.
    expect(stockTakesOnJob([move({ id: "c", qty: 20, cost: 20, lot_id: "C" })], [ITEM], LOTS).takes[0].zeroQty).toBe(0);
  });
  it("the priced part bills once, and the line carries only the priced pieces, so the hand-added rest sums to the take", () => {
    const { takes } = stockTakesOnJob(moves, [ITEM], LOTS);
    const { rows, zeroCost } = stockImportRows(takes, 25);
    expect(rows).toHaveLength(1);
    // 20 ft at $1.25 = $25.00: the words and the count are the 20 ft that were priced, never 60.
    expect(rows[0]).toEqual({ import_key: "stock:g1", description: "12/2 NM-B, 20 ft", quantity: 20, unit: "ft", unit_price: 1.25, source_ids: ["a", "b"] });
    expect(stockTotals(takes, 25)).toEqual({ count: 1, cost: 20, billed: 25 });
    expect(zeroCost).toHaveLength(1);
    expect(stockZeroCostSentence(zeroCost)).toBe(
      "40 ft of 12/2 NM-B came off a roll with no cost on it, so its line bills only 20 ft - add the other 40 ft to the invoice by hand",
    );
    // A sell that doesn't divide evenly is 1 x the sell, and the words still say only the priced 20 ft.
    const odd = stockImportRows(stockTakesOnJob([moves[0], move({ id: "b", qty: 20, cost: 20.01, lot_id: "C" })], [ITEM], LOTS).takes, 0).rows[0];
    expect(odd).toMatchObject({ description: "12/2 NM-B, 20 ft", quantity: 1, unit: "ea", unit_price: 20.01 });
  });
  it("a whole-$0 take and a part-$0 take are both named, each in its own words", () => {
    const { takes } = stockTakesOnJob(
      [...moves, move({ id: "z", draw_group: "g2", item_id: "i2", qty: 12, cost: 0, lot_id: "NZ", created_at: "2026-09-24T17:00:00Z" })],
      [ITEM, NUTS],
      [...LOTS, { id: "NZ", cost: "0.00" }],
    );
    const { rows, zeroCost } = stockImportRows(takes, 25);
    expect(rows.map((r) => r.import_key)).toEqual(["stock:g1"]);
    expect(stockZeroCostSentence(zeroCost)).toBe(
      "Twister wire nut, 12 ea came off a roll with no cost on it, so it isn't on the bill - add the line to the invoice by hand. 40 ft of 12/2 NM-B came off a roll with no cost on it, so its line bills only 20 ft - add the other 40 ft to the invoice by hand",
    );
  });
  it("a costed roll's $0 tail (its rounding already used its dollars up) is NOT 'no cost': nothing to add by hand", () => {
    // A box of 100 wire nuts at $10.50 stamps $0.11 a piece, so its last pieces stamp $0.00. A 2-piece
    // take spanning piece 100 of that box ($0.00) and piece 1 of the next ($0.11).
    const nutLots = [
      { id: "B1", cost: 10.5 },
      { id: "B2", cost: 10.5 },
    ];
    const tail = stockTakesOnJob(
      [move({ id: "t1", item_id: "i2", qty: 1, cost: 0, lot_id: "B1" }), move({ id: "t2", item_id: "i2", qty: 1, cost: 0.11, lot_id: "B2" })],
      [NUTS],
      nutLots,
    );
    expect(tail.takes[0]).toMatchObject({ qty: 2, cost: 0.11, zeroQty: 0 });
    const plan = stockImportRows(tail.takes, 0);
    expect(plan.zeroCost).toEqual([]);
    expect(plan.rows[0]).toMatchObject({ description: "Twister wire nut, 2 ea", unit_price: 0.11 });
    // A take made only of the $0 tail bills nothing, is never called "no cost on it", and its Costs
    // tab row says why nothing is owed.
    const only = stockTakesOnJob([move({ id: "t3", item_id: "i2", qty: 1, cost: 0, lot_id: "B1" })], [NUTS], nutLots);
    expect(stockImportRows(only.takes, 25)).toEqual({ rows: [], zeroCost: [] });
    const u = computeUnbilledWork({ jobEntries: [], nonBillableCodes: new Set<string>(), defaultRate: 100, levelRate: null, pos: [], bills: [], markupPct: 25, claims: foldClaims([], true), stock: only });
    expect(u.stockNoCostWords).toBeNull();
    expect(u.costRows.find((r) => r.kind === "stock")).toMatchObject({ state: "nothing", why: "stock_cost_used" });
  });
  it("the Unbilled card and the Costs tab say it too, from the same rule", () => {
    const stock = stockTakesOnJob(moves, [ITEM], LOTS);
    const u = computeUnbilledWork({
      jobEntries: [],
      nonBillableCodes: new Set<string>(),
      defaultRate: 100,
      levelRate: null,
      pos: [],
      bills: [],
      markupPct: 25,
      claims: foldClaims([], true),
      stock,
    });
    expect([u.stockCount, u.stockBilled]).toEqual([1, 25]);
    expect(u.stockNoCostWords).toContain("its line bills only 20 ft");
    const row = u.costRows.find((r) => r.kind === "stock");
    expect(row).toMatchObject({ state: "open", note: expect.stringContaining("40 ft of 12/2 NM-B came off a roll with no cost on it") });
    expect(groupJobCosts([], u.costRows).stock["stock:g1"].note).toContain("add the other 40 ft to the invoice by hand");
    // Every piece priced: no words anywhere.
    const priced = computeUnbilledWork({ jobEntries: [], nonBillableCodes: new Set<string>(), defaultRate: 100, levelRate: null, pos: [], bills: [], markupPct: 25, claims: foldClaims([], true), stock: stockTakesOnJob([move({ id: "c", qty: 20, cost: 20, lot_id: "C" })], [ITEM], LOTS) });
    expect(priced.stockNoCostWords).toBeNull();
    expect(priced.costRows.find((r) => r.kind === "stock")).not.toHaveProperty("note");
  });
  it("once billed, the take's row says the past fact with no instruction, and the card goes quiet", () => {
    const stock = stockTakesOnJob(moves, [ITEM], LOTS);
    const claims = foldClaims([{ id: "inv1", invoice_number: "INV-090", status: "draft", created_at: "2026-09-25T00:00:00Z", invoice_items: [{ import_key: "stock:g1", source_ids: ["a", "b"] }] }], true);
    const u = computeUnbilledWork({ jobEntries: [], nonBillableCodes: new Set<string>(), defaultRate: 100, levelRate: null, pos: [], bills: [], markupPct: 25, claims, stock });
    expect(u.stockNoCostWords).toBeNull();
    const row = u.costRows.find((r) => r.kind === "stock");
    expect(row).toMatchObject({ state: "billed", note: "40 ft of it came off a roll with no cost on it and wasn't priced" });
  });
  it("a take with no priced piece never stands on the Unbilled card for good: its Costs tab row says it", () => {
    const whole = stockTakesOnJob([move({ id: "w", qty: 10, cost: 0, lot_id: "Z" })], [ITEM], LOTS);
    const u = computeUnbilledWork({ jobEntries: [], nonBillableCodes: new Set<string>(), defaultRate: 100, levelRate: null, pos: [], bills: [], markupPct: 25, claims: foldClaims([], true), stock: whole });
    expect(u.stockNoCostWords).toBeNull();
    expect(u.costRows.find((r) => r.kind === "stock")).toMatchObject({ state: "nothing", why: "stock_no_cost" });
    // The importer still says it at the moment it builds the invoice.
    expect(stockZeroCostSentence(stockImportRows(whole.takes, 25).zeroCost)).toContain("so it isn't on the bill");
  });
});

describe("pieces taken past the shelf are said, in one sentence", () => {
  it("names what and says what settles it; one item counted once", () => {
    expect(stockShortsSentence([])).toBeNull();
    const one = stockShortsSentence([{ id: "s", item: "12/2 NM-B", unit: "ft", qty: 20, takenAt: "x" }]);
    expect(one).toBe(
      "20 ft of 12/2 NM-B was taken from stock with no roll behind it yet, so it isn't on the bill yet. File the roll on Shop Stock, then Settle From The Shelf — or Undo the take.",
    );
    const two = stockShortsSentence([
      { id: "a", item: "12/2 NM-B", unit: "ft", qty: 15, takenAt: "x" },
      { id: "b", item: "12/2 NM-B", unit: "ft", qty: 5, takenAt: "y" },
      { id: "c", item: "Twister wire nut", unit: "ea", qty: 12, takenAt: "z" },
    ]);
    expect(two).toBe(
      "20 ft of 12/2 NM-B and 12 ea of Twister wire nut were taken from stock with no roll behind them yet, so they aren't on the bill yet. File the roll on Shop Stock, then Settle From The Shelf — or Undo the take.",
    );
  });
});

describe("the takes reach every figure an invoice is built from", () => {
  const takes = stockTakesOnJob(
    [move({ id: "d1", draw_group: "g1", qty: 60, cost: 43.24 }), move({ id: "d2", draw_group: "g2", qty: 20, cost: 14.41 }), move({ id: "s1", draw_group: "g3", kind: "short", qty: 5 })],
    [ITEM],
  );
  const base = {
    jobEntries: [],
    nonBillableCodes: new Set<string>(),
    defaultRate: 100,
    levelRate: null,
    pos: [],
    bills: [],
    markupPct: 15,
  };
  it("the Unbilled card counts unclaimed takes at the bills' markup, and names the short", () => {
    const u = computeUnbilledWork({ ...base, claims: foldClaims([], true), stock: takes });
    expect([u.stockCount, u.stockAmount, u.stockBilled, u.total, u.stockShorts]).toEqual([2, 57.65, 66.3, 66.3, 1]);
    expect(u.stockShortsWords).toContain("5 ft of 12/2 NM-B was taken from stock");
  });
  it("a take another invoice holds is not unbilled, and is counted with what that invoice holds", () => {
    const claims = foldClaims([{ id: "inv", invoice_number: "INV-080", status: "draft", created_at: "2026-09-24", invoice_items: [{ import_key: "stock:g1", source_ids: ["d1"] }] }], true);
    const u = computeUnbilledWork({ ...base, claims, stock: takes });
    expect([u.stockCount, u.stockBilled, u.claimedCount, u.claimedOn]).toEqual([1, 16.57, 1, ["INV-080"]]);
  });
  it("with no takes (every org today) nothing moves", () => {
    const u = computeUnbilledWork({ ...base, claims: foldClaims([], true) });
    expect([u.stockCount, u.stockAmount, u.stockBilled, u.stockShorts, u.stockShortsWords, u.total]).toEqual([0, 0, 0, 0, null, 0]);
    const withEmpty = computeUnbilledWork({ ...base, claims: foldClaims([], true), stock: { takes: [], shorts: [] } });
    expect(withEmpty).toEqual(u);
  });
  it("the Costs tab gets one verdict per take from the same loop: open, billed on its holder, or nothing when it costs nothing", () => {
    const zero = stockTakesOnJob([move({ id: "z1", draw_group: "gz", item_id: "i2", qty: 12, cost: 0, lot_id: "NZ" })], [NUTS], [{ id: "NZ", cost: 0 }]).takes;
    const claims = foldClaims([{ id: "inv", invoice_number: "INV-080", status: "draft", created_at: "2026-09-24", invoice_items: [{ import_key: "stock:g1", source_ids: ["d1"] }] }], true);
    const u = computeUnbilledWork({ ...base, claims, stock: { takes: [...takes.takes, ...zero], shorts: takes.shorts } });
    const stockRows = u.costRows.filter((r) => r.kind === "stock");
    expect(stockRows.map((r) => [r.id, r.state === "billed" ? r.invoice.invoice_number : r.state === "nothing" ? `nothing:${r.why}` : r.state])).toEqual([
      ["stock:g1", "INV-080"],
      ["stock:g2", "open"],
      ["stock:gz", "nothing:stock_no_cost"],
    ]);
    const open = stockRows.filter((r) => r.state === "open");
    // One decision: the open takes ARE what stockCount / stockAmount counted.
    expect(open.length).toBe(u.stockCount);
    expect(open.reduce((s, r) => s + r.cost, 0)).toBe(u.stockAmount);
    expect(open[0]).toMatchObject({ label: "From Stock · 12/2 NM-B, 20 ft", cost: 14.41 });
  });
  it("Time & Material: an open take is in the unbilled half, a billed one is its Materials line in the billed half", () => {
    const claims = foldClaims([{ id: "inv", invoice_number: "INV-080", status: "sent", created_at: "2026-09-24", invoice_items: [{ import_key: "stock:g1", source_ids: ["d1"] }] }], true);
    const u = computeUnbilledWork({ ...base, claims, stock: takes });
    const billed = billedWorkOnInvoices([
      { status: "sent", invoice_kind: "standard", invoice_items: [{ import_source: "costs", line_kind: "materials", unit: "ea", description: "12/2 NM-B, 60 ft", line_total: 49.73 }] },
    ]);
    const p = { billingTypeRaw: "tm", quotes: [], invoices: [], billableLabor: 0, pos: [], bills: [], markupPercent: 15 };
    expect(computeJobProgress({ ...p, tmWork: { billed, unbilled: u.total } }).workToDate).toBe(66.3);
  });
  it("work to date carries every take, billed or not, one rounding per take", () => {
    const p = { billingTypeRaw: "fixed", quotes: [], invoices: [], billableLabor: 0, pos: [], bills: [], markupPercent: 15 };
    expect(computeJobProgress({ ...p, stockTakes: takes.takes }).workToDate).toBe(66.3);
    expect(computeJobProgress(p).workToDate).toBe(0);
    expect(computeJobProgress({ ...p, stockTakes: [] })).toEqual(computeJobProgress(p));
  });
  it("Finish Job and a refresh say the takes in the office's words", () => {
    expect(finishWouldLeaveOffBill({ hours: 0, laborAmount: 0, billsCount: 0, billsBilled: 0, stockCount: 2, stockBilled: 66.3 })).toContain("2 takes from stock ($66.30)");
    expect(pulledIntoSentence("INV-078", { hours: 0, bills: 1, stock: 1 }, { hours: 0, bills: 0, stock: 2 })).toBe(
      "Pulled 1 bill and 1 take from stock into INV-078. Still not on it: 2 takes from stock - open INV-078 and tap Materials from Costs to see what is holding them back.",
    );
  });
});
