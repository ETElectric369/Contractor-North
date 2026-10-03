import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ERIK'S SECOND TIMECLOCK RULE, FOUND BY USING IT (2026-10-02): "chances are if anyone clocks in and
 * splits the shift quickly the first job isnt actually getting any of that time."
 *
 * He punches in from the truck, the app puts him on the job the schedule happened to be showing, he
 * drives, and he taps Switch when he gets where the work actually is. switch_job CUT there — six
 * minutes left behind on a job nobody worked — and those slivers are what he was deleting by hand on
 * Timecards, which is how the other half of this lane got found.
 *
 * So a punch switched soon after it started MOVES WHOLE, and the cut stays exactly as it was once the
 * punch is older: four real hours on the right job must never follow a man onto the next customer.
 * The rule is one function (switch-window) and every door reads it — the server to decide the write,
 * the two doors that describe a switch before it happens to word their warning.
 *
 * Pinned without a database. switch_job's SQL is unchanged and still cuts past two minutes; the fake
 * below throws by name on any statement it was not told about, so "the cut is not even asked for" is
 * enforced by construction rather than asserted.
 *
 * THREE DOORS DESCRIBE A SWITCH BEFORE IT HAPPENS, not two (review, 2026-10-03): the Timeclock panel,
 * the job page's switch sheet and the visit card. The first pass reached the first two, and it read the
 * rule on a clock that had stopped ticking. Both halves are pinned at the bottom of this file.
 */

const state = vi.hoisted(() => ({ client: null as any }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  createNotifications: vi.fn(async () => {}),
  notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })),
}));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}), orgStaffIds: vi.fn(async () => ["office-1"]) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { readFileSync } from "node:fs";
import { switchJob } from "./actions";
import { SWITCH_MOVES_WHOLE_MS, switchMovesWholeNow, switchMovesWholePunch } from "./switch-window";
import { switchJobSpoken, timeActions } from "@/lib/actions/entities/time";
import { appChoseSentenceToSay } from "./clock-told";
import { dict } from "@/lib/i18n";

const en = dict("en");
const es = dict("es");
/** A client effect cannot be driven in a node suite, so the doors' clocks are read from source. */
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

type Q = { table: string; verb: "select" | "insert" | "update" | "delete" | "rpc"; cols: string; payload?: any; filters: any[] };
type Reply = { data?: any; error?: any } | undefined;

function fakeSupabase(route: (q: Q) => Reply, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.payload ?? null)}`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc(fn: string, args: any) {
      const q: Q = { table: `rpc:${fn}`, verb: "rpc", cols: "", payload: args, filters: [] };
      calls.push(q);
      return Promise.resolve(answer(q));
    },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const chain: any = {
        select(cols?: string) { if (q.verb === "select") q.cols = cols ?? ""; return chain; },
        insert(p: any) { q.verb = "insert"; q.payload = p; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        delete() { q.verb = "delete"; return chain; },
        single() { return Promise.resolve(answer(q)); },
        maybeSingle() { return Promise.resolve(answer(q)); },
        then(resolve: any, reject: any) {
          try { resolve(answer(q)); } catch (e) { reject?.(e); }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "overlaps", "order", "limit", "contains"]) {
        chain[m] = (...args: any[]) => { q.filters.push([m, ...args]); return chain; };
      }
      return chain;
    },
  };
}

const MIN = 60_000;
const ENTRY = "0c7fae89-0000-4000-8000-000000000001";
const NEXT_PIECE = "2f468f0d-0000-4000-8000-000000000002";
/** The job the app put the punch on, from a schedule that had already moved on. */
const ARR56 = "a0000000-0000-4000-8000-00000000033a";
/** Where the work actually is. */
const HONEYSUCKLE = "a0000000-0000-4000-8000-00000000011b";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const punch = (over: Record<string, unknown> = {}) => ({
  id: ENTRY,
  org_id: "org-1",
  profile_id: "user-1",
  job_id: ARR56,
  job_code: null,
  notes: null,
  rate_override: null,
  clock_in: ago(6 * MIN),
  split_from: null,
  ...over,
});

/** Everything a switch reads apart from the cut itself. An unrouted rpc:switch_job throws by name. */
const routes = (row: any, cut?: Reply) => (q: Q): Reply => {
  if (q.table === "time_entries" && q.verb === "select") return { data: row };
  if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: ENTRY }] };
  if (q.table === "jobs" && q.cols === "id") return { data: { id: HONEYSUCKLE } };
  if (q.table === "jobs") return { data: { job_number: "J-011", name: "Honeysuckle", org_id: "org-1", status: "scheduled" } };
  if (q.table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } } };
  if (q.table === "rpc:switch_job") return cut;
  return undefined;
};
/** The job move: the one update that carries a job_id. */
const moveOf = (calls: Q[]) => calls.find((c) => c.table === "time_entries" && c.verb === "update" && "job_id" in (c.payload ?? {}));

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
});

describe("switchMovesWholePunch: the rule itself", () => {
  const now = Date.parse("2026-10-02T15:00:00.000Z");
  it("a punch that just started moves whole", () => {
    expect(switchMovesWholePunch(now - 10, now)).toBe(true);
    expect(switchMovesWholePunch(now - 6 * MIN, now)).toBe(true);
  });

  it("the window has an end, so hours really worked are never dragged along", () => {
    expect(switchMovesWholePunch(now - (SWITCH_MOVES_WHOLE_MS - 1), now)).toBe(true);
    expect(switchMovesWholePunch(now - SWITCH_MOVES_WHOLE_MS, now)).toBe(false);
    expect(switchMovesWholePunch(now - 4 * 60 * MIN, now)).toBe(false);
  });

  it("a phone clock a little ahead of the server is still a fresh punch, not a refusal", () => {
    expect(switchMovesWholePunch(now + 30_000, now)).toBe(true);
  });

  it("an unreadable clock-in cuts: never move a shift whose length nobody knows", () => {
    expect(switchMovesWholePunch(NaN, now)).toBe(false);
    expect(switchMovesWholePunch(Date.parse("not a time"), now)).toBe(false);
  });

  /** What a DOOR asks: both ways a punch moves whole, in one answer, so no screen reads half of it. */
  describe("switchMovesWholeNow: the outcome a screen is allowed to promise", () => {
    it("a punch with no job and no code moves whole at any age — switch_job's own carve-out", () => {
      expect(switchMovesWholeNow(false, now - 10, now)).toBe(true);
      expect(switchMovesWholeNow(false, now - 8 * 60 * MIN, now)).toBe(true);
      // Even an unreadable clock-in: a job-less punch has nowhere for a cut to leave hours.
      expect(switchMovesWholeNow(false, NaN, now)).toBe(true);
    });

    it("a punch that HAS a place is judged by the clock, which is the half the visit card was missing", () => {
      expect(switchMovesWholeNow(true, now - 6 * MIN, now)).toBe(true);
      expect(switchMovesWholeNow(true, now - (SWITCH_MOVES_WHOLE_MS - 1), now)).toBe(true);
      expect(switchMovesWholeNow(true, now - SWITCH_MOVES_WHOLE_MS, now)).toBe(false);
      expect(switchMovesWholeNow(true, now - 4 * 60 * MIN, now)).toBe(false);
    });

    it("it is the same answer switchJob reaches, written the way the server's fork is written", () => {
      for (const age of [0, 6 * MIN, SWITCH_MOVES_WHOLE_MS, 4 * 60 * MIN]) {
        const ci = now - age;
        // switchJob: hasPlace && young, with the job-less case handed to switch_job, which moves whole.
        const server = (hasPlace: boolean) => (hasPlace ? switchMovesWholePunch(ci, now) : true);
        for (const hasPlace of [true, false]) expect(switchMovesWholeNow(hasPlace, ci, now)).toBe(server(hasPlace));
      }
    });
  });
});

describe("switchJob on a punch that just started", () => {
  it("THE DEFECT: six minutes in, the whole punch moves and nothing is cut", async () => {
    state.client = fakeSupabase(routes(punch()), calls);
    const r = await switchJob({ entry_id: ENTRY, job_id: HONEYSUCKLE, gps: null });
    expect(r).toMatchObject({ ok: true, mode: "repointed", entry_id: ENTRY, closed_hours: 0 });
    // The cut is not merely unused — it is never asked for, so switch_job's SQL needs no migration.
    expect(calls.some((c) => c.table === "rpc:switch_job")).toBe(false);
    // ONE row, its job changed, nothing closed: every minute since the punch is on the new job.
    const move = moveOf(calls)!;
    expect(move.payload).toEqual({ job_id: HONEYSUCKLE, job_code: null });
    expect(move.payload).not.toHaveProperty("clock_out");
    expect(move.payload).not.toHaveProperty("status");
    // The predicates name the punch AND the job it was on, so a punch that moved underneath cannot
    // come back as a switch that landed (the silent-write law).
    expect(move.filters).toContainEqual(["eq", "id", ENTRY]);
    expect(move.filters).toContainEqual(["eq", "profile_id", "user-1"]);
    expect(move.filters).toContainEqual(["eq", "status", "open"]);
    expect(move.filters).toContainEqual(["eq", "job_id", ARR56]);
    // The breadcrumb rides along, as on any whole move: the only record of when the entry stopped
    // being about the old site, and what re-opens the geofence anchor window.
    expect(r.notes).toMatch(/^\[switched to Honeysuckle at .+Z\]$/);
  });

  it("the typed note travels with the row instead of being written twice", async () => {
    state.client = fakeSupabase(routes(punch({ notes: "pulled wire" })), calls);
    const r = await switchJob({ entry_id: ENTRY, job_id: HONEYSUCKLE, notes: "pulled wire, then the panel", gps: null });
    expect(r.notes).toMatch(/^pulled wire, then the panel\n\[switched to Honeysuckle at .+Z\]$/);
    // Nothing closes, so there is no finished entry to strand unsaved typing on: one notes write.
    expect(calls.filter((c) => c.table === "time_entries" && c.verb === "update" && "notes" in (c.payload ?? {}))).toHaveLength(1);
  });

  it("a code-only punch with no job moves whole too, and asks PostgREST for null properly", async () => {
    state.client = fakeSupabase(routes(punch({ job_id: null, job_code: "SHOP" })), calls);
    expect(await switchJob({ entry_id: ENTRY, job_id: HONEYSUCKLE, gps: null })).toMatchObject({ ok: true, mode: "repointed" });
    expect(moveOf(calls)!.filters).toContainEqual(["is", "job_id", null]);
  });

  it("a punch that closed or changed job underneath is said out loud, never reported as switched", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "update") return { data: [] }; // zero rows
      return routes(punch({ clock_in: ago(2 * MIN) }))(q);
    }, calls);
    const r = await switchJob({ entry_id: ENTRY, job_id: HONEYSUCKLE, gps: null });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Nothing moved: that shift closed or changed job in the meantime. Reload and try again.");
  });

  it("a fresh piece of a day that has been running since dawn is moved, never closed at now", async () => {
    // The forgotten-clock refusal is for a CUT — it exists so one tap cannot write a 17-hour shift.
    // A whole move closes nothing, so the question does not arise and the shift chain is not read.
    state.client = fakeSupabase(routes(punch({ clock_in: ago(3 * MIN), split_from: NEXT_PIECE })), calls);
    expect(await switchJob({ entry_id: ENTRY, job_id: HONEYSUCKLE, gps: null })).toMatchObject({ ok: true, mode: "repointed" });
  });

  it("the anchor is this switch's own fix, never the site he just left", async () => {
    state.client = fakeSupabase(routes(punch()), calls);
    await switchJob({ entry_id: ENTRY, job_id: HONEYSUCKLE, gps: { lat: 39.81, lng: -120.12, accuracy: 18 } });
    const anchor = calls.filter((c) => c.table === "time_entries" && c.verb === "update").pop()!;
    expect(anchor.payload.gps_in).toMatchObject({ lat: 39.81, lng: -120.12, accuracy: 18 });
  });
});

describe("switchJob once the punch is no longer fresh", () => {
  const CUT = { data: { mode: "cut", entry_id: NEXT_PIECE, closed_id: ENTRY, closed_hours: 4, rate_left_behind: false } };

  it("four hours on the right job still cut, and never follow him onto the next customer", async () => {
    state.client = fakeSupabase(routes(punch({ clock_in: ago(4 * 60 * MIN) }), CUT), calls);
    const r = await switchJob({ entry_id: ENTRY, job_id: HONEYSUCKLE, gps: null });
    expect(r).toMatchObject({ ok: true, mode: "cut", entry_id: NEXT_PIECE, closed_hours: 4 });
    expect(moveOf(calls)).toBeUndefined();
  });

  it("a clock-in nobody can read falls to the cut", async () => {
    state.client = fakeSupabase(routes(punch({ clock_in: null }), CUT), calls);
    expect(await switchJob({ entry_id: ENTRY, job_id: HONEYSUCKLE, gps: null })).toMatchObject({ ok: true, mode: "cut" });
    expect(moveOf(calls)).toBeUndefined();
  });

  it("a backdated punch typed in as having started at seven has really worked those hours", async () => {
    state.client = fakeSupabase(routes(punch({ clock_in: ago(8 * 60 * MIN) }), CUT), calls);
    expect(await switchJob({ entry_id: ENTRY, job_id: HONEYSUCKLE, gps: null })).toMatchObject({ ok: true, mode: "cut" });
  });
});

/**
 * THE WORDS GO STALE THE MOMENT THE CODE CHANGES (onboarding truth law). Two of them promised, in
 * print, that a switch can never move hours — one to the model that calls the verb, one read out loud
 * to the man in the truck at the very instant a switch WOULD move his punch whole.
 */
describe("what a switch is said to do", () => {
  it("Nort's verb says BOTH things it does, and never promises which before it is called", () => {
    const d = timeActions["time.switchJob"].description ?? "";
    expect(d).toMatch(/MOVES OVER WHOLE/);
    expect(d).toMatch(/last fifteen minutes/i);
    expect(d).toMatch(/after that it CUTS/i);
    expect(d).toMatch(/never promise which one it will do/i);
    // And it still names where a wrong job gets fixed once the shift has been running a while.
    expect(d).toContain("Timecards");
  });

  it("the sentence said at the punch no longer claims nobody can move it", () => {
    const say = appChoseSentenceToSay("J-013 ARR 56 rough-in · 56 Alder Ridge Rd", "schedule");
    expect(say).not.toContain("I can't move it for you");
    expect(say).toMatch(/move this whole punch while it's this fresh/);
    // The three doors that move a punch at any age are still named: no dead end either way.
    expect(say).toContain("My Day");
    expect(say).toContain("Timeclock");
    expect(say).toContain("Timecards");
  });

  /**
   * A RE-POINT MOVES ONE ROW, so "the whole SHIFT moved over" was false for the second piece of a day
   * already cut by a Switch Job: his 3 hours from the morning stayed on the first job while the words
   * said everything followed him. "This whole PUNCH" is what the write actually does, and it is the
   * word clock-told already used. The spoken line matters most — Nort says it word for word, with no
   * screen beside it to correct it.
   */
  it("every whole-move sentence says PUNCH, because the write moves one row and the morning stays put", () => {
    expect(en.tc_switchedWhole).toBe("Now on {job}. This whole punch moved over.");
    expect(en.tc_switchedWhole).not.toContain("shift");
    expect(es.tc_switchedWhole).not.toContain("turno");
    expect(switchJobSpoken("repointed", 0, "J-011 Honeysuckle")).toContain("this whole punch is on the new job now");
    expect(switchJobSpoken("repointed", 0, "J-011 Honeysuckle")).toContain("Any earlier part of the day stays where it was");
    // The panel and the job page, where the sentence is shown BEFORE the tap.
    expect(src("./timeclock-panel.tsx")).toContain("so this whole punch moves onto the job you pick: none of it stays on ${currentJobName}.");
    expect(src("./timeclock-panel.tsx")).not.toContain("the whole shift moves onto the job you pick");
    expect(src("../jobs/[id]/job-time-button.tsx")).toContain("Switching puts this whole punch on");
    expect(src("../jobs/[id]/job-time-button.tsx")).not.toContain("puts this whole shift on");
  });
});

/**
 * THE DOOR'S CLOCK HAS TO BE RUNNING (review, 2026-10-03).
 *
 * The job page's switch sheet fed the rule a `now` that only ticked in state "here", so in state
 * "switch" it was whatever the clock read when the component mounted. Punch on job A at 7:00, open job
 * B's page at 7:05 on the drive and leave it open (nothing remounts this button), tap Switch Here at
 * 7:40: the sheet still read five minutes and promised "this whole punch", and the server, on its own
 * clock, cut and left 40 minutes on A. A stale clock can only understate the age, so the error always
 * runs that one way — promise whole, deliver cut. This is the tech's only switch door: the panel's
 * Switch Job is staff-only.
 *
 * There is no DOM in this suite, so a client effect cannot be driven here. These read the doors.
 */
describe("the doors read the one rule, on a clock that is still running", () => {
  const panel = src("./timeclock-panel.tsx");
  const jobDoor = src("../jobs/[id]/job-time-button.tsx");
  const card = src("../appointments/[id]/visit-start-card.tsx");

  it("all THREE doors ask switch-window, so none can promise a cut the server will not make", () => {
    expect(panel).toContain('from "./switch-window"');
    expect(jobDoor).toContain('from "../../timeclock/switch-window"');
    expect(card).toContain('from "../../timeclock/switch-window"');
    // switchJob's other callers describe nothing BEFORE the tap, so they need no clock of their own:
    // they read the mode the server answers with.
    expect(src("../appointments/start-job-actions.ts")).toContain('sw.mode === "repointed"');
    expect(src("../../../lib/actions/entities/time.ts")).toContain("switchJobSpoken(res.mode");
  });

  it("THE DEFECT: the job page's clock ticks whenever a clock is running, not only in state 'here'", () => {
    expect(jobDoor).toMatch(/useEffect\(\(\) => \{\s*if \(!openEntry\) return;\s*setNow\(Date\.now\(\)\);\s*const t = setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\);/);
    // The guard that froze it: state "switch" is exactly where the sentence is drawn.
    expect(jobDoor).not.toContain('if (state !== "here") return;');
    // And the fork reads that ticking value, from the shared rule.
    expect(jobDoor).toContain("switchMovesWholeNow(!!openEntry.job_id || !!openEntry.job_code, Date.parse(openEntry.clock_in), now)");
    // ONE clock in the file: the hours in the cut sentence can no longer come from a different moment.
    expect(jobDoor).not.toContain("Date.now() - new Date(openEntry.clock_in)");
  });

  it("and it says which of the two things happened AFTER the tap, as the other two doors do", () => {
    // On the fifteen-minute line the sheet's clock and the server's can still disagree by a second, so
    // the outcome is read off the server's own answer and said out loud. Nothing silent.
    expect(jobDoor).toContain("res.mode === \"repointed\"");
    expect(jobDoor).toContain("`Now on ${jobNumber}. This whole punch moved over.`");
    expect(jobDoor).toContain("h before the switch stayed on ${was}.`");
  });

  it("the panel's own clock is still unconditional, which is what its comment rests on", () => {
    expect(panel).toMatch(/useEffect\(\(\) => \{\s*if \(!openEntry\) return;\s*const t = setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\);/);
  });
});
