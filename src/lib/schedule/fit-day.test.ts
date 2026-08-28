import { describe, it, expect } from "vitest";
import { fitIntoDay, hmToMinutes, mergeBusy, minutesToHm, PINNED_TO_TOP } from "./fit-day";

const at = (hm: string) => hmToMinutes(hm)!;
const block = (a: string, z: string) => ({ startMin: at(a), endMin: at(z) });

describe("the next one lands in the gap, not on top", () => {
  // Erik: "when im filling in the next job after nora i choose morning then it should fill in the
  // gap inbetween not put it at the same time."
  it("starts after what is already booked", () => {
    const nora = [block("08:00", "10:00")];
    const [start] = fitIntoDay(nora, [{ minutes: 60 }], { fromMin: at("08:00") });
    expect(minutesToHm(start)).toBe("10:00");
  });

  it("uses a real gap between two bookings when the item fits", () => {
    const day = [block("08:00", "09:00"), block("12:00", "14:00")];
    const [start] = fitIntoDay(day, [{ minutes: 60 }], { fromMin: at("08:00") });
    expect(minutesToHm(start)).toBe("09:00"); // the FIRST opening, read top-down
  });

  it("skips a gap that is too small and takes the next one", () => {
    const day = [block("08:00", "09:00"), block("09:30", "11:00")];
    const [start] = fitIntoDay(day, [{ minutes: 120 }], { fromMin: at("08:00") });
    expect(minutesToHm(start)).toBe("11:00"); // 30 minutes won't hold a two-hour job
  });

  it("leaves an empty day exactly where he asked", () => {
    const [start] = fitIntoDay([], [{ minutes: 60 }], { fromMin: at("08:00") });
    expect(minutesToHm(start)).toBe("08:00");
  });

  it("honours the afternoon as its own region", () => {
    const day = [block("08:00", "10:00")];
    const [start] = fitIntoDay(day, [{ minutes: 60 }], { fromMin: at("13:00") });
    expect(minutesToHm(start)).toBe("13:00"); // the morning booking is behind him
  });
});

describe("a batch never collides with itself", () => {
  it("stacks its own items back to back", () => {
    const times = fitIntoDay([], [{ minutes: 60 }, { minutes: 120 }, { minutes: 30 }], {
      fromMin: at("08:00"),
    }).map(minutesToHm);
    expect(times).toEqual(["08:00", "09:00", "11:00"]);
  });

  it("fits a batch around existing work", () => {
    const times = fitIntoDay([block("09:00", "10:00")], [{ minutes: 60 }, { minutes: 60 }], {
      fromMin: at("08:00"),
    }).map(minutesToHm);
    expect(times).toEqual(["08:00", "10:00"]); // first fills the gap before, second after
  });

  // BLANK IS NOT ZERO — an unsized item still takes room, or two of them stack on one instant.
  it("gives an unsized item a nominal width rather than none", () => {
    const times = fitIntoDay([], [{ minutes: null }, { minutes: null }], { fromMin: at("08:00") })
      .map(minutesToHm);
    expect(times[0]).toBe("08:00");
    expect(times[1]).not.toBe("08:00");
  });
});

describe("a phone call costs the route nothing", () => {
  it("is pinned, and pushes nothing later", () => {
    const times = fitIntoDay([], [{ minutes: 30, pinned: true }, { minutes: 60 }], {
      fromMin: at("08:00"),
    });
    expect(times[0]).toBe(PINNED_TO_TOP);
    expect(minutesToHm(times[1])).toBe("08:00"); // the visit still gets 8am
  });
});

describe("it never silently drops a placement", () => {
  it("lands a late item after everything rather than refusing", () => {
    const full = [block("08:00", "21:00")];
    const [start] = fitIntoDay(full, [{ minutes: 60 }], { fromMin: at("08:00") });
    expect(start).toBeGreaterThanOrEqual(at("21:00"));
  });
});

describe("busy blocks merge before they are read", () => {
  it("collapses overlaps so a gap search can't be fooled", () => {
    expect(mergeBusy([block("08:00", "10:00"), block("09:00", "11:00")]))
      .toEqual([{ startMin: at("08:00"), endMin: at("11:00") }]);
  });

  it("drops zero-length and inverted junk", () => {
    expect(mergeBusy([block("10:00", "10:00"), block("11:00", "09:00")])).toEqual([]);
  });
});

describe("time strings survive the round trip", () => {
  it("reads and writes HH:MM", () => {
    expect(hmToMinutes("13:30")).toBe(810);
    expect(minutesToHm(810)).toBe("13:30");
    expect(hmToMinutes("25:00")).toBeNull();
    expect(hmToMinutes("nope")).toBeNull();
  });

  it("never rolls into tomorrow", () => {
    expect(minutesToHm(24 * 60 + 30)).toBe("23:59");
  });
});
