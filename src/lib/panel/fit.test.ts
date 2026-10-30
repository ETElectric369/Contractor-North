import { describe, it, expect } from "vitest";
import { BORDER_PT, CHAR_EM, LABEL_PAD_IN, MAX_PT, MIN_PT, fitCheck, fontPtFor, innerPt, labelPt, tightWords, wordEm } from "./fit";
import type { StripLine } from "./strip";

/** The type gives, never the box: as large as it fits down to 6 pt, and a name that can't is said. */
describe("the character table: capitals measure as the wide letters they are", () => {
  it("capitals 0.72 em, digits 0.6, lowercase and punctuation 0.52, a space 0.28", () => {
    expect(CHAR_EM).toEqual({ capital: 0.72, digit: 0.6, lower: 0.52, space: 0.28 });
    expect(wordEm("REFRIGERATOR")).toBeCloseTo(12 * 0.72, 6);
    expect(wordEm("refrigerator")).toBeCloseTo(12 * 0.52, 6);
    expect(wordEm("GDO#1")).toBeCloseTo(3 * 0.72 + 0.52 + 0.6, 6);
  });

  it("the words get the box less its border and inner margin, across AND down", () => {
    const edge = 2 * BORDER_PT + 2 * LABEL_PAD_IN * 72;
    expect(innerPt(1, 1)).toEqual({ width: 72 - edge, height: 72 - edge });
    expect(innerPt(1, 1).width).toBeCloseTo(66.68, 2);
  });

  it("REFRIGERATOR on a 1.0 in strip sets only at the size the table gives (7.5 pt), never the 10 pt the old average passed", () => {
    // 8.64 em in a 66.68 pt line: 7.72 pt at most, so 7.5 pt (a half-point step).
    expect(fontPtFor("REFRIGERATOR", 1, 1)).toBe(7.5);
    expect(fontPtFor("REFRIGERATOR", 1, 0.5)).toBe(7.5);
    // Asked to stay at 8 pt or more, it is tight: nothing at 8 pt or above fits.
    expect(fontPtFor("REFRIGERATOR", 1, 1, { minPt: 8 })).toBeNull();
    // The same letters in lowercase are narrower, and set larger.
    expect(fontPtFor("refrigerator", 1, 1)).toBe(10.5);
  });
});

describe("fontPtFor: the largest type that sets the words in the box", () => {
  it("a 1.125 × 1 in box takes Entry Kitchen Living (wrapped) and EV Charger", () => {
    const ekl = fontPtFor("Entry Kitchen Living", 1.125, 1);
    expect(ekl).not.toBeNull();
    expect(ekl!).toBeGreaterThanOrEqual(MIN_PT);
    // On one row it would have to drop under 7.5 pt; wrapped, it sets at the ceiling.
    expect(ekl).toBe(MAX_PT);
    expect(fontPtFor("EV Charger", 1.125, 1)).toBe(MAX_PT);
  });

  it("a 1.125 × 0.5 in tandem line takes Kitchen GFCI Rt at 6 pt or more", () => {
    const pt = fontPtFor("Kitchen GFCI Rt", 1.125, 0.5);
    expect(pt).not.toBeNull();
    expect(pt!).toBeGreaterThanOrEqual(6);
  });

  it("a 30-character word can't fit an inch and an eighth even at 6 pt", () => {
    expect(fontPtFor("Abcdefghijklmnopqrstuvwxyzabcd", 1.125, 1)).toBeNull();
  });

  it("too many rows for the height steps the type down, then gives up at the floor", () => {
    const many = "One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve";
    const tall = fontPtFor(many, 1.125, 0.5);
    expect(tall).not.toBeNull();
    expect(tall!).toBeLessThan(MAX_PT);
    expect(fontPtFor(`${many} ${many} ${many}`, 1.125, 0.25)).toBeNull();
  });

  it("steps by half a point, honours its own floor and ceiling, and blank text needs nothing", () => {
    const pt = fontPtFor("Kitchen Outlets Right Side Wall", 1, 0.5)!;
    expect(pt * 2).toBe(Math.round(pt * 2));
    expect(fontPtFor("EV Charger", 3, 3, { maxPt: 9 })).toBe(9);
    expect(fontPtFor("Abcdefghijklmnopqrstuvwxyzabcd", 1.125, 1, { minPt: 4 })).not.toBeNull();
    expect(fontPtFor("", 1, 1)).toBe(MAX_PT);
    expect(fontPtFor("Bar", 0, 1)).toBeNull();
  });
});

describe("fitCheck: the tight labels of a strip", () => {
  const line = (space: number, text: string, over: Partial<StripLine> = {}): StripLine => ({
    space,
    half: null,
    heightIn: 1,
    text,
    amps: 20,
    circuitId: `c${space}`,
    kind: "single",
    ...over,
  });

  it("names only the lines whose words can't fit at 6 pt; empty and dead boxes never count", () => {
    const lines = [
      line(1, "Entry Kitchen Living"),
      line(3, "Abcdefghijklmnopqrstuvwxyzabcd"),
      line(5, "Kitchen GFCI Rt", { half: "A", heightIn: 0.5, kind: "tandem" }),
      line(5, "Qwertyuiopasdfghjklzxcvbnmqwer", { half: "B", heightIn: 0.5, kind: "tandem" }),
      line(7, "", { kind: "empty", circuitId: null, amps: null }),
      line(9, "", { kind: "dead", circuitId: null, amps: null }),
    ];
    const r = fitCheck(lines, 1.125);
    expect(r.count).toBe(2);
    expect(r.tight).toEqual([
      { space: 3, half: null, text: "Abcdefghijklmnopqrstuvwxyzabcd" },
      { space: 5, half: "B", text: "Qwertyuiopasdfghjklzxcvbnmqwer" },
    ]);
    expect(fitCheck([line(7, "", { kind: "empty" })], 0.1)).toEqual({ tight: [], count: 0 });
  });

  it("measures the box the print page draws (its own height, the strip's width; border and margin inside), the same sum", () => {
    expect(labelPt(line(1, "Entry Kitchen Living"), 1.125)).toBe(fontPtFor("Entry Kitchen Living", 1.125, 1));
    expect(labelPt(line(5, "Kitchen GFCI Rt", { half: "A", heightIn: 0.5 }), 1.125)).toBe(fontPtFor("Kitchen GFCI Rt", 1.125, 0.5));
    // A 1.0 in strip's REFRIGERATOR is not tight at the floor: it sets at 7.5 pt.
    expect(fitCheck([line(1, "REFRIGERATOR")], 1)).toEqual({ tight: [], count: 0 });
    // The cell beside an odd panel's last space is never counted.
    expect(fitCheck([line(8, "", { kind: "none", circuitId: null, amps: null })], 0.1)).toEqual({ tight: [], count: 0 });
  });

  it("says it in one sentence, singular or plural, and nothing when none are tight", () => {
    expect(tightWords(3)).toBe("3 labels are tight — shorten them or widen the strip.");
    expect(tightWords(1)).toBe("1 label is tight — shorten it or widen the strip.");
    expect(tightWords(0)).toBeNull();
  });
});
