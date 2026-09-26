import { describe, it, expect } from "vitest";
import {
  belowZeroWords,
  fmtQty,
  matchShelfItem,
  normUnit,
  officeBellOpensShelf,
  officeBellWords,
  parseShelf,
  parseTakes,
  settleRefusalWords,
  shortOf,
  shortWords,
  takeDoor,
  takeHref,
  takeLine,
  takeShort,
  takeShortWords,
  takeUnheardWords,
  tookWords,
  type ShelfRow,
} from "./stock-take";

/**
 * TOOK FROM STOCK'S WORDS (Shop Stock, Phase 3), in the plan's own sentences: "Took 60 ft of 12/2
 * NM-B for Herringbone · Undo", "Brian took 20 ft of 12/2, the shelf said 5 ft. Count it or file the
 * roll.", "Take It Off INV-078 First".
 */

const SHELF: ShelfRow[] = [
  { id: "i-122", name: "12/2 NM-B", unit: "ft", onHand: 250, takeable: 250 },
  { id: "i-142", name: "14/2 NM-B", unit: "ft", onHand: 250, takeable: 250 },
  { id: "i-122mc", name: "12/2 MC", unit: "ft", onHand: 100, takeable: 100 },
  { id: "i-nut", name: "Twister 341-Tan wire nut", unit: "ea", onHand: 440, takeable: 440 },
];

describe("the shelf and the takes, as the database hands them back", () => {
  it("parses shelf_for_crew rows with numerics as strings, and keeps nothing it wasn't told to", () => {
    const rows = parseShelf([{ id: "a", name: " 12/2 NM-B ", unit: "ft", on_hand: "190.000", takeable: "150.000", cost: 136.93 }]);
    expect(rows).toEqual([{ id: "a", name: "12/2 NM-B", unit: "ft", onHand: 190, takeable: 150 }]);
    expect(JSON.stringify(rows)).not.toContain("136.93");
    // A database without 0344 sends no takeable: it reads as the count, the old behaviour.
    expect(parseShelf([{ id: "b", name: "x", unit: "ea", on_hand: "7" }])[0].takeable).toBe(7);
  });

  it("parses stock_takes_for_job rows, and a stray cost in the payload never reaches a take", () => {
    const takes = parseTakes([
      { draw_group: "g1", taken_at: "2026-09-24T17:00:00Z", item_id: "i", item: "12/2 NM-B", unit: "ft", qty: "60.000", short: "0", back: "0", who: "Brian", mine: true, billed_on: null, billed_invoice_id: null, can_undo: true, cost: 43.24 },
    ]);
    expect(takes[0]).toMatchObject({ drawGroup: "g1", qty: 60, who: "Brian", canUndo: true, billedOn: null, partBilled: false });
    expect(JSON.stringify(takes)).not.toContain("43.24");
    // 0345's part_billed rides only with a billing invoice; before 0345 it is simply absent (false).
    const part = parseTakes([{ draw_group: "g2", billed_on: "INV-078", part_billed: true }, { draw_group: "g3", billed_on: null, part_billed: true }, { draw_group: "g4", billed_on: "INV-078" }]);
    expect(part.map((t) => t.partBilled)).toEqual([true, false, false]);
    // 0348's settled_by_office: true only when the database says so (absent before 0348).
    const settled = parseTakes([{ draw_group: "g5", settled_by_office: true }, { draw_group: "g6", settled_by_office: "yes" }, { draw_group: "g7" }]);
    expect(settled.map((t) => t.settledByOffice)).toEqual([true, false, false]);
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
    expect(shortWords(20, "ft")).toBe("20 ft more than the shelf shows — the office will settle it");
    expect(tookWords({ qty: 20, unit: "ft", item: "12/2 NM-B", job: "Herringbone", short: 15 })).toBe(
      "Took 20 ft of 12/2 NM-B for Herringbone. 15 ft more than the shelf shows — the office will settle it.",
    );
  });

  it("pieces the count shows but no filed roll holds: the sheet, the toast and the bell all say that (0344's takeable)", () => {
    // Count It set 12/2 to 100 ft with no roll behind it; Brian takes 40.
    const row = { onHand: 100, takeable: 0 };
    expect(takeShort(row, 40)).toEqual({ short: 40, past: 0 });
    expect(takeShortWords({ ...takeShort(row, 40), unit: "ft" })).toBe("40 ft of that isn't on a filed roll yet — it still saves, and the office settles it");
    // stock_draw hands back on_hand 60 and a 40 ft short: the toast agrees with the sheet.
    expect(tookWords({ qty: 40, unit: "ft", item: "12/2 NM-B", job: "Herringbone", short: 40, onHandAfter: 60 })).toBe(
      "Took 40 ft of 12/2 NM-B for Herringbone. 40 ft of that isn't on a filed roll yet — it still saves, and the office settles it.",
    );
    const bell = officeBellWords({ who: "Brian", qty: 40, unit: "ft", item: "12/2 NM-B", job: "Herringbone", short: 40, onHandAfter: 60 });
    expect(bell.title).toBe("Brian took 40 ft of 12/2 NM-B; 40 ft of it isn't on a filed roll");
    expect(bell.title).not.toContain("the shelf said");
    // Enough on filed rolls: nothing to say.
    expect(takeShortWords({ ...takeShort({ onHand: 100, takeable: 100 }, 40), unit: "ft" })).toBeNull();
    // Past the count as well: the count is what the crew sees, so that is what is said.
    expect(takeShortWords({ ...takeShort({ onHand: 30, takeable: 10 }, 40), unit: "ft" })).toBe("10 ft more than the shelf shows — the office will settle it");
  });

  it("never sends the office to count a short it can't settle by counting", () => {
    const bell = officeBellWords({ who: "Brian", qty: 20, unit: "ft", item: "12/2", job: "Herringbone", short: 15, onHandAfter: -15 });
    expect(bell.body).toBe("For Herringbone. File the roll on Shop Stock, then Settle From The Shelf — or Undo the take.");
    expect(bell.body).not.toMatch(/count it/i);
    expect(settleRefusalWords("Only 0 on the shelf, and 15 were taken past it. File the roll or count the shelf first.")).toBe(
      "Only 0 on the shelf, and 15 were taken past it. A count can't settle it: file the roll on the shelf first, or Undo the take.",
    );
    expect(settleRefusalWords("Something else.")).toBe("Something else.");
  });

  it("rings the office in the plan's words, and a short says what the shelf showed", () => {
    expect(officeBellWords({ who: "Brian", qty: 60, unit: "ft", item: "12/2 NM-B", job: "Herringbone", short: 0, onHandAfter: 190 }).title).toBe(
      "Brian took 60 ft of 12/2 NM-B for Herringbone",
    );
    const short = officeBellWords({ who: "Brian", qty: 20, unit: "ft", item: "12/2", job: "Herringbone", short: 15, onHandAfter: -15 });
    expect(short.title).toBe("Brian took 20 ft of 12/2, the shelf said 5 ft");
    expect(short.body).toBe("For Herringbone. File the roll on Shop Stock, then Settle From The Shelf — or Undo the take.");
    for (const w of [short.title, short.body]) expect(w).not.toMatch(/\$/);
  });

  it("an Undo becomes Take It Off INV-078 First once an invoice bills the take", () => {
    expect(takeDoor({ canUndo: true, billedOn: null, back: 0 })).toEqual({ kind: "undo" });
    expect(takeDoor({ canUndo: false, billedOn: "INV-078", back: 0 })).toEqual({ kind: "billed", label: "Take It Off INV-078 First", status: "Billed on INV-078", part: false });
    // The settled pieces of its short not on an invoice yet: part billed, as the Costs tab counts it.
    expect(takeDoor({ canUndo: false, billedOn: "INV-078", back: 0, partBilled: true })).toEqual({
      kind: "billed",
      label: "Take It Off INV-078 First",
      status: "Part billed on INV-078, the rest not billed yet",
      part: true,
    });
    // Brought back in part: says why there is no Undo, and names no door the app doesn't have.
    const back = takeDoor({ canUndo: false, billedOn: null, back: 5 });
    expect(back).toEqual({ kind: "none", why: "Some of it came back to the shelf, so this take can't be undone." });
    expect(takeDoor({ canUndo: false, billedOn: null, back: 0 })).toEqual({ kind: "none", why: null });
    // The office settled the short inside a tech's own take: his Undo is gone, and the row says who can (audit v1018).
    expect(takeDoor({ canUndo: false, billedOn: null, back: 0, settledByOffice: true })).toEqual({
      kind: "none",
      why: "The office settled part of this take, so ask the office to undo it.",
    });
    // The office's own view of it still has Undo, and a billed one still names its invoice first.
    expect(takeDoor({ canUndo: true, billedOn: null, back: 0, settledByOffice: true })).toEqual({ kind: "undo" });
    expect(takeDoor({ canUndo: false, billedOn: "INV-078", back: 0, settledByOffice: true }).kind).toBe("billed");
    expect(takeLine({ who: "Brian", qty: 60, unit: "ft", item: "12/2 NM-B", short: 0, back: 0 })).toBe("Brian took 60 ft of 12/2 NM-B");
  });
});

describe("never silent (audit v1018)", () => {
  it("a take that leaves the shelf below zero with no short says so, in the toast and the bell", () => {
    expect(belowZeroWords(190, "ft")).toBeNull();
    expect(belowZeroWords(0, "ft")).toBeNull();
    expect(belowZeroWords(undefined, "ft")).toBeNull();
    expect(tookWords({ qty: 90, unit: "ft", item: "12/2 NM-B", job: "Herringbone", short: 0, onHandAfter: -10 })).toBe(
      "Took 90 ft of 12/2 NM-B for Herringbone. The shelf now reads -10 ft, below zero — the office will settle it.",
    );
    const bell = officeBellWords({ who: "Brian", qty: 90, unit: "ft", item: "12/2 NM-B", job: "Herringbone", short: 0, onHandAfter: -10 });
    expect(bell.title).toBe("Brian took 90 ft of 12/2 NM-B; the shelf now reads -10 ft");
    expect(bell.body).toBe("For Herringbone. An older short on it is still open: File the roll on Shop Stock, then Settle From The Shelf — or Undo the take.");
    // The bell opens where its words send the office: Shop Stock, whenever there is a short to settle.
    expect(officeBellOpensShelf({ short: 0, onHandAfter: -10 })).toBe(true);
    expect(officeBellOpensShelf({ short: 15, onHandAfter: -15 })).toBe(true);
    expect(officeBellOpensShelf({ short: 0, onHandAfter: 190 })).toBe(false);
    expect(officeBellOpensShelf({ short: 0, onHandAfter: 0 })).toBe(false);
  });

  it("Take It that didn't hear back points at the takes list only when that list read", () => {
    expect(takeUnheardWords(true, true)).toBe("No signal, so Take It didn't hear back. It may have saved: check Taken From Stock below before tapping again.");
    expect(takeUnheardWords(false, true)).toBe("Take It didn't hear back. It may have saved: check Taken From Stock below before tapping again.");
    expect(takeUnheardWords(true, false)).toBe("No signal, so Take It didn't hear back. It may have saved: reload before tapping again.");
    expect(takeUnheardWords(false, false)).not.toContain("Taken From Stock");
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
