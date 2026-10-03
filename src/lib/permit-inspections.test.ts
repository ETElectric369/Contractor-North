import { describe, it, expect } from "vitest";
import { isSchedulable, isWaiting } from "@/lib/waiting-on";
import {
  allInspectionsPassed,
  blockedBy,
  bookedWords,
  inOrder,
  inspectionBlock,
  inspectionLine,
  isUnblocked,
  nextPosition,
  outstandingInspections,
  permitInspectionStand,
  previousOf,
  standLine,
  type PermitInspection,
} from "@/lib/permit-inspections";

/**
 * THE GATE, AND THE THURSDAY IT WAS BUILT FOR (0378).
 *
 * One permit, two authorities, in order: the town tags it, then the utility comes and puts the meter
 * back on in the same visit. BOTH are already booked for the morning of Thursday 15 October, days
 * ahead, by phone — so the gate may never stop a person writing a booking down. What it decides is
 * what the app calls ready and what it dares nag about.
 *
 * The names here are a town and a utility, not a person: no customer, street or number is in this file.
 */
const TOWN = "Town of Truckee";
const UTIL = "Liberty Utilities";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const WED = "2026-10-14";

const row = (over: Partial<PermitInspection> & { position: number }): PermitInspection => ({
  id: `i${over.position}`,
  permit_id: "p1",
  authority: TOWN,
  scheduled_for: null,
  scheduled_window: null,
  inspector: null,
  result: null,
  result_on: null,
  ...over,
});

/** The permit as it stands on Wednesday night: both booked for Thursday morning, neither written up. */
const meterJob = (): PermitInspection[] => [
  row({ position: 1, authority: TOWN, scheduled_for: THU, scheduled_window: "morning" }),
  row({ position: 2, authority: UTIL, scheduled_for: THU, scheduled_window: "morning" }),
];

describe("the order is a gate: only a PASS in front opens the next one", () => {
  it("position 1 is always callable; position 2 waits for the town's tag", () => {
    const rows = meterJob();
    expect(isUnblocked(rows, 1)).toBe(true);
    expect(isUnblocked(rows, 2)).toBe(false);
    expect(blockedBy(rows, 2)).toBe(TOWN);
    expect(blockedBy(rows, 1)).toBeNull();
  });

  it("the town passing is what unblocks the utility — nothing else does", () => {
    for (const result of ["failed", "cancelled"] as const) {
      const rows = meterJob();
      rows[0] = { ...rows[0], result, result_on: THU };
      expect(isUnblocked(rows, 2)).toBe(false);
      expect(blockedBy(rows, 2)).toBe(TOWN);
    }
    const passed = meterJob();
    passed[0] = { ...passed[0], result: "passed", result_on: THU };
    expect(isUnblocked(passed, 2)).toBe(true);
    expect(blockedBy(passed, 2)).toBeNull();
  });

  it("THE ROW IN FRONT, not position minus one: a re-inspection clears the way", () => {
    // A failed final is re-inspected as a NEW row. "Every earlier row passed" would wedge this
    // permit shut forever; the one in front of me passed, so the utility can be called.
    const rows = [
      row({ position: 1, authority: TOWN, result: "failed", result_on: "2026-10-15" }),
      row({ position: 2, authority: TOWN, result: "passed", result_on: "2026-10-20" }),
      row({ position: 5, authority: UTIL, scheduled_for: "2026-10-22", scheduled_window: "morning" }),
    ];
    expect(isUnblocked(rows, 5)).toBe(true); // a GAP in the positions is not "nothing in front of me"
    expect(previousOf(rows, 5)?.position).toBe(2);
  });

  it("reads in position order however the rows arrive, and the next booking goes on the end", () => {
    const jumbled = [row({ position: 2, authority: UTIL }), row({ position: 1 })];
    expect(inOrder(jumbled).map((r) => r.position)).toEqual([1, 2]);
    expect(nextPosition(jumbled)).toBe(3);
    expect(nextPosition([])).toBe(1);
    expect(nextPosition([row({ position: 20 })])).toBe(20); // 0378's ceiling, never past it
  });
});

describe("where the permit stands — one verdict every door reads", () => {
  it("no rows at all: nothing to say, and nothing to nag about", () => {
    const s = permitInspectionStand([], THU);
    expect(s.state).toBe("none");
    expect(s.hisToDo).toBe(false);
    expect(s.waitingOnThem).toBe(false);
    expect(standLine(s)).toBeNull();
  });

  it("Wednesday night: both booked for Thursday — waiting on the town, not his, and not overdue", () => {
    const s = permitInspectionStand(meterJob(), WED);
    expect(s.state).toBe("booked");
    expect(s.authority).toBe(TOWN);
    expect(s.day).toBe(THU);
    expect(s.hisToDo).toBe(false);
    expect(s.waitingOnThem).toBe(true);
    expect(standLine(s)).toBe("Waiting on Town of Truckee — Thu Oct 15, morning");
  });

  it("THE UTILITY IS BLOCKED AND BOOKED AT ONCE, and the verdict names the town: never two rows for one permit", () => {
    const s = permitInspectionStand(meterJob(), THU);
    expect(s.state).toBe("booked");
    expect(s.authority).toBe(TOWN); // the first one that can be called is the subject
    expect(s.outstanding.map((r) => r.authority)).toEqual([TOWN, UTIL]); // both still owed
  });

  it("the town passes: the utility is up next, same day, still booked", () => {
    const rows = meterJob();
    rows[0] = { ...rows[0], result: "passed", result_on: THU, inspector: "Dana" };
    const s = permitInspectionStand(rows, THU);
    expect(s.state).toBe("booked");
    expect(s.authority).toBe(UTIL);
    expect(standLine(s)).toBe("Waiting on Liberty Utilities — Thu Oct 15, morning");
  });

  it("the utility passes: that is the end — the meter is on", () => {
    const rows = meterJob().map((r) => ({ ...r, result: "passed" as const, result_on: THU }));
    const s = permitInspectionStand(rows, THU);
    expect(s.state).toBe("clear");
    expect(s.hisToDo).toBe(false);
    expect(s.waitingOnThem).toBe(false);
    expect(s.outstanding).toEqual([]);
    expect(allInspectionsPassed(rows, THU)).toBe(true);
    expect(standLine(s)).toBe("Every inspection passed — the meter is on");
  });

  it("booked and nobody wrote it up: HIS by the next morning, never before", () => {
    const rows = meterJob();
    expect(permitInspectionStand(rows, THU).state).toBe("booked"); // the day itself is theirs
    const s = permitInspectionStand(rows, FRI);
    expect(s.state).toBe("overdue");
    expect(s.hisToDo).toBe(true);
    expect(s.authority).toBe(TOWN);
    expect(standLine(s)).toBe("Town of Truckee was booked Oct 15 — say how it went");
  });

  it("nobody has called them yet: his to book", () => {
    const s = permitInspectionStand([row({ position: 1, authority: TOWN })], THU);
    expect(s.state).toBe("to_book");
    expect(s.hisToDo).toBe(true);
    expect(standLine(s)).toBe("Town of Truckee inspection to book");
  });

  it("a FAILED town with the utility still open: the work is another town visit, never the blocked one", () => {
    // THE LAW: an inspection that is not unblocked is not overdue and not his. The utility is booked
    // for a day that has gone by, and it is still not what the app asks him about.
    const rows = meterJob();
    rows[0] = { ...rows[0], result: "failed", result_on: THU };
    const s = permitInspectionStand(rows, "2026-10-20");
    expect(s.state).toBe("needs_another");
    expect(s.authority).toBe(TOWN);
    expect(s.hisToDo).toBe(true);
    expect(standLine(s)).toBe("Town of Truckee failed Oct 15 — book another visit");
  });

  it("a cancelled last visit is not an ending: somebody still has to come", () => {
    const rows = [row({ position: 1, authority: TOWN, result: "cancelled", result_on: THU })];
    const s = permitInspectionStand(rows, FRI);
    expect(s.state).toBe("needs_another");
    expect(allInspectionsPassed(rows, FRI)).toBe(false);
    expect(standLine(s)).toBe("Town of Truckee cancelled Oct 15 — book another visit");
  });

  it("a cancelled visit in the middle never counts as an ending either", () => {
    const rows = [
      row({ position: 1, authority: TOWN, result: "passed", result_on: THU }),
      row({ position: 2, authority: UTIL, result: "cancelled", result_on: FRI }),
    ];
    expect(allInspectionsPassed(rows, FRI)).toBe(false);
    expect(permitInspectionStand(rows, FRI).state).toBe("needs_another");
  });

  it("every outstanding visit is listed, settled ones are not", () => {
    const rows = meterJob();
    rows[0] = { ...rows[0], result: "passed", result_on: THU };
    expect(outstandingInspections(rows).map((r) => r.authority)).toEqual([UTIL]);
  });
});

describe("the job's waiting line uses 0178's own words, and is never stored", () => {
  it("waiting on an authority reads as waiting, so the job is not asked for a day", () => {
    const b = inspectionBlock(permitInspectionStand(meterJob(), WED));
    expect(b).toEqual({ blocked_on: "Town of Truckee inspection", blocked_since: null });
    expect(isWaiting(b!)).toBe(true);
    expect(isSchedulable(b!)).toBe(false);
  });

  it("his own move is NOT a wait — that is the half of 0178 that should nag", () => {
    for (const rows of [
      [row({ position: 1 })], // to book
      [row({ position: 1, scheduled_for: WED })], // overdue
      [row({ position: 1, result: "failed" as const, result_on: WED })], // needs another
    ]) {
      expect(inspectionBlock(permitInspectionStand(rows, THU))).toBeNull();
    }
  });

  it("a clear permit is not waiting on anybody", () => {
    const rows = meterJob().map((r) => ({ ...r, result: "passed" as const, result_on: THU }));
    expect(inspectionBlock(permitInspectionStand(rows, THU))).toBeNull();
  });
});

describe("the line a row says on the card", () => {
  it("who, when, and how it went — in that order", () => {
    const rows = meterJob();
    expect(inspectionLine(rows, rows[0])).toBe("Town of Truckee · Thu Oct 15, morning");
    // BOOKED AND STILL BLOCKED SAYS BOTH: the day he phoned for, and the order it has to happen in.
    expect(inspectionLine(rows, rows[1])).toBe("Liberty Utilities · Thu Oct 15, morning · Waits for Town of Truckee");
    const blockedUnbooked = [row({ position: 1, result: "failed" as const, result_on: THU }), row({ position: 2, authority: UTIL })];
    expect(inspectionLine(blockedUnbooked, blockedUnbooked[1])).toBe("Liberty Utilities · Waits for Town of Truckee");
    const unbooked = [row({ position: 1, authority: UTIL })];
    expect(inspectionLine(unbooked, unbooked[0])).toBe("Liberty Utilities · Not booked yet");
    const done = [row({ position: 1, authority: TOWN, result: "passed" as const, result_on: THU, inspector: "Dana" })];
    expect(inspectionLine(done, done[0])).toBe("Town of Truckee · Passed Oct 15 · Dana");
  });

  it("a day with no window still reads as a day; a part-day is named", () => {
    expect(bookedWords({ scheduled_for: THU, scheduled_window: null })).toBe("Thu Oct 15");
    expect(bookedWords({ scheduled_for: THU, scheduled_window: "all_day" })).toBe("Thu Oct 15, all day");
    expect(bookedWords({ scheduled_for: null, scheduled_window: "morning" })).toBeNull();
  });
});
