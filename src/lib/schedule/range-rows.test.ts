import { describe, it, expect } from "vitest";
import { editRow, joinedRange, oneDay, rangesToSave, rangeWords, reseedRows, rowState } from "./range-rows";

/**
 * A RANGE ROW WAITS FOR BOTH ITS DAYS (cn-v1189; the owner: "Add date range should wait and require a
 * range before auto saving right now it won't even let me add the second day"). J-902, Snowbell.
 */
const MON = "2026-10-05";
const TUE = "2026-10-06";
const THU = "2026-10-08";

describe("what a row is", () => {
  it("ready with both days; waiting for its last day, or its first; blank with neither", () => {
    expect(rowState({ start: MON, end: TUE })).toBe("ready");
    expect(rowState({ start: MON, end: "" })).toBe("needsLast");
    expect(rowState({ start: "", end: TUE })).toBe("needsFirst");
    expect(rowState({ start: "", end: "" })).toBe("blank");
  });
});

describe("what is sent", () => {
  it("one ready row is sent", () => {
    expect(rangesToSave([{ start: MON, end: MON }])).toEqual({ save: [{ start: MON, end: MON }], waiting: [] });
  });

  it("a row with its first day only is never sent: it waits (it is not a one-day range)", () => {
    const r = rangesToSave([{ start: MON, end: MON }, { start: THU, end: "" }]);
    expect(r.save).toEqual([{ start: MON, end: MON }]);
    expect(r.waiting).toEqual([{ start: THU, end: "" }]);
  });

  it("a row with its last day only waits, never silently dropped; a blank row is never sent", () => {
    expect(rangesToSave([{ start: "", end: THU }, { start: "", end: "" }])).toEqual({ save: [], waiting: [{ start: "", end: THU }, { start: "", end: "" }] });
  });

  it("an inverted legacy row goes as its first day", () => {
    expect(rangesToSave([{ start: THU, end: MON }]).save).toEqual([{ start: THU, end: THU }]);
  });

  it("One Day: a first day only becomes that one day; any other row is as it was", () => {
    expect(oneDay({ start: THU, end: "" })).toEqual({ start: THU, end: THU });
    expect(oneDay({ start: "", end: THU })).toEqual({ start: "", end: THU });
  });
});

describe("what the control shows after a save", () => {
  it("the stored ranges, then the row still waiting", () => {
    expect(reseedRows([{ start: MON, end: TUE }], [{ start: MON, end: MON }, { start: TUE, end: TUE }, { start: THU, end: "" }])).toEqual([
      { start: MON, end: TUE },
      { start: THU, end: "" },
    ]);
    expect(reseedRows([], [])).toEqual([{ start: "", end: "" }]);
  });

  it("two sent, one stored: the joined range is named; nothing joined names nothing", () => {
    expect(joinedRange([{ start: MON, end: MON }, { start: TUE, end: TUE }], [{ start: MON, end: TUE }])).toEqual({ start: MON, end: TUE });
    expect(joinedRange([{ start: MON, end: MON }, { start: THU, end: THU }], [{ start: MON, end: MON }, { start: THU, end: THU }])).toBeNull();
  });

  it("a range in the control's words", () => {
    const day = (d: string) => (d === MON ? "Mon, Oct 5" : "Tue, Oct 6");
    expect(rangeWords({ start: MON, end: TUE }, day, "to")).toBe("Mon, Oct 5 to Tue, Oct 6");
    expect(rangeWords({ start: MON, end: MON }, day, "to")).toBe("Mon, Oct 5");
  });
});

describe("a saved row is not lost by an emptied box (skeptic #90 S2)", () => {
  it("a ready row patched with an empty day stays ready with its days; removal is the remove control's", () => {
    const r = { start: MON, end: THU };
    expect(editRow(r, { end: "" })).toEqual(r);
    expect(editRow(r, { start: "" })).toEqual(r);
    expect(rowState(editRow(r, { end: "" }))).toBe("ready");
    expect(rangesToSave([editRow(r, { end: "" }), { start: "2026-10-12", end: "2026-10-13" }]).save).toHaveLength(2);
  });

  it("a waiting row may still be emptied", () => {
    expect(editRow({ start: THU, end: "" }, { start: "" })).toEqual({ start: "", end: "" });
  });

  it("an ordinary edit still drags the other day when crossed", () => {
    expect(editRow({ start: MON, end: TUE }, { start: THU })).toEqual({ start: THU, end: THU });
  });
});

describe("a year typed digit by digit is never saved (skeptic #90 S3)", () => {
  it("a day whose year is before 2000 is not set", () => {
    expect(rowState({ start: "0002-10-05", end: THU })).toBe("needsFirst");
    expect(rowState({ start: MON, end: "0202-10-08" })).toBe("needsLast");
    expect(rangesToSave([{ start: "0020-10-05", end: THU }]).save).toEqual([]);
  });

  it("typing the year into the last day never drags the first day back to year 2", () => {
    let r = { start: MON, end: TUE };
    for (const y of ["0002", "0020", "0202"]) {
      r = editRow(r, { end: `${y}-10-08` });
      expect(r.start).toBe(MON);
      expect(rowState(r)).toBe("needsLast");
    }
    r = editRow(r, { end: THU });
    expect(r).toEqual({ start: MON, end: THU });
  });
});

describe("the joined line is said only for days that touch (skeptic #90 S6)", () => {
  it("the same day sent twice and stored once names nothing", () => {
    expect(joinedRange([{ start: MON, end: MON }, { start: MON, end: MON }], [{ start: MON, end: MON }])).toBeNull();
    expect(joinedRange([{ start: MON, end: TUE }, { start: MON, end: TUE }], [{ start: MON, end: TUE }])).toBeNull();
  });

  it("a duplicate beside a real join still names the join", () => {
    expect(joinedRange([{ start: MON, end: MON }, { start: MON, end: MON }, { start: TUE, end: TUE }], [{ start: MON, end: TUE }])).toEqual({ start: MON, end: TUE });
  });
});
