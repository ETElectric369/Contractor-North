import { describe, it, expect, vi } from "vitest";
import { ON_HOLD_WHY, orderWhichJobChoices, pickOutcome, routePick, type ChoiceJob, type WhichJobOption } from "./which-job-choices";

// The server half (putPunchOnJob → lib/job-promote), on a fake database: see the last describe.
const db = vi.hoisted(() => ({ jobStatus: "on_hold" as string, woke: true, calls: [] as { table: string; verb: string; cols: string; payload?: unknown; filters: unknown[][] }[] }));
vi.mock("@/lib/supabase/server", () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "tech-1" } } }) },
    from(table: string) {
      const q = { table, verb: "select", cols: "", payload: undefined as unknown, filters: [] as unknown[][] };
      db.calls.push(q);
      const answer = () => {
        if (table === "time_entries" && q.verb === "select") return { data: { id: "p1", job_id: null, job_code: null, status: "open", clock_out: null } };
        if (table === "time_entries" && q.verb === "update") return { data: { id: "p1" } };
        if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles", timeclock_job_codes: true } } };
        if (table === "jobs" && q.verb === "select" && q.cols.startsWith("org_id"))
          return { data: { org_id: "org-1", status: db.jobStatus, job_number: "J-048", name: "Tanager Ln", hold_reason: "waiting on the permit" } };
        if (table === "jobs" && q.verb === "select") return { data: { id: "j48", status: db.jobStatus, job_number: "J-048", name: "Tanager Ln", address: null, customers: null } };
        if (table === "jobs" && q.verb === "update") {
          const onlyHeld = q.filters.some((f) => f[0] === "eq" && f[1] === "status" && f[2] === "on_hold");
          return { data: onlyHeld ? (db.woke ? [{ id: "j48" }] : []) : null };
        }
        return { data: null };
      };
      const chain: any = {
        select: (cols?: string) => ((q.verb === "select" ? (q.cols = cols ?? "") : undefined), chain),
        update: (p: unknown) => ((q.verb = "update"), (q.payload = p), chain),
        maybeSingle: () => Promise.resolve({ ...answer(), error: null }),
        single: () => Promise.resolve({ ...answer(), error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ ...answer(), error: null }).then(ok),
      };
      for (const m of ["eq", "in", "is", "not", "order", "limit"]) chain[m] = (...a: unknown[]) => (q.filters.push([m, ...a]), chain);
      return chain;
    },
  };
  return { createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

/**
 * "WHICH JOB ARE YOU ON?" AND A JOB ON HOLD (NY-hold, 0366).
 *
 * Picking a job puts the punch there and promotes the job (the one promotion clock-in, Switch Job and
 * Which Job share), and a job on hold comes off hold with it. So the sheet lists a held job LAST,
 * whatever group it would have been in, saying what the tap will do; and the answer says it again,
 * after the placed sentence, at every door (a toast, or the sheet itself at the offline queue's door).
 * With no warning, every sentence is exactly what it was.
 */
const TZ = "America/Los_Angeles";
const TODAY = "2026-09-28";
const j = (id: string, over: Partial<ChoiceJob> = {}): ChoiceJob => ({
  id,
  job_number: id.toUpperCase(),
  name: `Job ${id}`,
  status: "in_progress",
  created_at: "2026-09-01T12:00:00Z",
  ...over,
});
const order = (jobs: ChoiceJob[], over: Partial<Parameters<typeof orderWhichJobChoices>[0]> = {}) =>
  orderWhichJobChoices({ jobs, lastJobId: null, segToday: new Set(), todayStr: TODAY, tz: TZ, codesOn: true, ...over });

describe("a held job on the sheet", () => {
  it("the job he worked last, now on hold, goes LAST with its On Hold why", () => {
    const rows = order([j("j48", { status: "on_hold" }), j("j28"), j("j39", { created_at: "2026-09-20T12:00:00Z" })], { lastJobId: "j48" });
    expect(rows.map((r) => r.id)).toEqual(["j39", "j28", "j48"]);
    expect(rows.at(-1)).toEqual({ id: "j48", label: "Job j48", why: ON_HOLD_WHY });
    expect(ON_HOLD_WHY).toBe("On hold: picking it takes it off hold");
  });

  it("a held job on today's schedule goes last too, after today's and the jobs in progress", () => {
    const rows = order(
      [j("j48", { status: "on_hold", scheduled_start: `${TODAY}T15:00:00Z` }), j("j30", { status: "scheduled", scheduled_start: `${TODAY}T16:00:00Z` }), j("j39")],
    );
    expect(rows.map((r) => [r.id, r.why ?? null])).toEqual([
      ["j30", "On today's schedule"],
      ["j39", null],
      ["j48", ON_HOLD_WHY],
    ]);
  });

  it("two held jobs keep their own order between them, both at the end", () => {
    const rows = order(
      [j("j48", { status: "on_hold" }), j("j50", { status: "on_hold", scheduled_start: `${TODAY}T15:00:00Z` }), j("j39")],
      { lastJobId: "j48" },
    );
    expect(rows.map((r) => r.id)).toEqual(["j39", "j48", "j50"]);
    expect(rows.slice(1).every((r) => r.why === ON_HOLD_WHY)).toBe(true);
  });

  it("with nothing on hold the list is exactly what it was", () => {
    const rows = order([j("j28"), j("j30", { status: "scheduled", scheduled_start: `${TODAY}T16:00:00Z` })], { lastJobId: "j28" });
    expect(rows).toEqual([
      { id: "j28", label: "Job j28", why: "Where you worked last" },
      { id: "j30", label: "Job j30", why: "On today's schedule" },
    ]);
  });
});

describe("the answer to a pick that took a job off hold", () => {
  const held: WhichJobOption = { id: "j48", label: "Job j48", why: ON_HOLD_WHY };
  const WARNING = "J-048 was on hold (waiting on the permit). It's off hold now.";

  it("says both sentences, the placed one first", async () => {
    const put = vi.fn(async () => ({ ok: true, label: "J-048 Tanager", warning: WARNING }));
    expect(await pickOutcome(put, "p1", held)).toEqual({ kind: "placed", sentence: `Your punch is on J-048 Tanager. ${WARNING}` });
  });

  it("at a door with a toast, the toast carries both; at the offline queue's door, the sheet does", async () => {
    const put = vi.fn(async () => ({ ok: true, label: "J-048 Tanager", warning: WARNING }));
    const out = await pickOutcome(put, "p1", held);
    const both = `Your punch is on J-048 Tanager. ${WARNING}`;
    expect(routePick(out, { confirmInline: false, gone: false })).toEqual({
      refresh: true,
      toast: { sentence: both, kind: "success" },
      inline: null,
      placed: null,
      close: true,
    });
    expect(routePick(out, { confirmInline: true, gone: false })).toEqual({
      refresh: true,
      toast: null,
      inline: null,
      placed: both,
      close: false,
    });
    // Closed while the write was out: the toast still says both.
    expect(routePick(out, { confirmInline: true, gone: true }).toast).toEqual({ sentence: both, kind: "success" });
  });

  it("with no warning (or a blank one) the placed sentence is unchanged", async () => {
    expect(await pickOutcome(vi.fn(async () => ({ ok: true, label: "85 Whitney" })), "p1", held)).toEqual({
      kind: "placed",
      sentence: "Your punch is on 85 Whitney.",
    });
    expect(await pickOutcome(vi.fn(async () => ({ ok: true, label: "85 Whitney", warning: "  " })), "p1", held)).toEqual({
      kind: "placed",
      sentence: "Your punch is on 85 Whitney.",
    });
  });

  it("the server's pick (putPunchOnJob) says it: the job came off hold, in the one promotion's words", async () => {
    const { putPunchOnJob } = await import("./which-job-actions");
    db.calls = [];
    db.jobStatus = "on_hold";
    db.woke = true;
    expect(await putPunchOnJob("p1", "j48")).toEqual({ ok: true, label: "Tanager Ln", warning: WARNING });
    // The wake is its own checked write: only while the job is still on hold, and asked back.
    const wake = db.calls.find((c) => c.table === "jobs" && c.verb === "update")!;
    expect(wake.payload).toEqual({ status: "in_progress" });
    expect(wake.filters).toContainEqual(["eq", "status", "on_hold"]);
    // Someone took it off hold first: no warning (the job was never taken off hold by this pick).
    db.calls = [];
    db.woke = false;
    expect(await putPunchOnJob("p1", "j48")).toEqual({ ok: true, label: "Tanager Ln" });
    // A job that wasn't held: the pick is what it always was.
    db.calls = [];
    db.jobStatus = "scheduled";
    expect(await putPunchOnJob("p1", "j48")).toEqual({ ok: true, label: "Tanager Ln" });
  });

  it("a refusal never carries a warning: it is the refusal, in its own words", async () => {
    const put = vi.fn(async () => ({ ok: false, error: "That job is finished. Pick one that's still going, or skip and the office will pick.", warning: WARNING }));
    expect(await pickOutcome(put, "p1", held)).toEqual({
      kind: "refused",
      sentence: "That job is finished. Pick one that's still going, or skip and the office will pick.",
    });
  });
});

describe("every clock-in door says when a hold came off", () => {
  // clockIn returns the off-hold sentence as res.warning (lib/job-promote). A door that drops it
  // takes a job off hold, and clears its reason and day, without a word: the Timeclock page's own
  // Clock In did exactly that. Every .tsx that calls clockIn must read res.warning.
  it("each .tsx calling clockIn reads res.warning", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));
    const callers = walk(join(process.cwd(), "src")).filter((f) => /\bclockIn\(/.test(readFileSync(f, "utf8")));
    expect(callers.map((f) => f.slice(f.indexOf("src/")))).toContain("src/app/(app)/timeclock/timeclock-panel.tsx");
    const silent = callers.filter((f) => !/res\.warning/.test(readFileSync(f, "utf8"))).map((f) => f.slice(f.indexOf("src/")));
    expect(silent).toEqual([]);
  });

  it("the Timeclock page's Clock In toasts it, sticky, like Switch Job and Clock Out", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/timeclock/timeclock-panel.tsx"), "utf8");
    const at = src.indexOf("function doClockIn()");
    const body = src.slice(at, src.indexOf("\n  function ", at + 20));
    expect(body).toContain('if (res.warning) toast(res.warning, "info", undefined, { sticky: true });');
  });
});
