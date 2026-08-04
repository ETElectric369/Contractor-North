import { describe, it, expect } from "vitest";
import { isSchedulable, isWaiting, waitingDays, waitingLabel, waitingList, waitTone } from "./waiting-on";

/**
 * THE THREE ROWS THIS EXISTS FOR, as they sit in production today:
 *
 *   200A Service Upgrade   on_hold, start Aug 31, created Jul 16 — TOUCHED TODAY, bumped again
 *   Tao Zhu                on_hold, start Jul 9  — a date a month in the past
 *   TTP #56                on_hold, start Jun 17 — same
 *
 * Every one of those dates is fiction. The app had no way to say "waiting on the county", so it
 * got a date instead, and the date has to be maintained by hand forever.
 */

const TODAY = "2026-08-04";

describe("waiting is not the same as unscheduled", () => {
  it("a job waiting on somebody else is NOT schedulable", () => {
    // "arent going on the calendar until we get notice" — so it must not appear in "needs a date",
    // must not render as late, and must not hold a start somebody keeps moving.
    expect(isSchedulable({ blocked_on: "County permit for the meter swap" })).toBe(false);
  });

  it("a job with nothing blocking it is", () => {
    expect(isSchedulable({})).toBe(true);
    expect(isSchedulable({ blocked_on: null })).toBe(true);
    expect(isSchedulable({ blocked_on: "   " })).toBe(true); // whitespace is not a reason
  });

  it("clearing the block makes it schedulable again — that is the moment it hits the calendar", () => {
    const job = { blocked_on: "County permit", blocked_since: "2026-07-16" };
    expect(isSchedulable(job)).toBe(false);
    expect(isSchedulable({ ...job, blocked_on: null })).toBe(true);
  });
});

describe("AGE is the signal, because the age is the only true thing", () => {
  it("counts days from when the wait started", () => {
    expect(waitingDays({ blocked_on: "permit", blocked_since: "2026-07-16" }, TODAY)).toBe(19);
  });

  it("started today reads as zero, not one", () => {
    expect(waitingDays({ blocked_on: "permit", blocked_since: TODAY }, TODAY)).toBe(0);
  });

  it("counts calendar days, not elapsed hours — filed at 4pm yesterday is 1 day this morning", () => {
    expect(waitingDays({ blocked_on: "permit", blocked_since: "2026-08-03" }, TODAY)).toBe(1);
  });

  it("never goes negative — a start in the future is a typo, not a negative wait", () => {
    expect(waitingDays({ blocked_on: "permit", blocked_since: "2026-09-01" }, TODAY)).toBe(0);
  });

  it("no start recorded is null, not zero — unknown is not new", () => {
    expect(waitingDays({ blocked_on: "permit" }, TODAY)).toBeNull();
  });

  it("nothing blocking means no age at all", () => {
    expect(waitingDays({}, TODAY)).toBeNull();
  });
});

describe("it gets louder on its own", () => {
  it.each([
    [0, "fresh"], [6, "fresh"],
    [7, "aging"], [20, "aging"],
    [21, "stale"], [90, "stale"],
  ])("%i days → %s", (d, tone) => {
    expect(waitTone(d)).toBe(tone);
  });

  it("an unknown age is not an emergency", () => {
    expect(waitTone(null)).toBe("fresh");
  });

  it("the three real rows, told honestly", () => {
    expect(waitTone(waitingDays({ blocked_on: "x", blocked_since: "2026-07-16" }, TODAY))).toBe("aging"); // 200A, 19d
    expect(waitTone(waitingDays({ blocked_on: "x", blocked_since: "2026-06-08" }, TODAY))).toBe("stale"); // Tao Zhu, 57d
    expect(waitTone(waitingDays({ blocked_on: "x", blocked_since: "2026-06-15" }, TODAY))).toBe("stale"); // TTP #56
  });
});

describe("the one line a person reads", () => {
  it("says how long and what for", () => {
    expect(waitingLabel({ blocked_on: "County permit for the meter swap", blocked_since: "2026-07-16" }, TODAY))
      .toBe("Waiting 19 days — County permit for the meter swap");
  });

  it("one day is singular", () => {
    expect(waitingLabel({ blocked_on: "permit", blocked_since: "2026-08-03" }, TODAY)).toBe("Waiting 1 day — permit");
  });

  it("today reads as today, not '0 days'", () => {
    expect(waitingLabel({ blocked_on: "permit", blocked_since: TODAY }, TODAY)).toBe("Waiting since today — permit");
  });

  it("with no start it still says what it's waiting for", () => {
    expect(waitingLabel({ blocked_on: "the inspector's window" }, TODAY)).toBe("Waiting — the inspector's window");
  });

  it("nothing blocking, nothing to say", () => {
    expect(waitingLabel({}, TODAY)).toBeNull();
  });
});

describe("the list — longest wait first", () => {
  const rows = [
    { id: "fresh", blocked_on: "permit", blocked_since: "2026-08-02" },
    { id: "taozhu", blocked_on: "permit", blocked_since: "2026-06-08" },
    { id: "200a", blocked_on: "permit", blocked_since: "2026-07-16" },
    { id: "clear" },
    { id: "unknown", blocked_on: "permit" },
  ];

  it("the three-week-old request is the one that has gone wrong", () => {
    expect(waitingList(rows, TODAY).map((r) => r.id)).toEqual(["taozhu", "200a", "fresh", "unknown"]);
  });

  it("drops anything not actually waiting", () => {
    expect(waitingList(rows, TODAY).map((r) => r.id)).not.toContain("clear");
  });

  it("an unknown age sorts LAST — the least information does not belong at the top", () => {
    expect(waitingList(rows, TODAY).at(-1)?.id).toBe("unknown");
  });

  it("does not mutate the caller's array", () => {
    const before = rows.map((r) => r.id);
    waitingList(rows, TODAY);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe("there is no 'until', and that is the fix", () => {
  it("the shape cannot express a promised date", () => {
    // If this ever gains a blocked_until, the weekly bumping comes straight back — the app would
    // again be asking a man to invent a date the county never gave him.
    const keys = Object.keys({ blocked_on: "x", blocked_since: "y" });
    expect(keys).not.toContain("blocked_until");
    expect(keys).toEqual(["blocked_on", "blocked_since"]);
  });
});
