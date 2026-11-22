import { describe, it, expect, vi, beforeEach } from "vitest";
import { dict } from "@/lib/i18n";

/**
 * ONE REPORT, ONE JOB (cn-v1174, migration 0411), at the server: fileDailyReport takes the job,
 * checks it on the caller's own session (another company's job reads nothing and is refused in one
 * sentence, nothing written), upserts on (org, person, day, job), and answers a database without
 * 0411 with one plain sentence. dailyReportJobChoices reads the one rule: one job named by the day's
 * closed punches is decided; none or more than one is asked, the day's jobs first. Stand-in client.
 */
const JOB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THEIRS = "33333333-3333-4333-8333-333333333333";

type Upsert = { row: Record<string, unknown>; opts: Record<string, unknown> };
let upserts: Upsert[] = [];
let upsertError: unknown = null;
let punches: { job_id: string | null; clock_out: string | null; status: string }[] = [];
/** The jobs the caller's company can see (RLS, as the stand-in plays it). */
const visible = new Map<string, Record<string, unknown>>([
  [JOB, { id: JOB, name: "Larkspur panel", job_number: "J-900", status: "in_progress", customers: { name: "Sam Tillery" } }],
  [OTHER, { id: OTHER, name: "Snowbell remodel", job_number: "J-901", status: "in_progress", customers: { name: "Dana Rook" } }],
]);

const client = {
  auth: { getUser: async () => ({ data: { user: { id: "lead-1" } } }) },
  from: (table: string) => {
    const f: Record<string, unknown> = {};
    const b: any = {
      select: () => b,
      eq: (col: string, v: unknown) => ((f[col] = v), b),
      in: (col: string, v: unknown) => ((f[`in:${col}`] = v), b),
      gte: () => b,
      lt: () => b,
      order: () => b,
      limit: () => b,
      upsert: (row: Record<string, unknown>, opts: Record<string, unknown>) => (upserts.push({ row, opts }), (f.upsert = true), b),
      maybeSingle: async () => {
        if (table === "profiles") return { data: { org_id: "org-1", full_name: "Theo Vance", language: "en" }, error: null };
        if (table === "organizations") return { data: { settings: {} }, error: null };
        if (table === "jobs") return { data: visible.get(String(f.id)) ? { id: f.id } : null, error: null };
        if (table === "daily_reports") return f.upsert && upsertError ? { data: null, error: upsertError } : { data: { id: "r-1" }, error: null };
        return { data: null, error: null };
      },
      then: (ok: any, err?: any) => {
        let data: unknown[] = [];
        if (table === "time_entries") data = punches.map((p) => ({ ...p, clock_in: "2026-11-21T15:00:00Z", lunch_minutes: 0, miles: 0, id: "e" }));
        if (table === "jobs" && f["in:id"]) data = (f["in:id"] as string[]).map((id) => visible.get(id)).filter(Boolean) as unknown[];
        else if (table === "jobs") data = [...visible.values()];
        return Promise.resolve({ data, error: null }).then(ok, err);
      },
    };
    return b;
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, createServiceClient: () => client }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => undefined), notifyPeople: async () => ({ bell: true, pushed: [] }) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => undefined), orgStaffIds: async () => ["owner-1"] }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const { fileDailyReport, dailyReportJobChoices } = await import("./actions");
const en = dict("en");

beforeEach(() => {
  upserts = [];
  upsertError = null;
  punches = [];
});

describe("fileDailyReport: one report, one job", () => {
  it("a job the company can see: upserted on the four-column key with its job", async () => {
    const r = await fileDailyReport({ did_today: "Hung the panel", materials_tomorrow: "", job_id: JOB });
    expect(r.ok).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].row).toMatchObject({ job_id: JOB, profile_id: "lead-1", status: "filed", did_today: "Hung the panel" });
    expect(upserts[0].opts).toEqual({ onConflict: "org_id,profile_id,report_date,job_id" });
  });

  it("no job: filed with job_id null (in no job's file), on the same key", async () => {
    const r = await fileDailyReport({ did_today: "Shop day", materials_tomorrow: "" });
    expect(r.ok).toBe(true);
    expect(upserts[0].row.job_id).toBeNull();
    expect(upserts[0].opts).toEqual({ onConflict: "org_id,profile_id,report_date,job_id" });
  });

  it("another company's job reads nothing: refused in one sentence, nothing written", async () => {
    const r = await fileDailyReport({ did_today: "Hung the panel", materials_tomorrow: "", job_id: THEIRS });
    expect(r).toEqual({ ok: false, error: en.cs_reportJobNotYours });
    expect(upserts).toEqual([]);
  });

  it("a job id that is not an id is refused the same way, and never sent to the database", async () => {
    const r = await fileDailyReport({ did_today: "x", materials_tomorrow: "", job_id: "J-900" });
    expect(r).toEqual({ ok: false, error: en.cs_reportJobNotYours });
    expect(upserts).toEqual([]);
  });

  it.each([
    ["the key is not there yet", { code: "42P10", message: "there is no unique or exclusion constraint matching the ON CONFLICT specification" }],
    ["the column is not there yet", { code: "PGRST204", message: "Could not find the 'job_id' column of 'daily_reports' in the schema cache" }],
  ])("code ahead of 0411 (%s): one plain sentence, never the database's", async (_n, err) => {
    upsertError = err;
    const r = await fileDailyReport({ did_today: "Hung the panel", materials_tomorrow: "", job_id: JOB });
    expect(r).toEqual({ ok: false, error: en.cs_reportNotReadyYet });
  });
});

describe("dailyReportJobChoices: the one rule, read at the sheet", () => {
  it("the day's closed punches name one job: decided, and offered first", async () => {
    punches = [{ job_id: JOB, clock_out: "2026-11-21T23:00:00Z", status: "closed" }];
    const r = await dailyReportJobChoices();
    expect(r.ok && r.decided).toEqual({ id: JOB, label: "Larkspur panel" });
    expect(r.ok && r.dayJobs.map((j) => j.id)).toEqual([JOB]);
    expect(r.ok && r.otherJobs.map((j) => j.id)).toEqual([OTHER]);
  });

  it("split across two jobs: asked, both of the day's jobs first, nothing else twice", async () => {
    punches = [
      { job_id: OTHER, clock_out: "2026-11-21T18:00:00Z", status: "closed" },
      { job_id: JOB, clock_out: "2026-11-21T23:00:00Z", status: "closed" },
    ];
    const r = await dailyReportJobChoices();
    expect(r.ok && r.decided).toBeNull();
    expect(r.ok && r.dayJobs.map((j) => j.id)).toEqual([OTHER, JOB]);
    expect(r.ok && r.otherJobs).toEqual([]);
  });

  it("no job on the day's punches: asked, the jobs still being worked offered", async () => {
    punches = [{ job_id: null, clock_out: "2026-11-21T23:00:00Z", status: "closed" }];
    const r = await dailyReportJobChoices();
    expect(r.ok && r.decided).toBeNull();
    expect(r.ok && r.dayJobs).toEqual([]);
    expect(r.ok && r.otherJobs.map((j) => j.id)).toEqual([JOB, OTHER]);
  });
});
