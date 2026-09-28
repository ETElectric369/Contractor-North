import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tzDateTimeUtc } from "@/lib/tz";
import { bookedKeys, dayRange, visitDays } from "./booked-days";
import { segmentJobsNotLoaded } from "./cal-window";

/**
 * WHICH DAYS WERE BOOKED (Wave 2, SV-ghost), from the RAW rows, never from what the grid draws after
 * the person filter: a job's segments (when it has any), else its listed span; a visit on the job (not
 * cancelled; absorbed ones too, the job took their slot), its later days on working days; a call is
 * not a booking of the work. And the jobs a window segment names that the listed-span read didn't
 * bring are read by id, so a booked worked day always draws (the schedule fix's segmentJobsNotLoaded,
 * the brief's missingSegmentJobIds, kept as the one read).
 */
const LA = "America/Los_Angeles";
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA) as string;

describe("the day rules, once", () => {
  it("a range is every day, inclusive; an end before its start is its start; capped", () => {
    expect(dayRange("2026-09-26", "2026-09-29")).toEqual(["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"]);
    expect(dayRange("2026-09-26", "2026-09-20")).toEqual(["2026-09-26"]);
    expect(dayRange("nope", "2026-09-20")).toEqual([]);
    expect(dayRange("2026-01-01", "2027-12-31", 10)).toHaveLength(10);
  });

  it("a visit's days: its first day always (a Saturday visit is a Saturday visit), then working days", () => {
    // Fri Sep 25 to Tue Sep 29: Fri, Mon, Tue.
    expect(visitDays("2026-09-25", "2026-09-29")).toEqual(["2026-09-25", "2026-09-28", "2026-09-29"]);
    expect(visitDays("2026-09-26", "2026-09-26")).toEqual(["2026-09-26"]);
    expect(visitDays("2026-09-26", null)).toEqual(["2026-09-26"]);
  });

  it("the calendar's grid expands a job's and a visit's days with these same rules", () => {
    const view = readFileSync(join(process.cwd(), "src/app/(app)/calendar/calendar-view.tsx"), "utf8");
    expect(view).toContain("if (segs?.length) return segs.map((s) => dayRange(s.start_date, s.end_date));");
    expect(view).toContain("return visitDays(first, last);");
    expect(view).toContain("const booked = useMemo(() => bookedKeys({ segments, jobs, appointments, tz }), [segments, jobs, appointments, tz]);");
  });
});

describe("bookedKeys", () => {
  const keys = (p: Partial<Parameters<typeof bookedKeys>[0]>) =>
    [...bookedKeys({ segments: [], jobs: [], appointments: [], tz: LA, ...p })].sort();

  it("J-011 9/24: a timed segment books that day; a job's segments win over its listed span", () => {
    expect(
      keys({
        segments: [{ job_id: "j11", start_date: "2026-09-24", end_date: "2026-09-24" }],
        jobs: [{ id: "j11", scheduled_start: at("2026-09-28", "09:00"), scheduled_end: at("2026-09-28", "17:00") }],
      }),
    ).toEqual(["j11|2026-09-24"]);
  });

  it("J-052 9/23: a job with no segments is booked on its listed span, each end on the company's day", () => {
    expect(keys({ jobs: [{ id: "j52", scheduled_start: at("2026-09-23", "10:00"), scheduled_end: at("2026-09-24", "17:00") }] })).toEqual([
      "j52|2026-09-23",
      "j52|2026-09-24",
    ]);
    // An evening start is the Pacific day, never the UTC next day.
    expect(keys({ jobs: [{ id: "j9", scheduled_start: at("2026-09-23", "20:30"), scheduled_end: null }] })).toEqual(["j9|2026-09-23"]);
  });

  it("a visit on the job books its day (absorbed too); a cancelled one, a call and a visit with no job don't", () => {
    expect(
      keys({
        appointments: [
          { job_id: "j11", starts_at: at("2026-09-25", "10:00"), ends_at: null, status: "scheduled", type: "service_call" },
          { job_id: "j12", starts_at: at("2026-09-25", "10:00"), ends_at: null, status: "cancelled", type: "service_call" },
          { job_id: "j13", starts_at: at("2026-09-25", "10:00"), ends_at: null, status: "scheduled", type: "call" },
          { job_id: null, starts_at: at("2026-09-25", "10:00"), ends_at: null, status: "scheduled", type: "inspection" },
          { job_id: "j14", starts_at: at("2026-09-25", "09:00"), ends_at: at("2026-09-29", "11:00"), status: "completed", type: "job" },
        ],
      }),
    ).toEqual(["j11|2026-09-25", "j14|2026-09-25", "j14|2026-09-28", "j14|2026-09-29"]);
  });

  it("a job whose date was cleared keeps its worked days as segments: booked on those days, and read by id", () => {
    expect(keys({ segments: [{ job_id: "cleared", start_date: "2026-09-22", end_date: "2026-09-22" }] })).toEqual(["cleared|2026-09-22"]);
    // The listed-span read never brings it; the second read names it (one read, not two).
    expect(segmentJobsNotLoaded(["listed"], [{ job_id: "listed" }, { job_id: "cleared" }, { job_id: "cleared" }])).toEqual(["cleared"]);
  });
});
