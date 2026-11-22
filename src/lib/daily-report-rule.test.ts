import { describe, it, expect } from "vitest";
import { ALL_ON, normalizeFeatures } from "@/lib/features";
import { asksForDailyReport, dailyReportJobHref, dayJobIds, isReportKeyMissing, reportJobFor, reportJobName, reportLanding } from "./daily-report-rule";

const OUT = "2026-11-21T23:00:00Z";
const J1 = "11111111-1111-4111-8111-111111111111";
const J2 = "22222222-2222-4222-8222-222222222222";

describe("daily-report-rule: who is asked", () => {
  const off = normalizeFeatures({ daily_reports: false });
  const payrollOff = normalizeFeatures({ crew_payroll: false });
  it.each([
    ["a crew lead, switch on", true, ALL_ON, true],
    ["a crew lead, no stored map (everything on)", true, null, true],
    ["a crew lead, Daily Reports off", true, off, false],
    ["a crew lead, its parent Crew & Payroll off", true, payrollOff, false],
    ["not a crew lead", false, ALL_ON, false],
    ["crew_lead unread (null)", null, ALL_ON, false],
    ["crew_lead a truthy non-boolean", "yes", ALL_ON, false],
  ])("%s", (_name, lead, features, want) => {
    expect(asksForDailyReport(lead, features as never)).toBe(want);
  });
});

describe("daily-report-rule: which job the report is for", () => {
  it.each([
    ["no punches at all: ask, nothing first", [], { kind: "ask", dayJobIds: [] }],
    ["one closed punch on one job: that job", [{ job_id: J1, clock_out: OUT }], { kind: "job", jobId: J1 }],
    ["two closed punches, same job: that job", [{ job_id: J1, clock_out: OUT }, { job_id: J1, clock_out: OUT }], { kind: "job", jobId: J1 }],
    ["one job and a no-job punch: the one job the day names", [{ job_id: null, clock_out: OUT }, { job_id: J1, clock_out: OUT }], { kind: "job", jobId: J1 }],
    ["only no-job punches: ask", [{ job_id: null, clock_out: OUT }], { kind: "ask", dayJobIds: [] }],
    ["split across two jobs: ask, both first", [{ job_id: J1, clock_out: OUT }, { job_id: J2, clock_out: OUT }], { kind: "ask", dayJobIds: [J1, J2] }],
    ["an open punch does not count", [{ job_id: J2, clock_out: null, status: "open" }, { job_id: J1, clock_out: OUT }], { kind: "job", jobId: J1 }],
    ["only an open punch: ask", [{ job_id: J1, clock_out: null }], { kind: "ask", dayJobIds: [] }],
  ])("%s", (_name, punches, want) => {
    expect(reportJobFor(punches as never)).toEqual(want);
  });

  it("names the day's jobs once each, in the order first seen", () => {
    expect(dayJobIds([{ job_id: J2, clock_out: OUT }, { job_id: J1, clock_out: OUT }, { job_id: J2, clock_out: OUT }])).toEqual([J2, J1]);
    expect(dayJobIds(null)).toEqual([]);
  });
});

describe("daily-report-rule: where the bell's link lands for a report not on the card", () => {
  it.each([
    ["a report with a job: its job's Time tab", { job_id: J1 }, { kind: "job", href: `/jobs/${J1}?tab=time#daily-reports` }],
    ["a report with no job: drawn on the card", { job_id: null }, { kind: "draw" }],
    ["a report read before 0411 (no column): drawn on the card", {}, { kind: "draw" }],
    ["no report the reader can read: My Day", null, { kind: "none" }],
  ])("%s", (_name, report, want) => {
    expect(reportLanding(report as never, true)).toEqual(want);
  });

  it("with the Daily Reports switch off the job page draws no reports, so a report with a job is drawn on the card", () => {
    expect(reportLanding({ job_id: J1 }, false)).toEqual({ kind: "draw" });
    expect(reportLanding({ job_id: null }, false)).toEqual({ kind: "draw" });
    expect(reportLanding(null, false)).toEqual({ kind: "none" });
  });

  it("the job's address is the job page's ?tab= and the section's anchor", () => {
    expect(dailyReportJobHref("J")).toBe("/jobs/J?tab=time#daily-reports");
  });
});

describe("daily-report-rule: a write ahead of 0411", () => {
  it.each([
    ["no matching ON CONFLICT key", { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" }, true],
    ["undefined column", { code: "42703", message: 'column "job_id" of relation "daily_reports" does not exist' }, true],
    ["PostgREST's schema cache", { code: "PGRST204", message: "Could not find the 'job_id' column of 'daily_reports' in the schema cache" }, true],
    ["an RLS refusal is a real failure", { code: "42501", message: "new row violates row-level security policy" }, false],
    ["a timeout is a real failure", { code: "57014", message: "canceling statement due to statement timeout" }, false],
    ["nothing", null, false],
  ])("%s", (_name, err, want) => {
    expect(isReportKeyMissing(err)).toBe(want);
  });
});

describe("daily-report-rule: a waiting report's row names its job (two may wait for one day)", () => {
  const summary = { jobs: [{ job_id: J1, label: "Larkspur Panel", hours: 4 }, { job_id: null, label: "No job set", hours: 1 }] };
  it.each([
    ["the frozen summary names that job: its name then", { job_id: J1, gps_summary: summary }, { name: "Larkspur Rewire", job_number: "J-900" }, "Larkspur Panel"],
    ["the summary does not name it: the job's own name", { job_id: J2, gps_summary: summary }, { name: "Snowbell Deck", job_number: "J-901" }, "Snowbell Deck"],
    ["the job has no name: its number", { job_id: J2, gps_summary: null }, { name: " ", job_number: "J-901" }, "J-901"],
    ["a summary whose jobs is not a list: the job's own name", { job_id: J2, gps_summary: { jobs: "x" as never } }, { name: "Snowbell Deck" }, "Snowbell Deck"],
    ["neither says it: nothing extra", { job_id: J2, gps_summary: summary }, null, null],
    ["a report with no job: nothing extra", { job_id: null, gps_summary: summary }, { name: "Snowbell Deck" }, null],
    ["read before 0411 (no column): nothing extra", { gps_summary: summary }, undefined, null],
  ])("%s", (_name, report, job, want) => {
    expect(reportJobName(report as never, job as never)).toBe(want);
  });

  it("My Day reads job_id tolerantly and draws the name on each row", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const page = readFileSync(join(process.cwd(), "src/app/(app)/planner/page.tsx"), "utf8");
    expect(page).toContain("await waiting(`${REPORT_COLS}, created_at, job_id, report_job:job_id(name, job_number)`);");
    expect(page).toContain("return first.error && isMissingColumn(first.error) ? waiting(`${REPORT_COLS}, created_at`) : first;");
    expect(page).toContain("jobName: reportJobName(r, Array.isArray(r.report_job) ? r.report_job[0] : r.report_job),");
    expect((page.match(/\{r\.jobName && <span className="ml-2 text-slate-500">· \{r\.jobName\}<\/span>\}/g) ?? []).length).toBe(2);
  });
});
