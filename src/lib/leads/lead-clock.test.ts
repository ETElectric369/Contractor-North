import { describe, it, expect } from "vitest";
import { elapsedParts, sayElapsed } from "./lead-clock";

const AT = "2026-11-19T16:00:00.000Z";
const later = (min: number) => Date.parse(AT) + min * 60_000;

describe("lib/leads/lead-clock (cn-v1170): how long a lead has waited", () => {
  it.each([
    [0, "0m"],
    [14, "14m"],
    [59, "59m"],
    [60, "1h 0m"],
    [134, "2h 14m"],
    [1439, "23h 59m"],
    [1440, "1d 0h"],
    [3 * 1440 + 4 * 60 + 59, "3d 4h"],
    [45 * 1440, "45d 0h"],
  ])("%i minutes reads %s", (min, said) => {
    expect(sayElapsed(AT, later(min))).toBe(said);
  });

  it("seconds never round up a minute", () => {
    expect(sayElapsed(AT, later(14) + 59_000)).toBe("14m");
  });

  it("a time ahead of now reads as zero, and a date that does not parse is null", () => {
    expect(sayElapsed(AT, later(-5))).toBe("0m");
    expect(sayElapsed("not a date", later(5))).toBeNull();
    expect(sayElapsed(null, later(5))).toBeNull();
    expect(elapsedParts(AT, Number.NaN)).toBeNull();
  });

  it("the units are the caller's (Spanish through its catalog)", () => {
    const es = { minutes: "{m} min", hoursMinutes: "{h} h {m} min", daysHours: "{d} d {h} h" };
    expect(sayElapsed(AT, later(14), es)).toBe("14 min");
    expect(sayElapsed(AT, later(134), es)).toBe("2 h 14 min");
    expect(sayElapsed(AT, later(3 * 1440 + 240), es)).toBe("3 d 4 h");
  });
});
