import { describe, it, expect } from "vitest";
import {
  OPEN_ENTRY_STALE_HOURS,
  daysAgoStr,
  detectNeedsReturn,
  detectStrayTime,
  detectUnbilledWork,
  rollupWorkedJobs,
} from "@/lib/action-items/leak-detectors";

// The Apache Ct scenario, pinned: an open 26-hour entry attached to no job, a worked
// job with zero costs (30' of Romex nobody recorded), and no return visit scheduled.

const TODAY = "2026-07-01";
const NOW = Date.parse("2026-07-01T15:00:00Z");

describe("detectStrayTime — the forgotten clock and the job-less hours", () => {
  it("flags an open entry from a past day (the 26-hour Apache Ct clock)", () => {
    const rows = [{ id: "e1", status: "open", clock_in: "2026-06-30T13:00:00Z", profiles: { full_name: "Brian Smith" } }];
    const out = detectStrayTime(rows, TODAY, NOW);
    expect(out).toEqual([{ entryId: "e1", name: "Brian", openStill: true, when: "2026-06-30T13:00:00Z" }]);
  });
  it("hour rule catches an evening start the UTC date-cut misses", () => {
    // Opened 6pm PT June 30 = 01:00 UTC July 1 → same UTC day as "today", but
    // it's been open past the stale threshold by now.
    const clockIn = new Date(NOW - (OPEN_ENTRY_STALE_HOURS + 1) * 3_600_000).toISOString();
    const out = detectStrayTime([{ id: "e2", status: "open", clock_in: clockIn }], TODAY, NOW);
    expect(out.map((f) => f.entryId)).toEqual(["e2"]);
    expect(out[0].name).toBe("Someone");
  });
  it("never flags a normal same-day shift", () => {
    const out = detectStrayTime([{ id: "e3", status: "open", clock_in: "2026-07-01T14:00:00Z" }], TODAY, NOW);
    expect(out).toEqual([]);
  });
  it("flags a past-day close with no job, but not one attached via split allocations", () => {
    const rows = [
      { id: "e4", status: "closed", job_id: null, clock_in: "2026-06-30T13:00:00Z", clock_out: "2026-06-30T21:00:00Z", profiles: { full_name: "Brian" } },
      { id: "e5", status: "closed", job_id: null, clock_in: "2026-06-30T13:00:00Z", clock_out: "2026-06-30T21:00:00Z", time_allocations: [{ job_id: "J1" }] },
    ];
    expect(detectStrayTime(rows, TODAY, NOW).map((f) => f.entryId)).toEqual(["e4"]);
  });
  it("leaves TODAY's no-job closes alone (the EOD form may still attach them) and dedupes overlapping feeds", () => {
    const today = { id: "e6", status: "closed", job_id: null, clock_out: "2026-07-01T01:00:00Z" };
    const open = { id: "e1", status: "open", clock_in: "2026-06-30T13:00:00Z" };
    expect(detectStrayTime([today], TODAY, NOW)).toEqual([]);
    expect(detectStrayTime([open, open], TODAY, NOW)).toHaveLength(1);
  });
});

describe("rollupWorkedJobs — entries → the jobs they touched", () => {
  it("collects the entry's job AND split-allocation jobs, tracks last-worked/open/2-day window", () => {
    const rows = [
      { id: "e1", status: "closed", job_id: "A", clock_in: `${daysAgoStr(TODAY, 3)}T15:00:00Z`, time_allocations: [{ job_id: "B" }] },
      { id: "e2", status: "open", job_id: "A", clock_in: "2026-07-01T14:00:00Z" },
    ];
    const m = rollupWorkedJobs(rows, TODAY);
    expect([...m.keys()].sort()).toEqual(["A", "B"]);
    expect(m.get("A")).toMatchObject({ hasOpenEntry: true, workedInUnbilledWindow: true, lastWorked: "2026-07-01T14:00:00Z" });
    expect(m.get("B")).toMatchObject({ hasOpenEntry: false, workedInUnbilledWindow: false });
  });
});

describe("detectUnbilledWork — the 30'-of-Romex leak", () => {
  const job = { id: "A", name: "Apache Ct", status: "in_progress" };
  const worked = new Map([["A", { lastWorked: "2026-06-30T15:00:00Z", hasOpenEntry: false, workedInUnbilledWindow: true }]]);
  it("flags a worked job with zero costs/POs/materials", () => {
    const out = detectUnbilledWork({ jobs: [job], worked, costedJobIds: new Set(), invoicedJobIds: new Set() });
    expect(out.map((f) => f.job.id)).toEqual(["A"]);
  });
  it("stays quiet once ANY cost signal exists", () => {
    const out = detectUnbilledWork({ jobs: [job], worked, costedJobIds: new Set(["A"]), invoicedJobIds: new Set() });
    expect(out).toEqual([]);
  });
  it("skips a done-not-invoiced job (the billing board already carries it)", () => {
    const done = { ...job, status: "complete" };
    expect(detectUnbilledWork({ jobs: [done], worked, costedJobIds: new Set(), invoicedJobIds: new Set() })).toEqual([]);
    // …but a complete job WITH an invoice (not on that board) still flags its missing costs.
    expect(
      detectUnbilledWork({ jobs: [done], worked, costedJobIds: new Set(), invoicedJobIds: new Set(["A"]) }).map((f) => f.job.id),
    ).toEqual(["A"]);
  });
  it("respects the 2-day window (older work isn't re-flagged)", () => {
    const stale = new Map([["A", { lastWorked: "2026-06-28T15:00:00Z", hasOpenEntry: false, workedInUnbilledWindow: false }]]);
    expect(detectUnbilledWork({ jobs: [job], worked: stale, costedJobIds: new Set(), invoicedJobIds: new Set() })).toEqual([]);
  });
});

describe("detectNeedsReturn — the forgotten return visit", () => {
  const worked = new Map([["A", { lastWorked: "2026-06-30T15:00:00Z", hasOpenEntry: false, workedInUnbilledWindow: true }]]);
  const base = { id: "A", name: "Apache Ct", status: "in_progress", scheduled_start: null };
  const none = { futureApptJobIds: new Set<string>(), futureSegmentJobIds: new Set<string>() };
  it("flags an in-flight worked job with nothing on the calendar", () => {
    expect(detectNeedsReturn({ jobs: [base], worked, todayStr: TODAY, ...none }).map((f) => f.job.id)).toEqual(["A"]);
  });
  it("stays quiet when ANY future signal exists — start date, appointment, or segment", () => {
    const dated = { ...base, scheduled_start: "2026-07-03T08:00:00Z" };
    expect(detectNeedsReturn({ jobs: [dated], worked, todayStr: TODAY, ...none })).toEqual([]);
    expect(
      detectNeedsReturn({ jobs: [base], worked, todayStr: TODAY, futureApptJobIds: new Set(["A"]), futureSegmentJobIds: new Set() }),
    ).toEqual([]);
    expect(
      detectNeedsReturn({ jobs: [base], worked, todayStr: TODAY, futureApptJobIds: new Set(), futureSegmentJobIds: new Set(["A"]) }),
    ).toEqual([]);
  });
  it("a PAST scheduled_start is not a future visit", () => {
    const past = { ...base, scheduled_start: "2026-06-29T08:00:00Z" };
    expect(detectNeedsReturn({ jobs: [past], worked, todayStr: TODAY, ...none }).map((f) => f.job.id)).toEqual(["A"]);
  });
  it("suppresses finished jobs, live clock-ins, and jobs already listed as to-schedule", () => {
    const complete = { ...base, status: "complete" };
    expect(detectNeedsReturn({ jobs: [complete], worked, todayStr: TODAY, ...none })).toEqual([]);
    const live = new Map([["A", { lastWorked: "2026-07-01T14:00:00Z", hasOpenEntry: true, workedInUnbilledWindow: true }]]);
    expect(detectNeedsReturn({ jobs: [base], worked: live, todayStr: TODAY, ...none })).toEqual([]);
    const toSchedule = { ...base, status: "estimate" }; // undated estimate = job_to_schedule item
    expect(detectNeedsReturn({ jobs: [toSchedule], worked, todayStr: TODAY, ...none })).toEqual([]);
  });
});
