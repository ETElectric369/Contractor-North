import { describe, it, expect } from "vitest";
import {
  armedInstruction,
  dayLabelFrom,
  dayTapMeans,
  dayTargetLabel,
  placeMessage,
} from "./placement-plan";
import { groupByTown, spreadTimes, whatsMissing, type Placeable } from "./place-by-town";
import {
  appointmentTypeFor,
  bookingTitle,
  KIND_FROM_APPT_TYPE,
  WORK_DAY_MINUTES,
  workKind,
} from "./work-shape";

describe("what a day tap means", () => {
  it("opens the day when nothing is picked — the old behaviour is untouched", () => {
    expect(dayTapMeans(0)).toBe("open");
  });

  it("places once work is picked", () => {
    expect(dayTapMeans(1)).toBe("place");
    expect(dayTapMeans(7)).toBe("place");
  });

  it("never arms on a negative count", () => {
    expect(dayTapMeans(-1)).toBe("open");
    expect(dayTargetLabel(0)).toBe("");
    expect(dayTargetLabel(-3)).toBe("");
  });
});

describe("the day says what it will do", () => {
  it("names the count, because he has scrolled away from the rail by then", () => {
    expect(dayTargetLabel(1)).toBe("Put it here");
    expect(dayTargetLabel(4)).toBe("Put 4 here");
  });

  it("points at the calendar rather than offering a third tap", () => {
    expect(armedInstruction(1)).toContain("tap the day on the calendar");
    expect(armedInstruction(3)).toContain("they all go together");
  });
});

describe("the toast tells the truth about a batch", () => {
  const day = "Thursday, Aug 27";

  it("says what landed", () => {
    expect(placeMessage({ leadsBooked: 3, leadsFailed: 0, jobsPlaced: 1, jobsFailed: 0, dayLabel: day }))
      .toEqual({ text: "4 on Thursday, Aug 27.", tone: "success" });
  });

  it("reads naturally for one", () => {
    expect(placeMessage({ leadsBooked: 1, leadsFailed: 0, jobsPlaced: 0, jobsFailed: 0, dayLabel: day }).text)
      .toBe("On Thursday, Aug 27.");
  });

  // NOTHING SILENT — a batch that says "Done" while one of four failed is how trust dies.
  it("names the ones that didn't, in the same sentence", () => {
    const m = placeMessage({ leadsBooked: 2, leadsFailed: 1, jobsPlaced: 1, jobsFailed: 1, dayLabel: day });
    expect(m.tone).toBe("info");
    expect(m.text).toBe("3 on Thursday, Aug 27. 2 didn't — open them and try again.");
  });

  it("is an error, not a success, when nothing landed at all", () => {
    expect(placeMessage({ leadsBooked: 0, leadsFailed: 2, jobsPlaced: 0, jobsFailed: 0, dayLabel: day }))
      .toEqual({ text: "None of those 2 went on Thursday, Aug 27.", tone: "error" });
    expect(placeMessage({ leadsBooked: 0, leadsFailed: 0, jobsPlaced: 0, jobsFailed: 1, dayLabel: day }).tone)
      .toBe("error");
  });
});

describe("the day in the sentence is the day he tapped", () => {
  // THE BUG THAT ALREADY SHIPPED ONCE: new Date("2026-08-27") is UTC midnight, which is the 26th
  // in Truckee. It put a red overdue flag on every lead due today; it is not going in the sentence
  // that confirms a booking.
  it("does not slip a day west of UTC", () => {
    expect(dayLabelFrom("2026-08-27")).toContain("27");
    expect(dayLabelFrom("2026-01-01")).toContain("1");
    expect(dayLabelFrom("2026-03-01")).toContain("Mar");
  });

  it("says 'today' when it is today", () => {
    expect(dayLabelFrom("2026-08-26", "2026-08-26")).toBe("today");
    expect(dayLabelFrom("2026-08-27", "2026-08-26")).not.toBe("today");
  });

  it("hands back garbage unchanged rather than inventing a date", () => {
    expect(dayLabelFrom("")).toBe("");
    expect(dayLabelFrom("not a date")).toBe("not a date");
  });
});

describe("an undated appointment is its own kind", () => {
  // The live dead end: the rail tagged already-agreed inspections as leads, so placing one ran an
  // APPOINTMENT id through convertInquiry — which looks for an inquiry that was never there.
  const appt: Placeable = {
    id: "appt-1",
    kind: "appointment",
    name: "Walk 10816 West River",
    address: "10816 West River Street, Truckee, CA",
    city: null,
    type: null,
  };

  it("is never asked for a phone — the conversation already happened", () => {
    expect(whatsMissing(appt)).toBe("nothing");
    expect(whatsMissing({ ...appt, address: null })).toBe("place");
  });

  it("reads as a walk-through when nobody typed a type", () => {
    expect(workKind(appt)).toBe("walkthrough");
  });

  it("still honours the type it carries", () => {
    expect(workKind({ ...appt, type: "service_call" })).toBe("service");
    expect(workKind({ ...appt, type: "meeting" })).toBe("office");
  });
});

describe("a day is planned as one sequence, not one per kind", () => {
  // THE COLLISION THAT SHIPPED FOR AN HOUR: leads were staggered 90 minutes apart while every
  // appointment got the same literal start, so two inspections and a lead all landed on 08:00 —
  // three customers each told "Thursday at 8".
  it("gives every visit its own slot across both kinds", () => {
    const appts = 2;
    const leads = 2;
    const times = spreadTimes(appts + leads, "08:00", 90);
    expect(times).toEqual(["08:00", "09:30", "11:00", "12:30"]);
    // appointments take the front, leads carry on from where they stop
    expect(times.slice(0, appts)).toEqual(["08:00", "09:30"]);
    expect(times[appts]).toBe("11:00");
    expect(new Set(times).size).toBe(times.length); // no two share an instant
  });

  it("starts the afternoon at one", () => {
    expect(spreadTimes(2, "13:00", 90)).toEqual(["13:00", "14:30"]);
  });
});

describe("the write reads the list in the order the eye reads it", () => {
  // The footer promises "in the order shown" and times are handed out BY POSITION, so the town
  // grouping has to survive to the clock — otherwise the newest lead takes 8am and he drives
  // Truckee -> Tahoe City -> Truckee.
  const items: Placeable[] = [
    { id: "newest", kind: "lead", name: "Tahoe City lead", address: null, city: "Tahoe City" },
    { id: "t1", kind: "lead", name: "Alpha", address: null, city: "Truckee" },
    { id: "t2", kind: "lead", name: "Beta", address: null, city: "Truckee" },
  ];

  it("puts the bigger town first, whatever order the query returned", () => {
    const order = groupByTown(items).flatMap((g) => g.items).map((i) => i.id);
    expect(order).toEqual(["t1", "t2", "newest"]);
  });

  it("keeps that order after the picked filter", () => {
    const picked = new Set(["newest", "t2"]);
    const chosen = groupByTown(items).flatMap((g) => g.items).filter((i) => picked.has(i.id));
    expect(chosen.map((i) => i.id)).toEqual(["t2", "newest"]);
  });
});

describe("a work-day figure is not wall-clock", () => {
  // The rail sells 960 as "2 days". Spending it as 960 real minutes from 08:00 ends the visit at
  // midnight; the day grid can't draw that and would silently shrink it to an hour.
  it("clamps a multi-day size to one working day of wall-clock", () => {
    const span = (m: number) => Math.min(m, WORK_DAY_MINUTES);
    expect(span(960)).toBe(480);
    expect(span(1440)).toBe(480);
    expect(span(120)).toBe(120);
    // 08:00 + a clamped full day never crosses midnight
    const end = new Date(Date.UTC(2026, 7, 27, 8, 0) + span(1440) * 60_000);
    expect(end.getUTCDate()).toBe(27);
  });
});

describe("an already-booked visit shows the kind it already has", () => {
  it("reads its type back into the vocabulary the dropdown speaks", () => {
    expect(KIND_FROM_APPT_TYPE["service_call"]).toBe("service");
    expect(KIND_FROM_APPT_TYPE["inspection"]).toBe("walkthrough");
    expect(KIND_FROM_APPT_TYPE["meeting"]).toBe("office");
  });

  it("shows nothing rather than a guess when it has no type", () => {
    expect(KIND_FROM_APPT_TYPE["" as string]).toBeUndefined();
  });
});

describe("the tag he chose is the tag that lands", () => {
  // Erik: "i just scheduled Matt warren for monday for a whole day as a job and it showed up as an
  // inspection for an hour." Five of six kinds survived to the calendar; 'job' was folded into
  // 'inspection' because appointments.type had no word for it (0231 adds one).
  it("books a job as a job, not a walk-through", () => {
    expect(appointmentTypeFor("job")).toBe("job");
    expect(workKind({ kind: "appointment", type: "job" })).toBe("job");
  });

  it("round-trips every kind the dropdown offers", () => {
    for (const k of ["job", "service", "office", "quote"] as const) {
      expect(workKind({ kind: "appointment", type: appointmentTypeFor(k) })).toBe(k);
    }
    // a walk-through is the fallback and stays one
    expect(appointmentTypeFor("walkthrough")).toBe("inspection");
    expect(workKind({ kind: "appointment", type: "inspection" })).toBe("walkthrough");
  });

  it("stops calling a full day of work a site inspection", () => {
    expect(bookingTitle("job", "Matt Warren")).toBe("Matt Warren");
    expect(bookingTitle("service", "Matt Warren")).toBe("Service call: Matt Warren");
    expect(bookingTitle("walkthrough", "Matt Warren")).toBe("Site inspection: Matt Warren");
  });

  it("never renders a nameless booking as a bare colon", () => {
    expect(bookingTitle("walkthrough", "  ")).toBe("Site inspection: Visit");
  });
});
