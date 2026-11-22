import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { hoursForJob, jobDailyReportRows, readJobDailyReports, type DailyReportRaw } from "./daily-reports";
import { DAILY_REPORTS_ANCHOR, JobDailyReports } from "./job-daily-reports";
import { dict } from "@/lib/i18n";

/**
 * THE JOB'S FILE HOLDS ITS DAILY REPORTS (cn-v1174, the owner: "Daily reports should be stored with
 * each job's file"). The Time tab lists the reports whose daily_reports.job_id is this job (0411),
 * newest first; drawn only with the Daily Reports switch on and a report naming the job; a failed
 * read is said; a database still before 0411 never takes the page down.
 */
const JOB = "job-900";
const OTHER = "job-901";
const en = dict("en");
const es = dict("es");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const raw = (over: Partial<DailyReportRaw>): DailyReportRaw => ({
  id: "r1",
  report_date: "2026-11-18",
  did_today: "Roughed in the kitchen circuits.",
  materials_tomorrow: "Two boxes of 12/2.",
  gps_summary: { jobs: [{ job_id: JOB, hours: 5.5 }, { job_id: OTHER, hours: 2 }] },
  status: "filed",
  created_at: "2026-11-18T23:00:00Z",
  profiles: { full_name: "Sam Tillery" },
  ...over,
});

describe("the pure row builder", () => {
  it("takes THIS job's hours out of a report whose summary names two jobs", () => {
    expect(hoursForJob(raw({}).gps_summary, JOB)).toBe(5.5);
    expect(hoursForJob(raw({}).gps_summary, OTHER)).toBe(2);
  });

  it("a summary that does not name the job gives no hours (never a guess)", () => {
    expect(hoursForJob({ jobs: [{ job_id: OTHER, hours: 3 }] }, JOB)).toBeNull();
    expect(hoursForJob(null, JOB)).toBeNull();
  });

  it("newest day first, the two fields only when they have words, Reviewed from the status", () => {
    const rows = jobDailyReportRows(
      [
        raw({ id: "old", report_date: "2026-11-10", status: "reviewed", materials_tomorrow: "  " }),
        raw({ id: "new", report_date: "2026-11-19", did_today: null, profiles: null }),
      ],
      JOB,
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows[0]).toMatchObject({ didToday: null, who: null, reviewed: false, hours: 5.5 });
    expect(rows[1]).toMatchObject({ materialsTomorrow: null, reviewed: true });
  });
});

describe("the read: by job_id, tolerant of the column being absent", () => {
  /** A stand-in client: records the filter and answers with what it is given. */
  const client = (answer: { data: unknown; error: unknown }) => {
    const calls: { eq?: [string, string]; select?: string } = {};
    const q: any = {
      select: (s: string) => ((calls.select = s), q),
      eq: (c: string, v: string) => ((calls.eq = [c, v]), q),
      order: () => q,
      limit: () => Promise.resolve(answer),
    };
    return { sb: { from: (t: string) => (t === "daily_reports" ? q : null) }, calls };
  };

  it("reads daily_reports where job_id is this job", async () => {
    const { sb, calls } = client({ data: [raw({})], error: null });
    const out = await readJobDailyReports(sb, JOB);
    expect(calls.eq).toEqual(["job_id", JOB]);
    expect(out).toMatchObject({ state: "ok", rows: [{ id: "r1", hours: 5.5 }] });
  });

  it("a database before 0411 (42703, the column is not there) reads as absent, never a page down", async () => {
    const { sb } = client({ data: null, error: { code: "42703", message: "column daily_reports.job_id does not exist" } });
    await expect(readJobDailyReports(sb, JOB)).resolves.toEqual({ state: "absent" });
  });

  it("any other failure is said: failed, never an empty list", async () => {
    const { sb } = client({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    await expect(readJobDailyReports(sb, JOB)).resolves.toEqual({ state: "failed" });
  });
});

describe("the section, both languages", () => {
  const read = { state: "ok" as const, rows: jobDailyReportRows([raw({}), raw({ id: "r0", report_date: "2026-11-17", status: "reviewed" })], JOB) };
  const enHtml = renderToStaticMarkup(createElement(JobDailyReports, { read, lang: null }));
  const esHtml = renderToStaticMarkup(createElement(JobDailyReports, { read, lang: "es" }));

  it("carries the anchor other screens link to", () => {
    expect(DAILY_REPORTS_ANCHOR).toBe("daily-reports");
    expect(enHtml).toContain('id="daily-reports"');
  });

  it("English: heading, who, this job's hours, the two fields, Reviewed and Waiting for review", () => {
    const s = text(enHtml);
    expect(s).toContain(en.jb_dailyReports);
    expect(s).toContain("Sam Tillery");
    expect(s).toContain("5h 30m on this job");
    expect(s).toContain(`${en.jb_drWhatGotDone} Roughed in the kitchen circuits.`);
    expect(s).toContain(`${en.jb_drMaterialsTomorrow} Two boxes of 12/2.`);
    expect(s).toContain(en.jb_drWaiting);
    expect(s).toContain(en.jb_drReviewed);
  });

  it("Spanish: the same section in the catalog's words", () => {
    const s = text(esHtml);
    expect(s).toContain("Reportes Diarios");
    expect(s).toContain("5h 30m en este trabajo");
    expect(s).toContain(es.jb_drWhatGotDone);
    expect(s).toContain(es.jb_drWaiting);
    expect(s).toContain(es.jb_drReviewed);
    expect(s).not.toContain("on this job");
  });

  it("no heading over nothing: no rows, absent, or switch off (null) draw nothing", () => {
    expect(renderToStaticMarkup(createElement(JobDailyReports, { read: { state: "ok", rows: [] }, lang: null }))).toBe("");
    expect(renderToStaticMarkup(createElement(JobDailyReports, { read: { state: "absent" }, lang: null }))).toBe("");
    expect(renderToStaticMarkup(createElement(JobDailyReports, { read: null, lang: null }))).toBe("");
  });

  it("a failed read is said in the section's place, in the reader's language", () => {
    const enF = text(renderToStaticMarkup(createElement(JobDailyReports, { read: { state: "failed" }, lang: null })));
    const esF = text(renderToStaticMarkup(createElement(JobDailyReports, { read: { state: "failed" }, lang: "es" })));
    expect(enF).toContain(en.jb_drReadFailed);
    expect(esF).toContain(es.jb_drReadFailed);
  });
});

describe("the page's wiring (source pins)", () => {
  const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
  const lib = readFileSync(join(__dirname, "daily-reports.ts"), "utf8");

  it("reads only while the Daily Reports switch is on", () => {
    expect(page).toMatch(/on\("daily_reports"\) \? readJobDailyReports\(supabase, j\.id\) : Promise\.resolve\(null\)/);
  });

  it("filters by daily_reports.job_id (0411), through the house's tolerateMissingColumns", () => {
    expect(lib).toContain('.eq("job_id", jobId)');
    expect(lib).toContain("tolerateMissingColumns");
  });

  it("the section sits on the Time tab, under the shifts", () => {
    const time = page.slice(page.indexOf('id: "time"'), page.indexOf('id: "appointments"'));
    expect(time).toContain("<JobDailyReports read={jobDailyReports} lang={lang} />");
    expect(time.indexOf("jb_noTimeEntriesYet")).toBeLessThan(time.indexOf("<JobDailyReports"));
  });
});
