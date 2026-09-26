import { describe, it, expect } from "vitest";
import {
  fmtQty,
  matchShelfItem,
  normUnit,
  officeBellWords,
  parseShelf,
  parseTakes,
  shortOf,
  shortWords,
  takeDoor,
  takeHref,
  takeLine,
  tookWords,
  type ShelfRow,
} from "./stock-take";

/**
 * TOOK FROM STOCK'S WORDS (Shop Stock, Phase 3), in the plan's own sentences: "Took 60 ft of 12/2
 * NM-B for Herringbone · Undo", "Brian took 20 ft of 12/2, the shelf said 5 ft. Count it or file the
 * roll.", "Take It Off INV-078 First".
 */

const SHELF: ShelfRow[] = [
  { id: "i-122", name: "12/2 NM-B", unit: "ft", onHand: 250 },
  { id: "i-142", name: "14/2 NM-B", unit: "ft", onHand: 250 },
  { id: "i-122mc", name: "12/2 MC", unit: "ft", onHand: 100 },
  { id: "i-nut", name: "Twister 341-Tan wire nut", unit: "ea", onHand: 440 },
];

describe("the shelf and the takes, as the database hands them back", () => {
  it("parses shelf_for_crew rows with numerics as strings, and keeps nothing it wasn't told to", () => {
    const rows = parseShelf([{ id: "a", name: " 12/2 NM-B ", unit: "ft", on_hand: "190.000", cost: 136.93 }]);
    expect(rows).toEqual([{ id: "a", name: "12/2 NM-B", unit: "ft", onHand: 190 }]);
    expect(JSON.stringify(rows)).not.toContain("136.93");
  });

  it("parses stock_takes_for_job rows, and a stray cost in the payload never reaches a take", () => {
    const takes = parseTakes([
      { draw_group: "g1", taken_at: "2026-09-24T17:00:00Z", item_id: "i", item: "12/2 NM-B", unit: "ft", qty: "60.000", short: "0", back: "0", who: "Brian", mine: true, billed_on: null, billed_invoice_id: null, can_undo: true, cost: 43.24 },
    ]);
    expect(takes[0]).toMatchObject({ drawGroup: "g1", qty: 60, who: "Brian", canUndo: true, billedOn: null });
    expect(JSON.stringify(takes)).not.toContain("43.24");
  });
});

describe("the words", () => {
  it("says a take the plan's way", () => {
    expect(tookWords({ qty: 60, unit: "ft", item: "12/2 NM-B", job: "Herringbone" })).toBe("Took 60 ft of 12/2 NM-B for Herringbone");
    expect(fmtQty(12.1254)).toBe("12.125");
  });

  it("a take bigger than the shelf still saves, and says so", () => {
    expect(shortOf(5, 20)).toBe(15);
    expect(shortOf(250, 60)).toBe(0);
    expect(shortOf(-15, 10)).toBe(10); // a shelf already below zero shows none
    expect(shortWords(20, "ft")).toBe("20 ft more than the shelf shows — the office will recount");
    expect(tookWords({ qty: 20, unit: "ft", item: "12/2 NM-B", job: "Herringbone", short: 15 })).toBe(
      "Took 20 ft of 12/2 NM-B for Herringbone. 15 ft more than the shelf shows — the office will recount.",
    );
  });

  it("rings the office in the plan's words, and a short says what the shelf showed", () => {
    expect(officeBellWords({ who: "Brian", qty: 60, unit: "ft", item: "12/2 NM-B", job: "Herringbone", short: 0, onHandAfter: 190 }).title).toBe(
      "Brian took 60 ft of 12/2 NM-B for Herringbone",
    );
    const short = officeBellWords({ who: "Brian", qty: 20, unit: "ft", item: "12/2", job: "Herringbone", short: 15, onHandAfter: -15 });
    expect(short.title).toBe("Brian took 20 ft of 12/2, the shelf said 5 ft");
    expect(short.body).toBe("For Herringbone. Count it or file the roll.");
    for (const w of [short.title, short.body]) expect(w).not.toMatch(/\$/);
  });

  it("an Undo becomes Take It Off INV-078 First once an invoice bills the take", () => {
    expect(takeDoor({ canUndo: true, billedOn: null, back: 0 })).toEqual({ kind: "undo" });
    expect(takeDoor({ canUndo: false, billedOn: "INV-078", back: 0 })).toEqual({ kind: "billed", label: "Take It Off INV-078 First" });
    expect(takeDoor({ canUndo: false, billedOn: null, back: 0 })).toEqual({ kind: "none", why: null });
    expect(takeLine({ who: "Brian", qty: 60, unit: "ft", item: "12/2 NM-B", short: 0, back: 0 })).toBe("Brian took 60 ft of 12/2 NM-B");
  });
});

describe("which item did they mean (Nort's fill)", () => {
  it("an exact name wins, words in the name resolve, two matches ask, none says none", () => {
    expect(matchShelfItem(SHELF, "12/2 nm-b")).toEqual({ kind: "one", row: SHELF[0] });
    expect(matchShelfItem(SHELF, "wire nuts")).toEqual({ kind: "one", row: SHELF[3] }); // said in the plural
    expect(matchShelfItem(SHELF, "wire caps")).toEqual({ kind: "none" }); // not in the name: say so, never guess
    expect(matchShelfItem(SHELF, "twister")).toEqual({ kind: "one", row: SHELF[3] });
    const two = matchShelfItem(SHELF, "12/2");
    expect(two.kind).toBe("many");
    if (two.kind === "many") expect(two.rows.map((r) => r.id)).toEqual(["i-122", "i-122mc"]);
    expect(matchShelfItem(SHELF, "12/2 mc")).toEqual({ kind: "one", row: SHELF[2] });
    expect(matchShelfItem(SHELF, "10/3 romex")).toEqual({ kind: "none" });
    expect(matchShelfItem(SHELF, "  ")).toEqual({ kind: "none" });
  });

  it("units are said in the shelf's words", () => {
    expect(normUnit("feet")).toBe("ft");
    expect(normUnit("Foot")).toBe("ft");
    expect(normUnit("each")).toBe("ea");
    expect(normUnit("")).toBe("");
  });

  it("the card's link opens the job's Materials tab with the sheet filled in", () => {
    expect(takeHref("job-1", "i-122", 60)).toBe("/jobs/job-1?tab=materials&take=i-122&qty=60");
    expect(takeHref("job-1", "i-122", null)).toBe("/jobs/job-1?tab=materials&take=i-122");
  });
});
