import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CARRIED FROM audit v1120 (fix wave cn-v1123), the timeclock actions: two findings, each pinned on a
 * small in-memory database so the deeds are proven, not the wording.
 *
 *   15  Taking back a punch deletes the row but leaves the job promoted and off hold
 *   41  Reviewing one daily report marks every unread Bell row from that person read
 *
 * The fake below keeps rows, applies the filters it is given, reads rows back from writes, and plays
 * the one database rule these findings turn on (jobs_hold_day, 0366: a job that is not on hold has no
 * hold reason, day or holder). It refuses nothing it was not told about: an unknown table reads empty.
 */

type Row = Record<string, any>;
type Call = { table: string; verb: string; payload?: any; filters: any[][] };

const SERVICE_KEY = "test-service-key-1123";
const state = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  calls: [] as { table: string; verb: string; payload?: any; filters: any[][] }[],
  userId: "user-1",
  staff: true,
  fail: null as null | ((c: { table: string; verb: string; payload?: any }) => { message: string } | null),
  client: null as any,
  n: 0,
}));
const spies = vi.hoisted(() => ({ reported: [] as any[][], notified: [] as any[][], pushed: [] as any[][] }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => (state.staff ? { supabase: state.client, userId: state.userId, orgId: "org-1" } : { error: "This action is staff-only." })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn((...a: any[]) => void spies.reported.push(a)) }));
vi.mock("@/lib/notifications", () => ({
  createNotifications: vi.fn(async (...a: any[]) => void spies.notified.push(a)),
  notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })),
}));
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: vi.fn(async (...a: any[]) => void spies.pushed.push(a)),
  orgStaffIds: vi.fn(async () => ["owner-1", "lead-1"]),
}));
vi.mock("@/app/(app)/schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { clockIn, clockOut, fileDailyReport, markDailyReportReviewed } from "@/app/(app)/timeclock/actions";
import { UNDO_PUNCH_SENTENCE } from "@/lib/long-shift";
import { withoutHeldCrumb } from "@/lib/held-crumb";

// ── the fake database ────────────────────────────────────────────────────────────────────────────

function fakeClient() {
  const nextId = () => `e0000000-0000-4000-8000-${String(++state.n).padStart(12, "0")}`;
  return {
    auth: { getUser: async () => ({ data: { user: { id: state.userId } } }) },
    from(table: string) {
      const rows = () => (state.db[table] ??= []);
      const q: Call = { table, verb: "select", filters: [] };
      const tests: ((r: Row) => boolean)[] = [];
      let limit = Infinity;
      let returning = false;
      // A database hands back COPIES: a row read before a write must not change under the reader.
      const copy = <T,>(x: T): T => (x == null ? x : structuredClone(x));
      const run = (single: boolean) => {
        const { data, error } = go(single);
        return { data: copy(data), error };
      };
      const go = (single: boolean): { data: any; error: any } => {
        state.calls.push(q);
        const injected = state.fail?.({ table, verb: q.verb, payload: q.payload });
        if (injected) return { data: null, error: injected };
        const hit = rows().filter((r) => tests.every((t) => t(r)));
        if (q.verb === "select") {
          const out = hit.slice(0, limit);
          return { data: single ? (out[0] ?? null) : out, error: null };
        }
        if (q.verb === "insert") {
          const row = { id: nextId(), org_id: "org-1", ...q.payload };
          rows().push(row);
          return { data: returning ? (single ? row : [row]) : null, error: null };
        }
        if (q.verb === "upsert") {
          const p = q.payload;
          const same = rows().find((r) => r.org_id === p.org_id && r.profile_id === p.profile_id && r.report_date === p.report_date);
          const row = same ? Object.assign(same, p) : { id: nextId(), ...p };
          if (!same) rows().push(row);
          return { data: returning ? (single ? row : [row]) : null, error: null };
        }
        if (q.verb === "update") {
          for (const r of hit) {
            Object.assign(r, q.payload);
            // jobs_hold_day (0366): not on hold, nothing of a hold stays behind; entering hold, a day by default.
            if (table === "jobs") {
              if (r.status !== "on_hold") Object.assign(r, { hold_reason: null, hold_until: null, hold_by: null });
              else if (r.hold_until == null) r.hold_until = "2099-01-08";
            }
          }
          return { data: returning ? (single ? (hit[0] ?? null) : hit) : null, error: null };
        }
        state.db[table] = rows().filter((r) => !hit.includes(r));
        return { data: returning ? (single ? (hit[0] ?? null) : hit) : null, error: null };
      };
      const chain: any = {
        select() { if (q.verb !== "select") returning = true; return chain; },
        insert(p: any) { q.verb = "insert"; q.payload = p; return chain; },
        upsert(p: any) { q.verb = "upsert"; q.payload = p; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        delete() { q.verb = "delete"; return chain; },
        order() { return chain; },
        limit(n: number) { limit = n; return chain; },
        maybeSingle: () => Promise.resolve(run(true)),
        single: () => Promise.resolve(run(true)),
        then: (ok: any, bad: any) => Promise.resolve().then(() => run(false)).then(ok, bad),
      };
      const filter = (name: string, test: (r: Row, c: string, v: any) => boolean) => {
        chain[name] = (c: string, v: any) => { q.filters.push([name, c, v]); tests.push((r) => test(r, c, v)); return chain; };
      };
      filter("eq", (r, c, v) => r[c] === v);
      filter("neq", (r, c, v) => r[c] !== v);
      filter("is", (r, c, v) => (v === null ? r[c] == null : r[c] === v));
      filter("gt", (r, c, v) => String(r[c]) > String(v));
      filter("gte", (r, c, v) => String(r[c]) >= String(v));
      filter("lt", (r, c, v) => String(r[c]) < String(v));
      filter("in", (r, c, v) => (v as any[]).includes(r[c]));
      return chain;
    },
  };
}

const ORG = "org-1";
const SNOWBELL = "a0000000-0000-4000-8000-0000000000a1"; // the job on hold
const BAYBERRY = "a0000000-0000-4000-8000-0000000000a2"; // a plain scheduled job
const OFFICE = "b0000000-0000-4000-8000-0000000000b1"; // who held it

function seed() {
  state.db = {
    profiles: [{ id: "user-1", org_id: ORG, role: "tech", full_name: "Thistlewood Hand" }],
    jobs: [
      { id: SNOWBELL, org_id: ORG, job_number: "J-048", name: "Snowbell Panel Swap", status: "on_hold", hold_reason: "waiting on the permit.", hold_until: "2026-10-24", hold_by: OFFICE },
      { id: BAYBERRY, org_id: ORG, job_number: "J-049", name: "Bayberry Kitchen", status: "scheduled", hold_reason: null, hold_until: null, hold_by: null },
    ],
    time_entries: [],
    organizations: [{ id: ORG, settings: { timezone: "America/Los_Angeles" } }],
  };
  state.calls = [];
  state.userId = "user-1";
  state.staff = true;
  state.fail = null;
  state.n = 0;
  state.client = fakeClient();
  spies.reported.length = 0;
  spies.notified.length = 0;
  spies.pushed.length = 0;
}

const job = (id: string) => state.db.jobs.find((j) => j.id === id)!;
const punches = () => state.db.time_entries;
const jobWrites = () => state.calls.filter((c) => c.table === "jobs" && c.verb === "update");
const takeBack = (entry_id: string, over: Record<string, unknown> = {}) =>
  clockOut({ entry_id, lunch_minutes: 0, notes: "", gps: null, ...over });

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  seed();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
});

// ── 15 ───────────────────────────────────────────────────────────────────────────────────────────

describe("Taking back a punch deletes the row but leaves the job promoted and off hold", () => {
  it("a punch on a held job wakes it and keeps what the wake cleared on the punch itself, sealed", async () => {
    const res = await clockIn({ job_id: SNOWBELL, job_code: null, gps: null });
    expect(res.ok).toBe(true);
    expect(res.warning).toContain("J-048 was on hold (waiting on the permit)");
    // The database rule really did clear it: this is what the take-back used to leave behind.
    expect(job(SNOWBELL)).toMatchObject({ status: "in_progress", hold_reason: null, hold_until: null, hold_by: null });
    const [punch] = punches();
    expect(punch.notes).toMatch(/^\[This punch took the job off hold\. Before: \{.*\} #[0-9a-f]{16}\]$/);
    expect(punch.notes).toContain('"r":"waiting on the permit."');
  });

  it("taking that punch back within two minutes puts the hold back, reason, day and holder, and says so", async () => {
    const { id } = await clockIn({ job_id: SNOWBELL, job_code: null, gps: null });
    const out = await takeBack(id!);
    expect(out.ok).toBe(true);
    expect(out.undone).toBe(true);
    expect(punches()).toEqual([]); // the punch is gone, as before
    expect(job(SNOWBELL)).toMatchObject({ status: "on_hold", hold_reason: "waiting on the permit.", hold_until: "2026-10-24", hold_by: OFFICE });
    expect(out.warning).toBe(`${UNDO_PUNCH_SENTENCE} Snowbell Panel Swap is back on hold (waiting on the permit).`);
  });

  it("the take-back writes the job once, on this job, in this company, only while it is still in progress, and reads the row back", async () => {
    const { id } = await clockIn({ job_id: SNOWBELL, job_code: null, gps: null });
    state.calls = [];
    await takeBack(id!);
    const writes = jobWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].filters).toEqual(expect.arrayContaining([["eq", "id", SNOWBELL], ["eq", "org_id", ORG], ["eq", "status", "in_progress"]]));
    expect(writes[0].payload).toEqual({ status: "on_hold", hold_reason: "waiting on the permit.", hold_until: "2026-10-24", hold_by: OFFICE });
  });

  it("the Clock panel's notes box carries the clock's own line back, and the punch is still only a slip", async () => {
    const { id } = await clockIn({ job_id: SNOWBELL, job_code: null, gps: null });
    const boxed = punches()[0].notes as string;
    const out = await takeBack(id!, { notes: boxed });
    expect(out.undone).toBe(true);
    expect(job(SNOWBELL).status).toBe("on_hold");
  });

  it("a job that was not held writes no line, and its take-back never touches the job", async () => {
    const { id } = await clockIn({ job_id: BAYBERRY, job_code: null, gps: null });
    expect(punches()[0].notes).toBeUndefined();
    state.calls = [];
    const out = await takeBack(id!);
    expect(out).toMatchObject({ ok: true, undone: true, warning: UNDO_PUNCH_SENTENCE });
    expect(jobWrites()).toEqual([]);
  });

  it.each([
    ["a made-up seal", () => "0000000000000000"],
    ["a seal copied from another punch", (json: string) => createHmac("sha256", SERVICE_KEY).update(`some-other-punch|${json}`).digest("hex").slice(0, 16)],
  ])("a line made by hand is not believed (%s): nothing is put on hold", async (_name, sealOf) => {
    seed();
    const { id } = await clockIn({ job_id: BAYBERRY, job_code: null, gps: null });
    const json = JSON.stringify({ j: BAYBERRY, r: "typed by a tech", d: "2026-10-30", b: null });
    punches()[0].notes = `[This punch took the job off hold. Before: ${json} #${sealOf(json)}]`;
    state.calls = [];
    const out = await takeBack(id!);
    expect(out).toMatchObject({ ok: true, undone: true, warning: UNDO_PUNCH_SENTENCE });
    expect(jobWrites()).toEqual([]);
    expect(job(BAYBERRY).status).toBe("in_progress"); // the clock-in promoted it; the forged line did not move it
  });

  it("somebody else on the clock at the job keeps it working: it is not put back on hold under them", async () => {
    const { id } = await clockIn({ job_id: SNOWBELL, job_code: null, gps: null });
    punches().push({ id: "dave-punch", org_id: ORG, profile_id: "dave-1", job_id: SNOWBELL, status: "open", clock_in: new Date().toISOString() });
    state.calls = [];
    const out = await takeBack(id!);
    expect(out).toMatchObject({ undone: true, warning: UNDO_PUNCH_SENTENCE });
    expect(jobWrites()).toEqual([]);
    expect(job(SNOWBELL).status).toBe("in_progress");
  });

  it("a job that has moved since the clock-in is left where it is", async () => {
    const { id } = await clockIn({ job_id: SNOWBELL, job_code: null, gps: null });
    job(SNOWBELL).status = "complete";
    const out = await takeBack(id!);
    expect(out).toMatchObject({ undone: true, warning: UNDO_PUNCH_SENTENCE });
    expect(job(SNOWBELL).status).toBe("complete");
  });

  it("a hold that cannot be put back is said in words and reported, never swallowed", async () => {
    const { id } = await clockIn({ job_id: SNOWBELL, job_code: null, gps: null });
    state.fail = (c) => (c.table === "jobs" && c.verb === "update" ? { message: "boom" } : null);
    const out = await takeBack(id!);
    expect(out.undone).toBe(true);
    expect(out.warning).toBe(`${UNDO_PUNCH_SENTENCE} That job was on hold before this punch and I couldn't put it back. Set it on hold again from the job.`);
    expect(spies.reported.some((a) => a[0] === "timeclock.clockOut.undoHold")).toBe(true);
  });

  it("a punch somebody wrote a note on is a day, not a slip: it is not taken back, and the job stays awake", async () => {
    const { id } = await clockIn({ job_id: SNOWBELL, job_code: null, gps: null });
    const out = await takeBack(id!, { notes: "Pulled the old panel" });
    expect(out.undone).toBeFalsy();
    expect(job(SNOWBELL).status).not.toBe("on_hold");
  });

  it("a punch that ran a normal shift closes WITHOUT the clock's line, and the end-of-day reminder does not count it as a note", async () => {
    const { id } = await clockIn({ job_id: SNOWBELL, job_code: null, gps: null });
    punches()[0].clock_in = new Date(Date.now() - 3 * 3600_000).toISOString(); // a day's work, not a slip
    expect(punches()[0].notes).toContain("This punch took the job off hold");
    const out = await takeBack(id!);
    expect(out.ok).toBe(true);
    expect(out.undone).toBeFalsy();
    expect(punches()[0].status).toBe("closed");
    expect(punches()[0].notes ?? null).toBeNull();
    expect(withoutHeldCrumb(`[This punch took the job off hold. Before: {} #0123456789abcdef]`)).toBe("");
    expect(withoutHeldCrumb(`Pulled the old panel\n[This punch took the job off hold. Before: {"j":"x"} #0123456789abcdef]`)).toBe("Pulled the old panel");
  });

  it("with no key to seal with, the clock-in writes no line and says so to the ops log (today's behaviour, no guess)", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { id } = await clockIn({ job_id: SNOWBELL, job_code: null, gps: null });
    expect(punches()[0].notes).toBeUndefined();
    expect(spies.reported.some((a) => a[0] === "timeclock.clockIn.heldNote")).toBe(true);
    const out = await takeBack(id!);
    expect(out).toMatchObject({ undone: true, warning: UNDO_PUNCH_SENTENCE });
  });
});

// ── 41 ───────────────────────────────────────────────────────────────────────────────────────────

const LEAD = "c0000000-0000-4000-8000-0000000000c1";
const MONDAY = "d0000000-0000-4000-8000-0000000000d1";
const TUESDAY = "d0000000-0000-4000-8000-0000000000d2";
const bell = (id: string) => state.db.notifications.find((n) => n.id === id)!;

function seedReports(over: { tuesdayStatus?: string; mondayStatus?: string; leadName?: string | null } = {}) {
  state.userId = "owner-1";
  state.db.profiles = [
    { id: "owner-1", org_id: ORG, role: "owner", full_name: "Snowbell Owner" },
    { id: LEAD, org_id: ORG, role: "tech", full_name: over.leadName === undefined ? "Larkspur Lead" : over.leadName },
  ];
  state.db.daily_reports = [
    { id: MONDAY, org_id: ORG, profile_id: LEAD, report_date: "2026-10-12", status: over.mondayStatus ?? "filed" },
    { id: TUESDAY, org_id: ORG, profile_id: LEAD, report_date: "2026-10-13", status: over.tuesdayStatus ?? "filed" },
  ];
  state.db.notifications = [
    { id: "n-mon", user_id: "owner-1", type: "daily_report", title: "Daily report from Larkspur Lead", url: `/planner?report=${MONDAY}`, read_at: null },
    { id: "n-tue", user_id: "owner-1", type: "daily_report", title: "Daily report from Larkspur Lead", url: `/planner?report=${TUESDAY}`, read_at: null },
    { id: "n-tue-again", user_id: "owner-1", type: "daily_report", title: "Daily report from Larkspur Lead", url: `/planner?report=${TUESDAY}`, read_at: null },
    { id: "n-other", user_id: "owner-1", type: "quote_accepted", title: "Daily report from Larkspur Lead", url: `/planner?report=${TUESDAY}`, read_at: null },
    { id: "n-theirs", user_id: "lead-1", type: "daily_report", title: "Daily report from Larkspur Lead", url: `/planner?report=${TUESDAY}`, read_at: null },
  ];
}

describe("Reviewing one daily report marks every unread Bell row from that person read", () => {
  it("a report's bell line and push carry the report, so the line is tied to that report and no other", async () => {
    state.userId = LEAD;
    state.db.profiles = [{ id: LEAD, org_id: ORG, role: "tech", full_name: "Larkspur Lead" }];
    state.db.daily_reports = [];
    state.db.time_entries = [];
    const res = await fileDailyReport({ did_today: "Pulled wire at Bayberry", materials_tomorrow: "" });
    expect(res.ok).toBe(true);
    const filed = state.db.daily_reports[0];
    expect(spies.notified[0][2]).toMatchObject({ type: "daily_report", title: "Daily report from Larkspur Lead", url: `/planner?report=${filed.id}` });
    expect(spies.pushed[0][2]).toMatchObject({ url: `/planner?report=${filed.id}` });
  });

  it("reviewing Tuesday's report closes Tuesday's lines only: Monday's, still unreviewed, keeps its bell prompt", async () => {
    seedReports();
    const out = await markDailyReportReviewed(TUESDAY);
    expect(out.ok).toBe(true);
    expect(bell("n-tue").read_at).not.toBeNull();
    expect(bell("n-tue-again").read_at).not.toBeNull(); // a re-filed report's second line is still its own
    expect(bell("n-mon").read_at).toBeNull();
    // Not another kind of line, and not another person's bell.
    expect(bell("n-other").read_at).toBeNull();
    expect(bell("n-theirs").read_at).toBeNull();
  });

  it("a renamed filer, or one with no name at all, still has the report's line closed", async () => {
    for (const leadName of [null, "Larkspur Lead (now Snowbell)"]) {
      seedReports({ leadName });
      await markDailyReportReviewed(TUESDAY);
      expect(bell("n-tue").read_at).not.toBeNull();
      expect(bell("n-mon").read_at).toBeNull();
    }
  });

  it("lines filed before they carried a report close by the filer's name only when no other report of theirs is waiting", async () => {
    seedReports();
    state.db.notifications.push({ id: "n-old", user_id: "owner-1", type: "daily_report", title: "Daily report from Larkspur Lead", url: "/planner", read_at: null });
    await markDailyReportReviewed(TUESDAY); // Monday is still filed: an old line could be Monday's
    expect(bell("n-old").read_at).toBeNull();
    await markDailyReportReviewed(MONDAY); // now nothing of theirs is waiting
    expect(bell("n-old").read_at).not.toBeNull();
  });

  it("a bell write that fails is reported, and the review still stands", async () => {
    seedReports();
    state.fail = (c) => (c.table === "notifications" ? { message: "no bell" } : null);
    const out = await markDailyReportReviewed(TUESDAY);
    expect(out.ok).toBe(true);
    expect(state.db.daily_reports.find((r) => r.id === TUESDAY)!.status).toBe("reviewed");
    expect(spies.reported.some((a) => a[0] === "timeclock.reviewReport.bell")).toBe(true);
  });
});
