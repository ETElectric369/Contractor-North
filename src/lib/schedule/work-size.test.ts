import { describe, it, expect } from "vitest";
import { daysNeeded, parseDuration, spanEnd, workingDaysFrom, durationLabel } from "./work-shape";

describe("type how long it takes, the way you'd say it", () => {
  it("reads the shapes a person actually writes", () => {
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("45 min")).toBe(45);
    expect(parseDuration("1.5h")).toBe(90);
    expect(parseDuration("3 hours")).toBe(180);
    expect(parseDuration("1h30")).toBe(90);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("2 hours 15")).toBe(135);
  });

  it("counts a DAY as a working day, never 24 hours", () => {
    expect(parseDuration("1d")).toBe(480);
    expect(parseDuration("3 days")).toBe(1440);
    expect(parseDuration("1 week")).toBe(2400); // five working days
  });

  it("treats a bare number as minutes — '90' is a 90-minute visit, not two days", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("480")).toBe(480);
  });

  // NULL IS NOT ZERO. An unreadable entry must leave the old value alone rather than store a
  // confident wrong answer — the caller says so out loud instead.
  it("refuses what it cannot read", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("a while")).toBeNull();
    expect(parseDuration("soon-ish")).toBeNull();
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("-3h")).toBeNull();
    expect(parseDuration("99 days")).toBeNull(); // past the column's 30-day ceiling
  });

  it("round-trips through the label he'll see", () => {
    expect(durationLabel(parseDuration("45m"))).toBe("45m");
    expect(durationLabel(parseDuration("1.5h"))).toBe("1.5h");
    expect(durationLabel(parseDuration("3 days"))).toBe("3 days");
  });
});

describe("three days means three days on the calendar", () => {
  // Erik: "i just set it for 3 days and it only showed up on the schedule for 1 day."
  it("turns a size into a number of days", () => {
    expect(daysNeeded(1440)).toBe(3);
    expect(daysNeeded(960)).toBe(2);
    expect(daysNeeded(480)).toBe(1);
    expect(daysNeeded(120)).toBe(1);
    expect(daysNeeded(600)).toBe(2); // a day and a bit still occupies two days
  });

  it("gives an unsized job one day, never zero", () => {
    expect(daysNeeded(null)).toBe(1);
    expect(daysNeeded(0)).toBe(1);
  });

  it("runs consecutive days and skips the weekend", () => {
    // Wed 2026-09-02 → Wed, Thu, Fri
    expect(workingDaysFrom("2026-09-02", 3)).toEqual(["2026-09-02", "2026-09-03", "2026-09-04"]);
    // Thu 2026-09-03 → Thu, Fri, then MONDAY
    expect(workingDaysFrom("2026-09-03", 3)).toEqual(["2026-09-03", "2026-09-04", "2026-09-07"]);
  });

  // THE DAY HE TAPPED IS ALWAYS DAY ONE — second-guessing the one day he explicitly chose would
  // be the app knowing better than the person.
  it("honours a weekend start he chose himself", () => {
    expect(workingDaysFrom("2026-09-05", 2)).toEqual(["2026-09-05", "2026-09-07"]); // Sat, then Mon
  });

  it("does not slip a day west of UTC", () => {
    // Parsed as a LOCAL date; new Date("2026-09-02") would be the 1st in Truckee.
    expect(workingDaysFrom("2026-09-02", 1)).toEqual(["2026-09-02"]);
  });

  it("returns nothing for a non-date rather than guessing", () => {
    expect(workingDaysFrom("nope", 3)).toEqual([]);
  });
});

import {
  appointmentTypeFor,
  bookingTitle,
  isWorkKind,
  KIND_FROM_APPT_TYPE,
  KIND_LABEL,
  KIND_TONE,
  kindOptions,
  PICKABLE_WORK_KINDS,
  suggestedVisitTitle,
  WORK_KINDS,
  workKind,
} from "./work-shape";
import { jobDayBlock } from "./job-block";
import { tzDateTimeUtc } from "../tz";
import { APPOINTMENT_TYPES, PICKABLE_APPOINTMENT_TYPES, appointmentTypeLabel } from "@/lib/statuses";

/**
 * THE TEST THAT WOULD HAVE CAUGHT IT.
 *
 * Erik picked "Phone call" and got "That isn't a kind of work." The dropdown offered a kind the
 * validator rejected, because the vocabulary was hand-copied into five places and 'call' reached
 * four of them. Nothing was broken in isolation — every piece was individually fine and the SET
 * disagreed with itself.
 *
 * So the assertion is over the whole set: every kind the app offers must survive the entire round
 * trip — validate, book, come back, render. Adding a seventh kind and forgetting one leg fails
 * here rather than in his hands.
 */
describe("every kind the app offers survives the round trip", () => {
  it("passes the gate every writer uses", () => {
    for (const k of WORK_KINDS) expect(isWorkKind(k)).toBe(true);
    expect(isWorkKind("nonsense")).toBe(false);
    expect(isWorkKind("")).toBe(false);
  });

  it("books as a type the appointments table actually allows", () => {
    for (const k of WORK_KINDS) {
      expect(APPOINTMENT_TYPES as readonly string[]).toContain(appointmentTypeFor(k));
    }
  });

  it("reads back as the same kind it was booked as", () => {
    for (const k of WORK_KINDS) {
      expect(workKind({ kind: "appointment", type: appointmentTypeFor(k) })).toBe(k);
    }
  });

  it("has a label and a tone — no blank badges", () => {
    for (const k of WORK_KINDS) {
      expect(KIND_LABEL[k]).toBeTruthy();
      expect(KIND_TONE[k]).toBeTruthy();
      expect(bookingTitle(k, "Braden Lang")).toContain("Braden Lang");
    }
  });

  it("names every appointment type it can produce, in both directions", () => {
    for (const t of APPOINTMENT_TYPES) {
      expect(appointmentTypeLabel(t)).toBeTruthy();
      expect(appointmentTypeLabel(t)).not.toBe(t); // a raw enum value is not a label
    }
    for (const k of WORK_KINDS) {
      expect(KIND_FROM_APPT_TYPE[appointmentTypeFor(k)]).toBe(k);
    }
  });

  it("includes the phone call that started this", () => {
    expect(WORK_KINDS).toContain("call");
    expect(appointmentTypeFor("call")).toBe("call");
    expect(KIND_LABEL.call).toBe("Phone Call");
    expect(bookingTitle("call", "Mike Scrivano")).toBe("Call Mike Scrivano");
  });
});

/**
 * FIVE KINDS TO PICK (W2-06): Walk-Through, Job, Service Call, Phone Call, Other. The pickers offer
 * exactly these (and a row's own old kind); the guards still accept every known kind, so nothing an
 * old row already is can be refused.
 */
describe("the five kinds a person picks survive the round trip, Other included", () => {
  it("are the five, in the picker's order, each a kind a writer accepts", () => {
    expect([...PICKABLE_WORK_KINDS]).toEqual(["walkthrough", "job", "service", "call", "other"]);
    for (const k of PICKABLE_WORK_KINDS) expect(isWorkKind(k) || k === "other", k).toBe(true);
    expect(PICKABLE_WORK_KINDS.map((k) => KIND_LABEL[k])).toEqual(["Walk-Through", "Job", "Service Call", "Phone Call", "Other"]);
  });

  it("book as a type the table allows and a person can pick, and read back as the kind picked", () => {
    for (const k of PICKABLE_WORK_KINDS) {
      const type = appointmentTypeFor(k);
      expect(APPOINTMENT_TYPES as readonly string[]).toContain(type);
      expect(PICKABLE_APPOINTMENT_TYPES as readonly string[]).toContain(type);
      expect(workKind({ kind: "appointment", type })).toBe(k);
      expect(workKind({ kind: "lead", workKind: k })).toBe(k);
    }
  });

  it("Other books as Other, never a walk-through (and never the walk-through's title)", () => {
    expect(appointmentTypeFor("other")).toBe("other");
    expect(workKind({ kind: "appointment", type: "other" })).toBe("other");
    expect(bookingTitle("other", "Braden Lang")).toBe("Braden Lang");
    // …while a lead nobody tagged still books the walk-through it always did.
    expect(appointmentTypeFor(null)).toBe("inspection");
    expect(appointmentTypeFor("")).toBe("inspection");
  });

  it("an old lead tagged Quote or Office still reads back, and its picker still offers it", () => {
    expect(workKind({ kind: "lead", workKind: "quote" })).toBe("quote");
    expect(workKind({ kind: "lead", workKind: "office" })).toBe("office");
    expect(workKind({ kind: "appointment", type: "meeting" })).toBe("office");
    expect(kindOptions("quote")).toEqual(["walkthrough", "job", "service", "call", "other", "quote"]);
    expect(kindOptions("office")).toEqual(["walkthrough", "job", "service", "call", "other", "office"]);
    // A current kind adds nothing; junk or nothing is never offered.
    expect(kindOptions("job")).toEqual([...PICKABLE_WORK_KINDS]);
    expect(kindOptions("nonsense")).toEqual([...PICKABLE_WORK_KINDS]);
    expect(kindOptions(null)).toEqual([...PICKABLE_WORK_KINDS]);
  });

  it("the New Appointment title follows its type", () => {
    const ctx = { jobName: "3245 West Lake Boulevard", customerName: "Rita Moss", place: "12 Elm St, Testville, CA 96161" };
    expect(suggestedVisitTitle("job", ctx)).toBe("3245 West Lake Boulevard"); // the job's own name
    expect(suggestedVisitTitle("inspection", ctx)).toBe("Walk-Through: Rita Moss");
    expect(suggestedVisitTitle("inspection", { place: "12 Elm St, Testville, CA 96161" })).toBe("Walk-Through: 12 Elm St");
    expect(suggestedVisitTitle("other", ctx)).toBe("Rita Moss");
    expect(suggestedVisitTitle("service_call", ctx)).toBe("Service call: Rita Moss");
    expect(suggestedVisitTitle("call", ctx)).toBe("Call Rita Moss");
    expect(suggestedVisitTitle("meeting", ctx)).toBe("Meeting: Rita Moss"); // an old row's own kind
    // Nothing to name it by: nothing suggested, never a made-up "Visit".
    expect(suggestedVisitTitle("inspection", {})).toBe("");
    expect(suggestedVisitTitle("", {})).toBe("");
  });
});

describe("a job's block is as long as somebody said, not as long as the shop is open", () => {
  // The rule moved to lib/schedule/job-block (jobDayBlock); these are its old cases, on the new rule.
  const tz = "America/Los_Angeles";
  const day = "2026-09-02";
  const wd = { startMin: 8 * 60, endMin: 18 * 60 };
  const at = (hm: string) => tzDateTimeUtc(day, hm, tz);
  const draw = (start: string, end: string | null, planned: number | null) =>
    jobDayBlock({ day, scheduledStart: at(start), scheduledEnd: end ? at(end) : null, plannedMinutes: planned, tz, wd });

  // Erik, on a job converted from a 3-hour visit: "im not sure why it says 5 hours."
  it("uses the size when there is no explicit finish", () => {
    expect(draw("13:00", null, 180).endMin).toBe(16 * 60);
  });

  it("an older row nobody sized, with no end on file, still draws to the shop's close", () => {
    expect(draw("13:00", null, null).endMin).toBe(18 * 60);
  });

  it("a real finish that isn't the closing-time stamp is the finish", () => {
    expect(draw("13:00", "15:00", 180).endMin).toBe(15 * 60);
  });

  it("the closing-time stamp never beats the size (J-058, 2026-09-28)", () => {
    expect(draw("13:00", "18:00", 180).endMin).toBe(16 * 60);
  });

  it("never inverts, even on nonsense", () => {
    expect(draw("19:00", null, null).endMin).toBe(20 * 60);
    expect(draw("13:00", "09:00", null).endMin).toBe(18 * 60);
  });
});

describe("a week of work ends on Friday", () => {
  // Erik: "i set it for a week (lets make that the 5 working days by default) but it only showed
  // up as 1 day."
  it("runs five working days from a Monday", () => {
    // Mon 2026-08-31 → Fri 2026-09-04, same hour
    expect(spanEnd("2026-08-31", "08:00", 2400)).toEqual({ lastYmd: "2026-09-04", endHHMM: "16:00" });
  });

  it("skips the weekend in the middle", () => {
    // Thu + 3 days of work → Thu, Fri, Mon
    expect(spanEnd("2026-09-03", "08:00", 1440)?.lastYmd).toBe("2026-09-07");
  });

  it("finishes at lunchtime when the last day is a half day", () => {
    // 1.5 days from 8am → day two ends at noon
    expect(spanEnd("2026-09-02", "08:00", 720)).toEqual({ lastYmd: "2026-09-03", endHHMM: "12:00" });
  });

  it("keeps a single day on its own day", () => {
    expect(spanEnd("2026-09-02", "13:00", 180)).toEqual({ lastYmd: "2026-09-02", endHHMM: "16:00" });
  });

  it("has nothing to say about an unsized booking", () => {
    expect(spanEnd("2026-09-02", "08:00", null)).toBeNull();
    expect(spanEnd("2026-09-02", "08:00", 0)).toBeNull();
    expect(spanEnd("nope", "08:00", 480)).toBeNull();
  });

  it("never rolls a finish past midnight", () => {
    expect(spanEnd("2026-09-02", "23:00", 480)?.endHHMM).toBe("23:59");
  });
});

describe("a timed job that starts when the shop opens is still timed", () => {
  // Nora's service call is 9-11, and the shop opens at 9 — a start-only sentinel test read her
  // real 9:00 as "all-day" and stretched a two-hour visit across the whole day.
  const wdStart = 9 * 60;
  const wdEnd = 17 * 60;
  const explicit = (sMin: number, eMin: number | null) =>
    sMin !== wdStart || (eMin != null && eMin !== wdEnd && eMin > sMin);

  it("reads 9-11 as a real block, not the sentinel", () => {
    expect(explicit(9 * 60, 11 * 60)).toBe(true);
  });

  it("still reads 9-5 (and 9 with no end) as all-day", () => {
    expect(explicit(9 * 60, 17 * 60)).toBe(false);
    expect(explicit(9 * 60, null)).toBe(false);
  });

  it("a start off the window is timed regardless of end", () => {
    expect(explicit(13 * 60, null)).toBe(true);
  });

  it("garbage ends don't fake a timed block", () => {
    expect(explicit(9 * 60, 8 * 60)).toBe(false); // end before start = not a real end
  });
});
