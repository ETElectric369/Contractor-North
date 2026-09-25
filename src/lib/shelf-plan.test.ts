import { describe, it, expect } from "vitest";
import { excludedReceiptCost, shelfLotCost, type BillLine } from "./bill-itemisation";
import {
  SHELF_NEEDS_LINES,
  SHELF_NO_RETURNS,
  planShelving,
  restampPayload,
  shelfCountGuess,
  suggestShelfItem,
  ticketShelfProblem,
  waitingForShelf,
  type ShelfPickerItem,
} from "./shelf-plan";

/**
 * SHOP STOCK, PHASE 2: PUTTING THINGS ON THE SHELF - the pure half. Every fixture is Erik's own
 * paper: Herringbone's 8/19 CED ticket (bill 11e96fc3), the 7/31 ticket with both coils, the CED
 * STOCK document 8802-1103061, the "1000' REEL, qty 55" counter cut and the Waldow Twister box.
 */

type L = BillLine & { id: string };
const HERRINGBONE_819: L[] = [
  { id: "l0", description: "Flexbox BH bar hanger ground", quantity: 1, unit_price: 8.82, amount: 8.82, category: "Electrical", billable: true, billed_amount: null },
  { id: "l1", description: "NMB 12/2 w/gnd wire 250 ft coil", quantity: 250, unit_price: 0.66, amount: 165.29, category: "Electrical", billable: true, billed_amount: null },
  { id: "l2", description: "Flexbox single gang 16 cu in", quantity: 2, unit_price: 4.45, amount: 8.9, category: "Electrical", billable: true, billed_amount: null },
  { id: "l3", description: "Tax at 9.000 percent", quantity: 1, unit_price: 16.47, amount: 16.47, category: "Tax", billable: true, billed_amount: null },
];

describe("the count a ticket line suggests (filled in, never saved on its own)", () => {
  it("Herringbone's coil: 250 at $0.66 is 250 ft, because the ticket's own columns close", () => {
    expect(shelfCountGuess({ description: "NMB 12/2 w/gnd wire 250 ft coil", quantity: 250, unit_price: 0.66, amount: 165.29 })).toMatchObject({
      pieces: 250,
      unit: "ft",
      bought: 250,
    });
  });

  it("the counter cut: 55 ft off a 1000 ft reel is 55 ft, never 1,000", () => {
    expect(shelfCountGuess({ description: "NMB 6/3 W/GND (1000 ft REEL)", quantity: 55, unit_price: 4.32, amount: 237.66 })).toMatchObject({
      pieces: 55,
      unit: "ft",
      bought: 55,
    });
  });

  it("two coils at $165 each is 2 x 250 = 500 ft", () => {
    expect(shelfCountGuess({ description: "NMB 12/2 W/GND (250 ft Coil)", quantity: 2, unit_price: 165.29, amount: 330.58 })).toMatchObject({
      pieces: 500,
      unit: "ft",
      bought: 2,
    });
  });

  it("CED's R/Y connectors from their own file (the per-hundred price already divided out): 500 ea", () => {
    expect(shelfCountGuess({ description: "RED/YELLOW CONN (R/Y+JUG)", quantity: 500, unit_price: 0.17, amount: 84.85 })).toMatchObject({
      pieces: 500,
      unit: "ea",
    });
  });

  it("a box that says its count: 1 box of 100", () => {
    expect(shelfCountGuess({ description: "WAGO 221-412 100/BX", quantity: 1, unit_price: 0, amount: 38.5 })).toMatchObject({ pieces: 100, unit: "ea", bought: 1 });
  });

  it("the Waldow Twister box: the quantity came out of the product name and the columns don't close, so the person types it", () => {
    expect(shelfCountGuess({ description: "IDEAL 30641 500/5000 Twister 341-Tan", quantity: 500, unit_price: 0.15, amount: 77.39 })).toMatchObject({
      pieces: null,
      bought: 1,
    });
  });
});

describe("planShelving: what the job is billed and what the roll costs, before anything is written", () => {
  it("Herringbone 8/19, 0 used: billed $0, 250 ft on the shelf at $180.17 (the coil plus its $14.88 share of the tax)", () => {
    const plan = planShelving(HERRINGBONE_819, [{ lineId: "l1", pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "12/2 NM-B" }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lots).toEqual([
      { lineId: "l1", billedAmount: 0, pieces: 250, unit: "ft", cost: 180.17, itemId: null, newItemName: "12/2 NM-B", keyPart: null },
    ]);
    // About 72 cents a foot.
    expect(Math.round((plan.lots[0].cost / plan.lots[0].pieces) * 100) / 100).toBe(0.72);
    // The job keeps its own boxes and their tax: $199.48 - $180.17.
    expect(Math.round((199.48 - plan.lots[0].cost) * 100) / 100).toBe(19.31);
  });

  it("used on this job 60: the job is billed $39.67 of the coil, 190 ft go on the shelf, and job part + roll is the ticket", () => {
    const plan = planShelving(HERRINGBONE_819, [{ lineId: "l1", pieces: 250, used: 60, unit: "ft", bought: 250, newItemName: "12/2 NM-B" }]);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.lots[0]).toMatchObject({ billedAmount: 39.67, pieces: 190 });
    expect(plan.lots[0].cost).toBe(excludedReceiptCost(plan.patched));
    expect(plan.lots[0].cost).toBe(shelfLotCost(plan.patched[1], plan.patched));
  });

  it("the reel trap is refused with the receipt's own sentence: 55 ft cut can't be one 1,000 ft reel", () => {
    const reel: L[] = [
      { id: "r", description: "NMB 6/3 W/GND (1000 ft REEL)", quantity: 55, unit_price: 4.32, amount: 237.66, category: "Electrical", billable: true, billed_amount: null },
    ];
    const plan = planShelving(reel, [{ lineId: "r", pieces: 1000, used: 0, unit: "ft", bought: 1, newItemName: "6/3" }]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("This receipt charged $4.32 each for 55 of these");
  });

  it.each([
    [{ pieces: 250, used: 250 }, "used all of it"],
    [{ pieces: 0, used: 0 }, "say how many it bought"],
    [{ pieces: 250, used: -1 }, "0 if none"],
    [{ pieces: 250, used: 0, unit: "" }, "counted in"],
    [{ pieces: 250, used: 0, newItemName: "" }, "pick the item"],
  ])("refuses %j in words (%s)", (over, words) => {
    const plan = planShelving(HERRINGBONE_819, [{ lineId: "l1", unit: "ft", bought: 250, newItemName: "12/2", ...over } as any]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain(words);
  });

  it("tax, a $0.00 extension and a line switched off the bill with some used are refused", () => {
    expect(planShelving(HERRINGBONE_819, [{ lineId: "l3", pieces: 1, used: 0, unit: "ea", newItemName: "tax" }]).ok).toBe(false);
    const zero: L[] = [{ id: "z", description: "back-ordered plate", quantity: 1, unit_price: 3, amount: 0, category: "Electrical", billable: true, billed_amount: null }];
    const z = planShelving(zero, [{ lineId: "z", pieces: 1, used: 0, unit: "ea", newItemName: "plate" }]);
    expect(!z.ok && z.error).toContain("$0.00");
    const off = HERRINGBONE_819.map((l) => (l.id === "l1" ? { ...l, billable: false } : l));
    const o = planShelving(off, [{ lineId: "l1", pieces: 250, used: 10, unit: "ft", bought: 250, newItemName: "12/2" }]);
    expect(!o.ok && o.error).toContain("off the customer's bill");
    // 0 used on a switched-off line is the whole line to the shelf.
    const all = planShelving(off, [{ lineId: "l1", pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "12/2" }]);
    expect(all.ok && all.lots[0].cost).toBe(180.17);
  });

  it("two rolls off one ticket share its tax to the cent, and a roll already there is restamped to its new share", () => {
    const t731: L[] = [
      { id: "a", description: "NMB 12/2 W/GND (250 ft Coil)", quantity: 250, unit_price: 0.66, amount: 165.29, category: "Electrical", billable: true, billed_amount: null },
      { id: "b", description: "NMB 14/2 W/GND (250 ft Coil)", quantity: 250, unit_price: 0.45, amount: 111.6, category: "Electrical", billable: true, billed_amount: 0 },
      { id: "c", description: "breakers", quantity: 1, unit_price: 161.09, amount: 161.09, category: "Electrical", billable: true, billed_amount: null },
      { id: "t", description: "Tax", quantity: 1, unit_price: 39.42, amount: 39.42, category: "Tax", billable: true, billed_amount: null },
    ];
    // The 14/2 went on first, at its share with only it off the ticket.
    const first = shelfLotCost(t731[1], t731);
    expect(first).toBe(121.64);
    const plan = planShelving(t731, [{ lineId: "a", pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "12/2" }]);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.lots[0].cost).toBe(180.17);
    const restamp = restampPayload([{ lot_id: "lot-b", bill_line_id: "b", cost: first, live: true, live_moves: 0 }], plan.patched);
    expect(restamp).toEqual([{ lot_id: "lot-b", cost: shelfLotCost(plan.patched[1], plan.patched) }]);
    expect(Math.round((restamp[0].cost + plan.lots[0].cost) * 100) / 100).toBe(excludedReceiptCost(plan.patched));
    // A roll with takes on it is never sent: its ticket is frozen.
    expect(restampPayload([{ lot_id: "lot-b", bill_line_id: "b", cost: first, live: true, live_moves: 2 }], plan.patched)).toEqual([]);
  });
});

describe("ticketShelfProblem: the whole-ticket gate the tray's button and the server both ask", () => {
  const rows = [
    { description: "RED/YELLOW CONN", amount: 84.85, category: "Materials" },
    { description: "PLSTC TAPE", amount: 20.1, category: "Materials" },
    { description: "Sales Tax", amount: 9.45, category: "Tax" },
  ];
  it("a ticket with no lines can't go on the shelf yet, in the plan's own words", () => {
    expect(ticketShelfProblem([], 114.4, [])).toBe(SHELF_NEEDS_LINES);
    expect(SHELF_NEEDS_LINES).toBe("Add the lines first, so pieces can be taken from it.");
  });
  it("a return is refused", () => {
    expect(ticketShelfProblem(rows, -20, [])).toBe(SHELF_NO_RETURNS);
  });
  it("every line that shipped needs an answer; tax rides along", () => {
    expect(ticketShelfProblem(rows, 114.4, [{ index: 0, notStock: false, pieces: 500, unit: "ea", newItemName: "R/Y" }])).toContain("1 line is still open");
    expect(ticketShelfProblem(rows, 114.4, [{ index: 0, notStock: false, pieces: 500, unit: "ea", newItemName: "R/Y" }, { index: 1, notStock: true }])).toBeNull();
  });
  it("all Not Stock puts nothing on the shelf, so it says to file it elsewhere", () => {
    expect(ticketShelfProblem(rows, 114.4, [{ index: 0, notStock: true }, { index: 1, notStock: true }])).toContain("Every line is Not Stock");
  });
  it("a count of 0 or no item is refused", () => {
    expect(ticketShelfProblem(rows, 114.4, [{ index: 0, notStock: false, pieces: 0, unit: "ea", newItemName: "x" }, { index: 1, notStock: true }])).toContain("how many");
    expect(ticketShelfProblem(rows, 114.4, [{ index: 0, notStock: false, pieces: 5, unit: "ea", newItemName: "" }, { index: 1, notStock: true }])).toContain("pick the item");
  });
});

describe("suggestShelfItem: pre-selected only on an exact part number or name, in the same unit", () => {
  const items: ShelfPickerItem[] = [
    { id: "i-122", name: "12/2 NM-B", unit: "ft", key_part: null },
    { id: "i-ry", name: "Red/Yellow connectors", unit: "ea", key_part: "RYJUG" },
  ];
  it("same part number", () => {
    expect(suggestShelfItem(items, { description: "RED/YELLOW CONN", partNumber: "R/Y+JUG" }, "ea")).toMatchObject({ id: "i-ry" });
  });
  it("same name, same unit", () => {
    expect(suggestShelfItem(items, { description: "12/2 nm-b" }, "ft")).toMatchObject({ id: "i-122" });
  });
  it("a near name is not a match, and neither is the right item in the wrong unit", () => {
    expect(suggestShelfItem(items, { description: "12/2 NM-B cable" }, "ft")).toBeNull();
    expect(suggestShelfItem(items, { description: "12/2 NM-B" }, "roll")).toBeNull();
  });
});

describe("Waiting For The Shelf: suggested, never moved", () => {
  const base = { billId: "b", jobId: "j011", jobLabel: "Herringbone", category: "Electrical", billable: true, hasLot: false, billDate: "2026-07-31" };
  it("the Herringbone 14/2 (billed $0, no roll), the Waldow Twister box, the STOCK document and a lineless STOCK paper", () => {
    const w = waitingForShelf({
      lines: [
        { ...base, lineId: "142", description: "NMB 14/2 w/gnd 250 ft coil", quantity: 250, amount: 111.6, billedAmount: 0 },
        { ...base, lineId: "tw", jobLabel: "Jason Waldow", description: "IDEAL 30641 500/5000 Twister 341-Tan", quantity: 500, amount: 77.39, billedAmount: null },
        { ...base, lineId: "brk", description: "SQD HOM120 Miniature Circuit", quantity: 3, amount: 23.13, billedAmount: null },
        { ...base, lineId: "tax", description: "Tax", quantity: 1, amount: 39.42, category: "Tax", billedAmount: null },
        { ...base, lineId: "done", description: "NMB 12/2 250 ft coil", quantity: 250, amount: 165.29, billedAmount: 0, hasLot: true },
      ],
      stockDocuments: [{ id: "si", number: "8802-1103061", total: "114.40", words: "STOCK" }],
      linelessPapers: [{ id: "p", title: "CED ticket", words: "STOCK" }],
    });
    expect(w.map((x) => [x.key, x.kind, x.door])).toEqual([
      ["line:142", "part_billed", "Put The Rest On The Shelf"],
      ["line:tw", "container", "Put The Rest On The Shelf"],
      ["doc:si", "stock_document", "Record To Shelf"],
      ["paper:p", "lineless_paper", "Fix Details"],
    ]);
    expect(w[0].why).toContain("None of its $111.60 is billed to the customer");
    expect(w[1].why).toContain("The ticket read 500 on it");
    expect(w[2].title).toBe("CED 8802-1103061, $114.40");
    expect(w[3].why).toContain(SHELF_NEEDS_LINES);
  });
});
