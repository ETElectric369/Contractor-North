import { describe, it, expect } from "vitest";
import { BELL_LIST_SIZE, BELL_MORE_LINE, bellBadge, bellWhen } from "./bell-words";

/**
 * THE BELL (Wave 1): its badge counts only what is unread ("badges show open"), 9+ above nine and
 * nothing at zero; the list is the newest 20 and says so when there are more; each line says when it
 * came in.
 */
describe("the bell's badge", () => {
  it("nothing at zero, or when the count couldn't be read", () => {
    for (const n of [0, -1, null, undefined, Number.NaN]) expect(bellBadge(n as never)).toBeNull();
  });
  it("the count to nine, then 9+", () => {
    expect(bellBadge(1)).toBe("1");
    expect(bellBadge(9)).toBe("9");
    expect(bellBadge(10)).toBe("9+");
    expect(bellBadge(257)).toBe("9+");
  });
});

describe("the list", () => {
  it("is the newest 20, and the line under it says so", () => {
    expect(BELL_LIST_SIZE).toBe(20);
    expect(BELL_MORE_LINE).toBe("Showing the newest 20");
  });
});

describe("when a line came in", () => {
  const TZ = "America/Los_Angeles";
  const NOW = new Date("2026-09-27T20:00:00Z"); // 1:00 PM Sunday Sep 27 in Los Angeles

  it("today: its time", () => {
    expect(bellWhen("2026-09-27T17:42:00Z", NOW, TZ)).toBe("10:42 AM");
  });
  it("the day before, on the viewer's clock: Yesterday (even when it is the same UTC day)", () => {
    expect(bellWhen("2026-09-26T16:00:00Z", NOW, TZ)).toBe("Yesterday");
    // 02:00 UTC Sep 27 is 7 PM Sep 26 in Los Angeles.
    expect(bellWhen("2026-09-27T02:00:00Z", NOW, TZ)).toBe("Yesterday");
  });
  it("older: its date, with the year only when it isn't this year", () => {
    expect(bellWhen("2026-09-24T18:00:00Z", NOW, TZ)).toBe("Sep 24");
    expect(bellWhen("2025-12-30T18:00:00Z", NOW, TZ)).toBe("Dec 30, 2025");
  });
  it("across a month and a year end", () => {
    expect(bellWhen("2026-12-31T20:00:00Z", new Date("2027-01-01T20:00:00Z"), TZ)).toBe("Yesterday");
    expect(bellWhen("2026-09-30T20:00:00Z", new Date("2026-10-01T20:00:00Z"), TZ)).toBe("Yesterday");
  });
  it("unreadable: nothing", () => {
    expect(bellWhen(null, NOW, TZ)).toBe("");
    expect(bellWhen("not a date", NOW, TZ)).toBe("");
  });
});
