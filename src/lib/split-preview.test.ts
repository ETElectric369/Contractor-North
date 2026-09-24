import { describe, it, expect } from "vitest";
import { defaultSplitAt, isPaidEntry, nudgeSplitAt, splitPreview, workedSeconds } from "./split-preview";

// Jul 14's shape, on a date nobody worked: 11:30-17:30 Pacific (PDT, UTC-7) with a 30-minute lunch.
const shift = {
  clock_in: "2001-07-14T18:30:00.000Z",
  clock_out: "2001-07-15T00:30:00.000Z",
  status: "closed",
  lunch_minutes: 30,
  miles: 12,
};

describe("splitPreview", () => {
  it("cuts the Jul 14 shift so the last hour is its own piece, and the total is the shift", () => {
    const p = splitPreview(shift, "2001-07-14T23:30:00.000Z");
    expect(p.ok).toBe(true);
    expect(p.problem).toBeNull();
    expect(p.left).toEqual({ start: shift.clock_in, end: "2001-07-14T23:30:00.000Z", lunchMinutes: 30, miles: 12, hours: 4.5 });
    expect(p.right).toEqual({ start: "2001-07-14T23:30:00.000Z", end: shift.clock_out, lunchMinutes: 0, miles: 0, hours: 1 });
    expect(p.lunchOn).toBe("left"); // the longer piece
    expect(p.shiftHours).toBe(5.5);
    expect(p.totalHours).toBe(5.5);
    expect(p.sameAsShift).toBe(true);
  });

  it("puts the lunch on the longer piece by default, and where it is told otherwise", () => {
    expect(splitPreview(shift, "2001-07-14T19:30:00.000Z").lunchOn).toBe("right");
    const onLeft = splitPreview(shift, "2001-07-14T21:30:00.000Z", "left");
    expect(onLeft.left.lunchMinutes).toBe(30);
    expect(onLeft.left.hours).toBe(2.5);
    expect(onLeft.right.hours).toBe(3);
    expect(onLeft.totalHours).toBe(5.5);
  });

  it("moves the miles whole, never divided", () => {
    const p = splitPreview(shift, "2001-07-14T21:30:00.000Z", null, { milesOn: "right" });
    expect(p.left.miles).toBe(0);
    expect(p.right.miles).toBe(12);
  });

  it("says the lunch does not fit when it would leave its piece under a minute", () => {
    const p = splitPreview(shift, "2001-07-14T18:45:00.000Z", "left");
    expect(p.ok).toBe(false);
    expect(p.problem).toBe("The 30-minute lunch does not fit in the first part. Put it on the other part.");
  });

  it("refuses a cut outside the shift, naming the shift's own times", () => {
    const p = splitPreview(shift, "2001-07-15T01:00:00.000Z");
    expect(p.ok).toBe(false);
    expect(p.problem).toBe("Pick a split time inside the shift, between 11:30am and 5:30pm.");
  });

  it("refuses a piece under a minute", () => {
    expect(splitPreview(shift, "2001-07-14T18:30:30.000Z", "right").problem).toBe("Each part has to be at least a minute long.");
  });

  it("refuses a running shift and a zero-length ghost", () => {
    expect(splitPreview({ ...shift, clock_out: null, status: "open" }, "2001-07-14T20:00:00.000Z").problem).toMatch(/Switch Job/);
    const ghost = { clock_in: "2001-07-02T19:40:19.860Z", clock_out: "2001-07-02T19:40:19.860Z", status: "closed" };
    expect(splitPreview(ghost, "2001-07-02T19:40:19.860Z").problem).toBe("That shift has no length, so there is nothing to split.");
  });

  it("keeps a paid shift on its own day", () => {
    // 20:00-02:00 Pacific, paid: a cut after midnight would move paid hours to the next day.
    const late = { clock_in: "2001-07-15T03:00:00.000Z", clock_out: "2001-07-15T09:00:00.000Z", status: "closed", paid_at: "2001-07-20T00:00:00Z" };
    expect(splitPreview(late, "2001-07-15T08:00:00.000Z").problem).toBe("That shift is already paid, so both parts have to stay on Jul 14.");
    expect(splitPreview(late, "2001-07-15T06:00:00.000Z").ok).toBe(true);
    // Unpaid, the same cut is fine.
    expect(splitPreview({ ...late, paid_at: null }, "2001-07-15T08:00:00.000Z").ok).toBe(true);
  });

  it("refuses a cut on a paid shift that would round the paid hours by a cent", () => {
    // 3.5083 h paid as 3.51; cut 1 h in plus 15 s: 1.0042 -> 1.00 and 2.5042 -> 2.50 = 3.50.
    const paid = { clock_in: "2001-07-16T16:00:00.000Z", clock_out: "2001-07-16T19:30:30.000Z", status: "closed", paid_at: "2001-07-20T00:00:00Z" };
    expect(splitPreview(paid, "2001-07-16T17:00:15.000Z").problem).toMatch(/rounding cent/);
    // On the minute it adds back: 1.00 + 2.51.
    const onMinute = splitPreview(paid, "2001-07-16T17:00:00.000Z");
    expect(onMinute.ok).toBe(true);
    expect(onMinute.left.hours + onMinute.right.hours).toBeCloseTo(3.51, 10);
    // The same odd cut on an UNPAID shift is allowed: nothing was paid yet, the pieces are the truth.
    expect(splitPreview({ ...paid, paid_at: null }, "2001-07-16T17:00:15.000Z").ok).toBe(true);
  });
});

describe("defaultSplitAt / nudgeSplitAt", () => {
  it("opens on the middle of the shift, rounded to 15 minutes of the org's clock", () => {
    // 11:30-17:30: the middle is 14:30 exactly.
    expect(defaultSplitAt(shift)).toBe("2001-07-14T21:30:00.000Z");
    // 10:14-17:32: the middle is 13:53 -> 14:00.
    expect(defaultSplitAt({ clock_in: "2001-07-31T17:14:00.000Z", clock_out: "2001-08-01T00:32:00.000Z" })).toBe(
      "2001-07-31T21:00:00.000Z",
    );
  });

  it("falls back to the minute on a shift too short for a 15-minute mark, and gives up on a ghost", () => {
    const short = { clock_in: "2001-07-14T18:31:00.000Z", clock_out: "2001-07-14T18:35:00.000Z" };
    expect(defaultSplitAt(short)).toBe("2001-07-14T18:33:00.000Z");
    expect(defaultSplitAt({ clock_in: "2001-07-14T18:31:00.000Z", clock_out: "2001-07-14T18:31:30.000Z" })).toBeNull();
    expect(defaultSplitAt({ clock_in: "2001-07-14T18:31:00.000Z", clock_out: null })).toBeNull();
  });

  it("nudges by 15 minutes, never closer than a minute to either end", () => {
    expect(nudgeSplitAt(shift, "2001-07-14T21:30:00.000Z", 15)).toBe("2001-07-14T21:45:00.000Z");
    expect(nudgeSplitAt(shift, "2001-07-14T21:30:00.000Z", -15)).toBe("2001-07-14T21:15:00.000Z");
    expect(nudgeSplitAt(shift, "2001-07-15T00:20:00.000Z", 15)).toBe("2001-07-15T00:29:00.000Z");
    expect(nudgeSplitAt(shift, "2001-07-14T18:40:00.000Z", -15)).toBe("2001-07-14T18:31:00.000Z");
  });
});

describe("workedSeconds / isPaidEntry", () => {
  it("is the span minus the lunch, the figure the database asserts is unchanged", () => {
    expect(workedSeconds(shift.clock_in, shift.clock_out, 30)).toBe(5.5 * 3600);
    expect(workedSeconds(shift.clock_in, shift.clock_out, -30)).toBe(6 * 3600); // a negative lunch adds nothing
  });

  it("counts either lock as paid", () => {
    expect(isPaidEntry({ paid_at: null, mileage_paid_at: null })).toBe(false);
    expect(isPaidEntry({ paid_at: "2001-01-01", mileage_paid_at: null })).toBe(true);
    expect(isPaidEntry({ paid_at: null, mileage_paid_at: "2001-01-01" })).toBe(true);
  });
});
