import { describe, it, expect } from "vitest";
import { splitAgenda } from "./agenda-split";

/**
 * The bug this file exists to prevent, in Erik's words:
 * "all the inspections i've completed are on my day saying LATER when they already happened".
 */

const at = (hhmm: string) => ({ time: `2026-08-02T${hhmm}:00.000Z`, id: hhmm });
const NOON = new Date("2026-08-02T12:00:00.000Z");

describe("what already happened is never called Later", () => {
  it("puts a morning visit in earlier, not later", () => {
    const { earlier, later } = splitAgenda([at("09:00")], NOON);
    expect(earlier.map((i) => i.id)).toEqual(["09:00"]);
    expect(later).toEqual([]);
  });

  it("splits a full day around the clock", () => {
    const day = [at("08:00"), at("10:00"), at("13:00"), at("15:00"), at("17:00")];
    const { earlier, next, later } = splitAgenda(day, NOON);
    expect(earlier.map((i) => i.id)).toEqual(["08:00", "10:00"]);
    expect(next.map((i) => i.id)).toEqual(["13:00", "15:00"]); // the soonest two ahead
    expect(later.map((i) => i.id)).toEqual(["17:00"]);
  });

  it("NOTHING is dropped — the earlier fix that lost past items must not come back", () => {
    const day = [at("08:00"), at("10:00"), at("13:00"), at("15:00"), at("17:00")];
    const { earlier, next, later } = splitAgenda(day, NOON);
    expect(earlier.length + next.length + later.length).toBe(day.length);
  });

  it("an item exactly now counts as happened, not upcoming", () => {
    const { earlier, next } = splitAgenda([{ time: NOON.toISOString(), id: "noon" }], NOON);
    expect(earlier).toHaveLength(1);
    expect(next).toHaveLength(0);
  });
});

describe("ordering", () => {
  it("earlier reads chronologically, so the oldest unfinished thing is on top", () => {
    const { earlier } = splitAgenda([at("10:00"), at("08:00"), at("09:00")], NOON);
    expect(earlier.map((i) => i.id)).toEqual(["08:00", "09:00", "10:00"]);
  });

  it("does not mutate the caller's array", () => {
    const day = [at("15:00"), at("08:00")];
    splitAgenda(day, NOON);
    expect(day.map((i) => i.id)).toEqual(["15:00", "08:00"]);
  });
});

describe("untimed and unparseable", () => {
  it("an untimed item has no position on the clock, so it rides at the end of Later", () => {
    // Three upcoming so the third falls past `next` and shares Later with the untimed one.
    const items = [at("13:00"), at("15:00"), at("17:00"), { time: null, id: "anytime" }];
    const { next, later } = splitAgenda(items, NOON);
    expect(next.map((i) => i.id)).toEqual(["13:00", "15:00"]);
    expect(later.map((i) => i.id)).toEqual(["17:00", "anytime"]);
  });

  it("an untimed item is never mistaken for the next thing you must do", () => {
    const { next, later } = splitAgenda([{ time: null, id: "anytime" }], NOON);
    expect(next).toEqual([]);
    expect(later.map((i) => i.id)).toEqual(["anytime"]);
  });

  it("a garbage timestamp is untimed, NOT 1970 — it must not fake being earlier", () => {
    // new Date("soon").getTime() is NaN; a naive comparison sorts it silently into the past.
    const { earlier, later } = splitAgenda([{ time: "soon", id: "junk" }], NOON);
    expect(earlier).toEqual([]);
    expect(later.map((i) => i.id)).toEqual(["junk"]);
  });
});

describe("an empty or all-past day", () => {
  it("no items, no buckets", () => {
    expect(splitAgenda([], NOON)).toEqual({ earlier: [], next: [], later: [] });
  });

  it("a day that is entirely behind you leaves Next and Later genuinely empty", () => {
    // This is what makes My Day able to say "nothing left today" truthfully instead of
    // printing a Later heading over work that is already done.
    const { earlier, next, later } = splitAgenda([at("08:00"), at("09:00")], NOON);
    expect(earlier).toHaveLength(2);
    expect(next).toEqual([]);
    expect(later).toEqual([]);
  });
});
