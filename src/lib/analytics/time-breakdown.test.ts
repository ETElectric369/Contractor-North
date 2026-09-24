import { describe, it, expect } from "vitest";
import { computeHoursBreakdown } from "@/lib/analytics/time-breakdown";

describe("computeHoursBreakdown — hours by job + cost code", () => {
  const labels = new Map([["JA", "J-1 — Panel"], ["JB", "J-2 — Service"]]);

  it("a split shift is two entries: each piece lands on its own job + code (0288)", () => {
    const entries = [
      // one 8h day cut at 11:00: 3h on JA/rough-in, then 5h on JB/service
      { job_id: "JA", job_code: "rough-in", status: "closed", clock_in: "2026-07-01T08:00:00Z", clock_out: "2026-07-01T11:00:00Z", lunch_minutes: 0 },
      { job_id: "JB", job_code: "service", status: "closed", clock_in: "2026-07-01T11:00:00Z", clock_out: "2026-07-01T16:00:00Z", lunch_minutes: 0 },
      // an ordinary 8h closed entry on JA, code finish
      { job_id: "JA", job_code: "finish", status: "closed", clock_in: "2026-07-02T08:00:00Z", clock_out: "2026-07-02T16:00:00Z", lunch_minutes: 0 },
    ];
    const out = computeHoursBreakdown(entries, 0, 30, labels);
    expect(out.totalHours).toBe(16);
    expect(out.byJob).toEqual([{ label: "J-1 — Panel", hours: 11 }, { label: "J-2 — Service", hours: 5 }]);
    expect(out.byCode).toEqual([{ label: "finish", hours: 8 }, { label: "service", hours: 5 }, { label: "rough-in", hours: 3 }]);
  });

  it("excludes entries clocked in before the window", () => {
    const NOW = Date.UTC(2026, 6, 15);
    const entries = [
      { job_id: "JA", job_code: "x", status: "closed", clock_in: "2020-01-01T08:00:00Z", clock_out: "2020-01-01T16:00:00Z", lunch_minutes: 0 },
    ];
    const out = computeHoursBreakdown(entries, NOW, 30, labels);
    expect(out.totalHours).toBe(0);
    expect(out.byJob).toEqual([]);
  });

  it("un-coded / job-less hours fall under readable buckets", () => {
    const out = computeHoursBreakdown(
      [{ job_id: null, job_code: null, status: "closed", clock_in: "2026-07-01T08:00:00Z", clock_out: "2026-07-01T12:00:00Z", lunch_minutes: 0 }],
      0,
      30,
      labels,
    );
    expect(out.byJob).toEqual([{ label: "(no job)", hours: 4 }]);
    expect(out.byCode).toEqual([{ label: "Uncoded", hours: 4 }]);
  });
});
