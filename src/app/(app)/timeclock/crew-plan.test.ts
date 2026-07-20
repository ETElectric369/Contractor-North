import { describe, expect, it } from "vitest";
import {
  dayParts,
  dayTag,
  orgWeekDayStrs,
  patchWeekRows,
  shortJobTag,
  weekRangeLabel,
  type CrewAssignmentRow,
} from "./crew-plan";

const LA = "America/Los_Angeles";
// Sun Jul 19 2026, 1:00 PM in LA (20:00Z).
const SUNDAY_AFTERNOON = new Date("2026-07-19T20:00:00Z");
// Sun Jul 19 2026, 8:00 PM in LA — already Mon Jul 20 in UTC. The org-tz
// anchor case: a UTC-day week would jump a week early.
const SUNDAY_EVENING = new Date("2026-07-20T03:00:00Z");

describe("orgWeekDayStrs", () => {
  it("monday-start week containing an org-local Sunday runs Mon..Sun", () => {
    const days = orgWeekDayStrs(0, LA, "monday", SUNDAY_AFTERNOON);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-07-13"); // Monday
    expect(days[6]).toBe("2026-07-19"); // the Sunday itself
  });

  it("sunday-start week starts on that same Sunday", () => {
    const days = orgWeekDayStrs(0, LA, "sunday", SUNDAY_AFTERNOON);
    expect(days[0]).toBe("2026-07-19");
    expect(days[6]).toBe("2026-07-25");
  });

  it("anchors on the ORG-tz day, not the server's UTC day", () => {
    // 03:00Z Mon Jul 20 is still Sunday evening in LA — the monday-start week
    // must still be Jul 13..19, not jump ahead to Jul 20..26.
    const days = orgWeekDayStrs(0, LA, "monday", SUNDAY_EVENING);
    expect(days[0]).toBe("2026-07-13");
    expect(days[6]).toBe("2026-07-19");
  });

  it("offset is SIGNED: +1 pages forward (planning ahead), -1 back", () => {
    expect(orgWeekDayStrs(1, LA, "monday", SUNDAY_AFTERNOON)[0]).toBe("2026-07-20");
    expect(orgWeekDayStrs(-1, LA, "monday", SUNDAY_AFTERNOON)[0]).toBe("2026-07-06");
  });

  it("days are consecutive", () => {
    const days = orgWeekDayStrs(2, LA, "sunday", SUNDAY_AFTERNOON);
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(`${days[i - 1]}T00:00:00Z`).getTime();
      expect(new Date(`${days[i]}T00:00:00Z`).getTime() - prev).toBe(86_400_000);
    }
  });
});

describe("labels", () => {
  it("weekRangeLabel spans first to last day", () => {
    const days = orgWeekDayStrs(0, LA, "monday", SUNDAY_AFTERNOON);
    expect(weekRangeLabel(days)).toBe("Jul 13 – Jul 19");
    expect(weekRangeLabel([])).toBe("");
  });

  it("dayParts / dayTag are tz-stable for a date string", () => {
    expect(dayParts("2026-07-13")).toEqual({ dow: "Mon", dom: "13" });
    expect(dayTag("2026-07-21")).toBe("Tue, Jul 21");
  });
});

describe("shortJobTag", () => {
  const job = {
    job_number: "J-0042",
    name: "Panel swap",
    address: "123 Main St",
    customer_name: "Smith",
  };
  it("codes on → the job number (matching the /timecards pills)", () => {
    expect(shortJobTag(job, true)).toBe("J-0042");
  });
  it("codes off → the customer, then the address, then name", () => {
    expect(shortJobTag(job, false)).toBe("Smith");
    expect(shortJobTag({ ...job, customer_name: null }, false)).toBe("123 Main St");
    expect(shortJobTag({ ...job, customer_name: "  ", address: "" }, false)).toBe("Panel swap");
  });
  it("null job never crashes a cell", () => {
    expect(shortJobTag(null, true)).toBe("Job");
    expect(shortJobTag(undefined, false)).toBe("Job");
  });
});

describe("patchWeekRows", () => {
  const base: CrewAssignmentRow[] = [
    { profile_id: "p1", work_date: "2026-07-20", job_id: "a", is_crew_lead: false },
    { profile_id: "p2", work_date: "2026-07-20", job_id: "b", is_crew_lead: true },
  ];

  it("inserts a new (member, day) row", () => {
    const out = patchWeekRows(base, "p1", "2026-07-21", { job_id: "c", is_crew_lead: false });
    expect(out).toHaveLength(3);
    expect(out.find((r) => r.profile_id === "p1" && r.work_date === "2026-07-21")?.job_id).toBe("c");
  });

  it("replaces the existing row for that member+day only", () => {
    const out = patchWeekRows(base, "p1", "2026-07-20", { job_id: "z", is_crew_lead: true });
    expect(out).toHaveLength(2);
    const p1 = out.find((r) => r.profile_id === "p1");
    expect(p1?.job_id).toBe("z");
    expect(p1?.is_crew_lead).toBe(true);
    // p2's lead flag untouched — per-row patch, never a clobber.
    expect(out.find((r) => r.profile_id === "p2")?.is_crew_lead).toBe(true);
  });

  it("null clears the row (jobId-null semantics) and rollback restores it", () => {
    const cleared = patchWeekRows(base, "p2", "2026-07-20", null);
    expect(cleared).toHaveLength(1);
    const restored = patchWeekRows(cleared, "p2", "2026-07-20", {
      job_id: "b",
      is_crew_lead: true,
    });
    expect(restored).toHaveLength(2);
    expect(restored.find((r) => r.profile_id === "p2")?.is_crew_lead).toBe(true);
  });

  it("does not mutate the input", () => {
    patchWeekRows(base, "p1", "2026-07-20", null);
    expect(base).toHaveLength(2);
  });
});
