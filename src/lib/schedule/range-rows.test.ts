import { describe, it, expect } from "vitest";
import { editRow, joinedRange, oneDay, rangesToSave, rangeWords, reseedRows, rowState } from "./range-rows";
import * as RR from "./range-rows";

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
    expect(oneDay({ start: THU, end: "" })).toEqual({ start: THU, end: THU, touched: true });
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
    expect(editRow({ start: THU, end: "" }, { start: "" })).toEqual({ start: "", end: "", touched: true });
  });

  it("an ordinary edit still drags the other day when crossed", () => {
    expect(editRow({ start: MON, end: TUE }, { start: THU })).toEqual({ start: THU, end: THU, touched: true });
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
    expect(r).toEqual({ start: MON, end: THU, touched: true });
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

/**
 * EACH DATE RANGE HAS HOURS OF ITS OWN, AND EXTEND JOB (cn-v1190; the owner: "add a date range to have
 * its own time entry too that defaults to the hours inputed for the first date range", "lets call it
 * Extend Job with date and time selector defaulted to today with the same hours", "yes today forward").
 * J-906, Tupelo Panel: usual hours 9 to 5 on a 9-to-5 company day.
 */
describe("a row carries its hours", () => {
  const { rowsOfSegments, rowHoursAfter, extendDefaults, extendRefusal, hoursShown } = RR;
  const OWN = { start: "09:00", end: "13:00" };
  const WD = { startMin: 9 * 60, endMin: 17 * 60 };
  const USUAL = { startHm: "09:00", endHm: "17:00", allDay: true };

  it("rows built from the stored days: neighbours with different hours are two rows, the same hours one", () => {
    expect(
      rowsOfSegments([
        { start_date: MON, end_date: MON, start_time: null, end_time: null },
        { start_date: TUE, end_date: TUE, start_time: "09:00:00", end_time: "13:00:00" },
        { start_date: "2026-10-07", end_date: "2026-10-07", start_time: "09:00:00", end_time: "13:00:00" },
        { start_date: THU, end_date: THU, start_time: null, end_time: null },
      ]),
    ).toEqual([
      { start: MON, end: MON, hours: null },
      { start: TUE, end: "2026-10-07", hours: OWN },
      { start: THU, end: THU, hours: null },
    ]);
    expect(rowsOfSegments([{ start_date: MON, end_date: MON }, { start_date: TUE, end_date: TUE }])).toEqual([{ start: MON, end: TUE, hours: null }]);
  });

  it("the hours ride with a row: a waiting row keeps them, One Day, a crossed edit and the save keep them", () => {
    const waiting = { start: THU, end: "", hours: OWN };
    expect(rangesToSave([{ start: MON, end: MON, hours: null }, waiting])).toEqual({ save: [{ start: MON, end: MON, hours: null }], waiting: [waiting] });
    expect(oneDay(waiting)).toEqual({ start: THU, end: THU, hours: OWN, touched: true });
    expect(editRow({ start: MON, end: TUE, hours: OWN }, { start: THU })).toEqual({ start: THU, end: THU, hours: OWN, touched: true });
    expect(editRow({ start: MON, end: "", hours: OWN }, { end: TUE })).toEqual({ start: MON, end: TUE, hours: OWN, touched: true });
    expect(reseedRows([{ start: MON, end: TUE, hours: null }], [waiting])).toEqual([{ start: MON, end: TUE, hours: null }, waiting]);
  });

  it("a row's time entry: a new start keeps the length, a length sets the end, the usual hours again are no hours of its own", () => {
    const usualRow = { start: MON, end: TUE, hours: null };
    expect(rowHoursAfter({ row: usualRow, usual: USUAL, plannedMinutes: 480, patch: { length: 240 }, wd: WD })).toEqual(OWN);
    expect(rowHoursAfter({ row: { ...usualRow, hours: OWN }, usual: USUAL, plannedMinutes: 480, patch: { start: "10:00" }, wd: WD })).toEqual({ start: "10:00", end: "14:00" });
    expect(rowHoursAfter({ row: { ...usualRow, hours: OWN }, usual: USUAL, plannedMinutes: 480, patch: { length: "full" }, wd: WD })).toBeNull();
    expect(rowHoursAfter({ row: usualRow, usual: USUAL, plannedMinutes: 480, patch: { start: "nope" }, wd: WD })).toBeUndefined();
    expect(hoursShown(usualRow, { start: "09:00", end: "17:00" })).toEqual({ start: "09:00", end: "17:00" });
    expect(hoursShown({ ...usualRow, hours: OWN }, { start: "09:00", end: "17:00" })).toEqual(OWN);
  });

  it("Extend Job opens on the LATER of today and the day after the job's last day (skeptic #91 S2)", () => {
    // Its last day yesterday or earlier: today.
    expect(extendDefaults([{ start: MON, end: MON, hours: null }], TUE)).toEqual({ day: TUE, hours: null });
    expect(extendDefaults([{ start: MON, end: MON, hours: null }], THU).day).toBe(THU);
    // Its last day is today: tomorrow.
    expect(extendDefaults([{ start: MON, end: TUE, hours: null }], TUE).day).toBe("2026-10-07");
    // A gap (Mon to Tue, then Thu): the day after its last day, never the gap, today Mon or Thu.
    const rows = [{ start: MON, end: TUE, hours: null }, { start: THU, end: THU, hours: OWN }];
    expect(extendDefaults(rows, MON).day).toBe("2026-10-09");
    expect(extendDefaults(rows, THU).day).toBe("2026-10-09");
    // Booked ahead (J-902, Snowbell, Dec 7 to 9, today Nov 25): Dec 10, never a day before its first.
    expect(extendDefaults([{ start: "2026-12-07", end: "2026-12-09", hours: null }], "2026-11-25").day).toBe("2026-12-10");
    // A waiting row's day is not one the job has.
    expect(extendDefaults([{ start: MON, end: MON, hours: null }, { start: TUE, end: "" }], MON).day).toBe(TUE);
  });

  it("Extend Job's hours are the LAST range's: its own, else the usual (null)", () => {
    expect(extendDefaults([{ start: THU, end: THU, hours: OWN }, { start: MON, end: TUE, hours: null }], MON).hours).toEqual(OWN);
    expect(extendDefaults([{ start: MON, end: MON, hours: OWN }, { start: THU, end: THU, hours: null }], MON).hours).toBeNull();
  });

  it("Extend Job refuses a day the job has, a day before today, and no day", () => {
    const rows = [{ start: MON, end: TUE, hours: null }];
    expect(extendRefusal(rows, TUE, MON)).toBe("has");
    expect(extendRefusal(rows, MON, TUE)).toBe("pick");
    expect(extendRefusal(rows, "", MON)).toBe("pick");
    expect(extendRefusal(rows, THU, MON)).toBeNull();
  });
});

/**
 * HOURS RIDE ONLY ON A ROW THE PERSON TOUCHED (skeptic #91 S1). J-901, Larkspur: Dana Rook's page shows
 * Dec 7 to 8 and Dec 10 (both the usual hours, as read when the page loaded); Sam Tillery has since given
 * Dec 10 hours of its own on the Schedule. Dana moves the first range's last day to Dec 9.
 */
describe("a row's hours are sent only when the person touched it", () => {
  const { rowsToSend } = RR;
  const D7 = "2026-12-07";
  const D8 = "2026-12-08";
  const D9 = "2026-12-09";
  const D10 = "2026-12-10";
  const OWN = { start: "06:00", end: "10:00" };

  it("an edited row sends its hours; the untouched row beside it goes with NO hours field", () => {
    const rows = [{ start: D7, end: D8, hours: null }, { start: D10, end: D10, hours: null }];
    const next = [editRow(rows[0], { end: D9 }), rows[1]];
    const sent = rowsToSend(next);
    expect(sent).toEqual([{ start: D7, end: D9, hours: null }, { start: D10, end: D10 }]);
    expect("hours" in sent[1]).toBe(false);
    // Nothing touched: dates only, as at cn-v1189.
    expect(rowsToSend(rows)).toEqual([{ start: D7, end: D8 }, { start: D10, end: D10 }]);
  });

  it("a row whose hours changed, a new row, One Day and a day picked into a waiting row are touched", () => {
    expect(rowsToSend([{ start: D10, end: D10, hours: OWN, touched: true }])).toEqual([{ start: D10, end: D10, hours: OWN }]);
    expect(rowsToSend([oneDay({ start: D10, end: "", hours: null })])).toEqual([{ start: D10, end: D10, hours: null }]);
    expect(rowsToSend([editRow({ start: "", end: "", hours: null }, { start: D7 })].map((r) => editRow(r, { end: D8 })))).toEqual([
      { start: D7, end: D8, hours: null },
    ]);
    // An emptied box on a saved row changes nothing, and touches nothing.
    expect(rowsToSend([editRow({ start: D7, end: D8, hours: null }, { end: "" })])).toEqual([{ start: D7, end: D8 }]);
    // The flag never goes to the server.
    expect(rowsToSend([{ start: D7, end: D8, hours: null, touched: true }])[0]).not.toHaveProperty("touched");
  });

  it("the flag survives a save that did not win (no re-seed) and is cleared by the re-seed from the winning answer", () => {
    const touched = [editRow({ start: D7, end: D8, hours: null }, { end: D9 }), { start: D10, end: D10, hours: null }];
    // A superseded save re-seeds nothing: the later save still carries the edited row's hours.
    expect(rowsToSend(touched)[0]).toEqual({ start: D7, end: D9, hours: null });
    // The winning answer's rows are what is stored: nothing touched, a waiting new row kept as it was.
    const waiting = { start: D10, end: "", hours: null, touched: true };
    const after = reseedRows([{ start: D7, end: D9, hours: null }, { start: D10, end: D10, hours: OWN }], [...touched, waiting]);
    expect(after).toEqual([{ start: D7, end: D9, hours: null }, { start: D10, end: D10, hours: OWN }, waiting]);
    expect(rowsToSend(after)).toEqual([{ start: D7, end: D9 }, { start: D10, end: D10 }]);
  });
});
