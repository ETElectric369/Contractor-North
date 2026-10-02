import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE CLOCK SAYS WHICH JOB IT PUT YOUR PUNCH ON (Erik, 2026-10-01).
 *
 * "we didn't do the job at ARR 56 this morning. Brian clocked in on his way to the Supply house to
 * get materials for Larkspur before I could switch the schedule." Two punches landed on the job the
 * schedule happened to be showing — 2h19m of Brian's billable time on the wrong customer — and the
 * clock said nothing, because it only ever spoke up when it COULDN'T tell the job. Then those hours
 * made that job a worked day, and a worked day does not move, so the schedule kept agreeing with the
 * punch that the schedule had caused.
 *
 * What these tests pin:
 *   · a job-less punch the server resolves comes back SAYING the app chose, and names the job the
 *     way a person knows it — never a bare number;
 *   · a punch whose job the PERSON picked says nothing new;
 *   · a punch on no job still ASKS and never tells (the two rules never both fire);
 *   · the offline replay says it when the held punch finally lands — Brian in the truck;
 *   · the sentence carries a Change door that moves the WHOLE punch off the app's pick, on a checked
 *     write that names the job it is coming off;
 *   · and every clock door calls the ONE rule instead of writing it again (the bypass tripwires).
 */

// ── the server half, on a fake database ──────────────────────────────────────────────────────

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => undefined), notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => undefined), orgStaffIds: vi.fn(async () => []) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { clockIn } from "./actions";
import { putPunchOnJob, whichJobChoices } from "./which-job-actions";
import {
  CHANGE_JOB_LABEL,
  UNREAD_JOB_LABEL,
  appChoseSentence,
  changeJobAsk,
  punchJobLabel,
  replayTold,
  tellAppChose,
} from "./clock-told";
import {
  askAfterPunch,
  choicesUnavailable,
  jobsDidntLoadSentence,
  orderWhichJobChoices,
  pickOutcome,
  punchStillOn,
  sheetAfterLoad,
  type ChoiceJob,
  type SheetPhase,
} from "./which-job-choices";
import { NO_PUNCH_ON_SCREEN, noticeForEntry } from "./clock-told";
import { switchJobSpoken, timeActions } from "@/lib/actions/entities/time";
import { agentToolResultBody } from "@/lib/actions/agent-tool-result";
import type { ActionCtx, ActionResult } from "@/lib/actions/types";
import { workedDaysFrom } from "@/lib/schedule-math";
import { WhichJobSheetView } from "../planner/which-job";
import { AppChoseJobNotice } from "./app-chose-notice";
import { codeOnly } from "@/lib/migration-body.test-util";

type Q = { table: string; verb: "select" | "insert" | "update" | "delete"; cols: string; returning?: string; payload?: any; filters: any[] };
type Reply = { data?: any; error?: any } | undefined;

function fakeSupabase(route: (q: Q) => Reply, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.filters)}`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const chain: any = {
        select(cols?: string) {
          if (q.verb === "select") q.cols = cols ?? "";
          else q.returning = cols ?? "";
          return chain;
        },
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

const has = (q: Q, ...f: any[]) => q.filters.some((x) => JSON.stringify(x) === JSON.stringify(f));
const PUNCH = "a0000000-0000-4000-8000-00000000000a";
const ARR = "d0000000-0000-4000-8000-00000000000d";
const SUPPLY = "e0000000-0000-4000-8000-00000000000e";
const SETTINGS = { data: { settings: { timezone: "America/Los_Angeles", timeclock_job_codes: true } } };

/** The job row the label read brings back: Erik's own morning, named the way he names jobs. */
const ARR_ROW = { id: ARR, job_number: "J-013", name: "ARR 56 rough-in", address: "56 Alder Ridge Rd", customers: { name: "Marla Finch" } };

/**
 * BRIAN'S MORNING. The schedule puts him on ARR 56 today (the office's day row, tier 0), he taps the
 * one Clock In button, and the punch carries no job of its own.
 */
const schedulePutsHimOnArr =
  (over: { jobRow?: Reply; insert?: Reply } = {}) =>
  (q: Q): Reply => {
    if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
    if (q.table === "profiles") return { data: { role: "tech" } };
    if (q.table === "organizations") return SETTINGS;
    if (q.table === "crew_day_assignments") return { data: { job_id: ARR, kind: "job" } };
    // The day row's job is still in flight (resolveTechJobToday tier 0's own check).
    if (q.table === "jobs" && q.cols === "id") return { data: { id: ARR } };
    // The promotion's read (lib/job-promote), then its write.
    if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1", status: "scheduled" } };
    if (q.table === "jobs" && q.verb === "update") return { data: [] };
    // The LABEL read: what the sentence names.
    if (q.table === "jobs" && q.cols.startsWith("id, job_number")) return over.jobRow ?? { data: ARR_ROW };
    if (q.table === "time_entries" && q.verb === "insert") return over.insert ?? { data: { id: PUNCH } };
  };

/** A day nothing resolves at all: no day row, no job of his, two jobs in progress. */
const nothingResolves = (q: Q): Reply => {
  if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
  if (q.table === "profiles") return { data: { role: "tech" } };
  if (q.table === "organizations") return SETTINGS;
  if (q.table === "crew_day_assignments") return { data: null };
  if (q.table === "jobs" && q.filters.some((f) => f[0] === "contains")) return { data: [] };
  if (q.table === "jobs" && has(q, "eq", "status", "in_progress")) return { data: [{ id: "j1" }, { id: "j2" }] };
  if (q.table === "time_entries" && q.verb === "insert") return { data: { id: PUNCH } };
};

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
});

describe("PART 1 — the clock says what it decided", () => {
  it("a job-less punch the server resolved comes back saying the APP chose the job, and names it", async () => {
    state.client = fakeSupabase(schedulePutsHimOnArr(), calls);
    const res = await clockIn({ job_id: null, job_code: null, gps: null });

    expect(res.ok).toBe(true);
    expect(res.id).toBe(PUNCH);
    // THE HONEST SHAPE: who chose it is its own fact, not something inferred from job_id being set.
    // THE HONEST SHAPE also carries WHICH rule picked: tier 0/1 really is today's schedule, so the
    // sentence may say so (clock-told: a source it didn't use is the same class of lie as silence).
    expect(res.jobPick).toEqual({ chosenBy: "app", id: ARR, from: "schedule", label: "ARR 56 rough-in · 56 Alder Ridge Rd" });

    const told = tellAppChose(res);
    expect(told).not.toBeNull();
    expect(told!.entryId).toBe(PUNCH);
    expect(told!.job).toEqual({ id: ARR, label: "ARR 56 rough-in · 56 Alder Ridge Rd" });
    // The sentence a person sees: plain words, the job named, and it says who picked it.
    expect(told!.sentence).toBe(
      "Your punch is on ARR 56 rough-in · 56 Alder Ridge Rd. The app picked that from today's schedule — change it if you're somewhere else.",
    );
    // The punch still landed before any of this: the clock never waits on the sentence.
    const insert = calls.find((c) => c.verb === "insert")!;
    expect(insert.payload).toMatchObject({ job_id: ARR, status: "open" });
    expect(insert.returning).toBe("id");
    expect(calls.indexOf(insert)).toBeLessThan(calls.findIndex((c) => c.cols.startsWith("id, job_number")));
  });

  it("a punch whose job the PERSON picked says nothing new — they already know", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
      if (q.table === "profiles") return { data: { role: "owner" } };
      if (q.table === "jobs" && q.cols === "id") return { data: { id: ARR } };
      if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1", status: "scheduled" } };
      if (q.table === "jobs" && q.verb === "update") return { data: [] };
      if (q.table === "time_entries" && q.verb === "insert") return { data: { id: PUNCH } };
    }, calls);
    const res = await clockIn({ job_id: ARR, job_code: null, gps: null });

    expect(res.jobPick).toEqual({ chosenBy: "person", id: ARR });
    expect(tellAppChose(res)).toBeNull();
    // AND IT COSTS NO EXTRA READ: a person-picked punch never asks the database for a label.
    expect(calls.some((c) => c.cols.startsWith("id, job_number"))).toBe(false);
  });

  it("a punch that landed on no job ASKS and never tells: the two rules never both fire", async () => {
    state.client = fakeSupabase(nothingResolves, calls);
    const res = await clockIn({ job_id: null, job_code: null, gps: null });

    expect(res.noJob).toBe(true);
    expect(res.jobPick).toBeUndefined();
    expect(askAfterPunch(res, "in")).toEqual({ entryId: PUNCH, moment: "in" });
    expect(tellAppChose(res)).toBeNull();
  });

  it("a refused punch tells nothing — there is no punch to tell about", async () => {
    state.client = fakeSupabase(
      schedulePutsHimOnArr({ insert: { error: { code: "23505", message: 'duplicate key value violates unique constraint "one_open_entry"' } } }),
      calls,
    );
    const res = await clockIn({ job_id: null, job_code: null, gps: null });
    expect(res.ok).toBe(false);
    expect(tellAppChose(res)).toBeNull();
  });

  it("a job whose own row couldn't be read is still said out loud — silence is the one wrong answer", async () => {
    state.client = fakeSupabase(schedulePutsHimOnArr({ jobRow: { data: null } }), calls);
    const res = await clockIn({ job_id: null, job_code: null, gps: null });
    expect(res.jobPick).toEqual({ chosenBy: "app", id: ARR, from: "schedule", label: UNREAD_JOB_LABEL });
    expect(tellAppChose(res)!.sentence).toContain(UNREAD_JOB_LABEL);
  });

  it("the rule reads the ANSWER, not the shape of it: no id, not ok, or no pick tells nothing", () => {
    const pick = { chosenBy: "app" as const, id: ARR, from: "schedule" as const, label: "ARR 56" };
    expect(tellAppChose({ ok: true, jobPick: pick })).toBeNull();
    expect(tellAppChose({ ok: false, id: PUNCH, jobPick: pick })).toBeNull();
    expect(tellAppChose({ ok: true, id: PUNCH })).toBeNull();
    expect(tellAppChose(null)).toBeNull();
    expect(tellAppChose(undefined)).toBeNull();
  });
});

describe("the job named the way a person knows it — never a bare number", () => {
  const job = (over: Partial<ChoiceJob>): ChoiceJob => ({ id: "j1", job_number: "J-013", name: null, address: null, customers: null, ...over });

  it("codes on: the job's name AND where it is", () => {
    expect(punchJobLabel(job({ name: "ARR 56 rough-in", address: "56 Alder Ridge Rd" }), true)).toBe("ARR 56 rough-in · 56 Alder Ridge Rd");
  });

  it("a name that already carries the street doesn't say it twice", () => {
    expect(punchJobLabel(job({ name: "13631 Nightshade — Garage Subpanel", address: "13631 Nightshade" }), true)).toBe(
      "13631 Nightshade — Garage Subpanel",
    );
  });

  it("codes off: the Timeclock's own label — customer · street", () => {
    expect(punchJobLabel(job({ name: "ARR 56 rough-in", address: "56 Alder Ridge Rd", customers: { name: "Marla Finch" } }), false)).toBe(
      "Marla Finch · 56 Alder Ridge Rd",
    );
  });

  it("a job nobody named still says where it is, so the number is never alone (Erik: \"i cant tell by job numbers alone\")", () => {
    const label = punchJobLabel(job({ address: "5659 Fernhill" }), true);
    expect(label).toBe("J-013 · 5659 Fernhill");
    expect(appChoseSentence(label, "schedule")).toContain("5659 Fernhill");
    expect(label).not.toBe("J-013");
  });
});

describe("PART 2 — one tap to change it, and it is not a dead end", () => {
  it("the Change door opens the clock's own sheet, in move mode, off the job the app chose", () => {
    const told = tellAppChose({ ok: true, id: PUNCH, jobPick: { chosenBy: "app", id: ARR, from: "schedule", label: "ARR 56" } })!;
    expect(changeJobAsk(told)).toEqual({ entryId: PUNCH, moment: "move", from: { id: ARR, label: "ARR 56" } });
  });

  it("the sentence carries the Change door, and both are rendered by every clock door's one component", () => {
    const told = tellAppChose({ ok: true, id: PUNCH, jobPick: { chosenBy: "app", id: ARR, from: "schedule", label: "ARR 56 rough-in · 56 Alder Ridge Rd" } })!;
    const html = renderToStaticMarkup(createElement(AppChoseJobNotice, { notice: told, punch: { id: PUNCH, job_id: ARR }, onDone: () => {} }));
    expect(html).toContain("ARR 56 rough-in · 56 Alder Ridge Rd");
    expect(html).toContain("The app picked that from today&#x27;s schedule");
    expect(html).toContain(CHANGE_JOB_LABEL);
    // Title Case, 44px, and NOT a modal: the clock stays two buttons.
    expect(CHANGE_JOB_LABEL).toBe("Change The Job");
    expect(html).toContain("min-h-11");
    expect(html).not.toContain("role=\"dialog\"");
  });

  it("nothing to say, nothing rendered: a person-picked punch puts no line on the card", () => {
    expect(renderToStaticMarkup(createElement(AppChoseJobNotice, { notice: null, punch: { id: PUNCH, job_id: ARR }, onDone: () => {} }))).toBe("");
  });

  it("the sheet in move mode names the job it is moving the punch OFF, and its way out is not a lie", () => {
    const html = renderToStaticMarkup(
      createElement(WhichJobSheetView, {
        moment: "move" as const,
        from: { id: ARR, label: "ARR 56 rough-in" },
        state: { phase: "ready" as const, jobs: [{ id: SUPPLY, label: "41 Larkspur" }], isStaff: false },
        onPick: () => {},
        onSkip: () => {},
      }),
    );
    expect(html).toContain("The app put this punch on ARR 56 rough-in");
    expect(html).toContain("the whole punch moves");
    expect(html).toContain("Leave It Where It Is");
    // "Skip, The Office Will Pick" would be a lie: the punch already has a job.
    expect(html).not.toContain("Skip, The Office Will Pick");
  });

  it("the sheet never offers the job the punch is already on", () => {
    const jobs: ChoiceJob[] = [
      { id: ARR, name: "ARR 56 rough-in", status: "in_progress", created_at: "2026-09-01T00:00:00Z" },
      { id: SUPPLY, name: "41 Larkspur", status: "in_progress", created_at: "2026-09-02T00:00:00Z" },
    ];
    const common = { jobs, lastJobId: ARR, segToday: new Set([ARR]), hasSegments: new Set<string>(), todayStr: "2026-10-01", tz: "America/Los_Angeles", codesOn: true };
    expect(orderWhichJobChoices(common).map((o) => o.id)).toEqual([ARR, SUPPLY]);
    expect(orderWhichJobChoices({ ...common, excludeJobId: ARR }).map((o) => o.id)).toEqual([SUPPLY]);
  });

  it("with nothing else going, a move never claims the punch is on no job", () => {
    const empty = { ok: true as const, jobs: [], isStaff: false };
    const inMoment = sheetAfterLoad(empty, { confirmInline: false, moment: "in" });
    const move = sheetAfterLoad(empty, { confirmInline: false, moment: "move" });
    expect(inMoment).toEqual({ close: true, sentence: expect.stringContaining("saved on no job") });
    expect(move.close).toBe(true);
    expect((move as { sentence: string }).sentence).not.toContain("no job");
    expect((move as { sentence: string }).sentence).toContain("Leave it here");
  });
});

describe("PART 2 — the move is a checked write that moves the WHOLE punch", () => {
  /** The punch as the clock left it: open, on the app's pick, no code. */
  const onAppsPick = (over: { entry?: any; hit?: Reply } = {}) => (q: Q): Reply => {
    if (q.table === "time_entries" && q.verb === "select")
      return { data: over.entry ?? { id: PUNCH, job_id: ARR, job_code: null, status: "open", clock_out: null } };
    if (q.table === "time_entries" && q.verb === "update") return over.hit ?? { data: { id: PUNCH } };
    if (q.table === "organizations") return SETTINGS;
    if (q.table === "jobs" && q.cols.startsWith("id, status")) return { data: { id: SUPPLY, status: "in_progress", job_number: "J-020", name: "41 Larkspur", address: "41 Larkspur Dr", customers: { name: "Nora Smith" } } };
    if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1", status: "in_progress" } };
    if (q.table === "jobs" && q.verb === "update") return { data: [] };
  };

  it("one tap moves every hour of the punch, and the write names the job it is coming off", async () => {
    state.client = fakeSupabase(onAppsPick(), calls);
    const res = await putPunchOnJob(PUNCH, SUPPLY, ARR);
    expect(res).toMatchObject({ ok: true, label: "41 Larkspur" });

    const write = calls.find((c) => c.table === "time_entries" && c.verb === "update")!;
    expect(write.payload).toEqual({ job_id: SUPPLY });
    // The whole punch: the update touches the ENTRY, never its clock times, and never splits it.
    expect(has(write, "eq", "id", PUNCH)).toBe(true);
    expect(has(write, "eq", "profile_id", "user-1")).toBe(true);
    // NAMED ON THE WRITE: a punch that moved underneath is a zero-row UPDATE, not a second landing.
    expect(has(write, "eq", "job_id", ARR)).toBe(true);
    expect(has(write, "is", "job_id", null)).toBe(false);
    // The silent-write law.
    expect(write.returning).toBe("id");
  });

  it("a punch that moved underneath is reported, never assumed landed", async () => {
    state.client = fakeSupabase(onAppsPick({ hit: { data: null } }), calls);
    const res = await putPunchOnJob(PUNCH, SUPPLY, ARR);
    expect(res.ok).toBe(false);
    expect(res.stale).toBe(true);
    expect(res.error).toContain("Nothing changed");
  });

  it("a punch on some OTHER job is still the office's to move", async () => {
    state.client = fakeSupabase(onAppsPick({ entry: { id: PUNCH, job_id: "someone-else", job_code: null, status: "open", clock_out: null } }), calls);
    const res = await putPunchOnJob(PUNCH, SUPPLY, ARR);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Timecards");
    expect(calls.some((c) => c.table === "time_entries" && c.verb === "update")).toBe(false);
  });

  it("a job-less punch still goes through the same door, with no from-job and the old predicate", async () => {
    state.client = fakeSupabase(onAppsPick({ entry: { id: PUNCH, job_id: null, job_code: null, status: "open", clock_out: null } }), calls);
    expect((await putPunchOnJob(PUNCH, SUPPLY)).ok).toBe(true);
    const write = calls.find((c) => c.table === "time_entries" && c.verb === "update")!;
    expect(has(write, "is", "job_id", null)).toBe(true);
  });

  it("the sheet's list opens for a move, and refuses a punch whose job the screen got wrong", async () => {
    const listRoute = (jobId: string | null) => (q: Q): Reply => {
      if (q.table === "profiles") return { data: { role: "tech" } };
      if (q.table === "organizations") return SETTINGS;
      if (q.table === "time_entries" && q.cols === "id, job_id, status") return { data: { id: PUNCH, job_id: jobId, status: "open" } };
      if (q.table === "time_entries") return { data: null };
      if (q.table === "job_schedule_segments") return { data: [] };
      if (q.table === "jobs") return { data: [{ ...ARR_ROW, status: "in_progress", scheduled_start: null, scheduled_end: null, created_at: "2026-09-01T00:00:00Z" }] };
    };
    state.client = fakeSupabase(listRoute(ARR), calls);
    const moving = await whichJobChoices(PUNCH, ARR);
    expect(moving.ok).toBe(true);
    // The job it is on is not offered back to itself.
    expect(moving.ok && moving.jobs.map((j) => j.id)).toEqual([]);

    state.client = fakeSupabase(listRoute("another-job"), calls);
    const wrong = await whichJobChoices(PUNCH, ARR);
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.error).toContain("already on a job");
  });
});

describe("and then the schedule frees itself — why no migration is needed", () => {
  /**
   * THE LOOP THAT CLOSED ON ERIK. Brian's hours made ARR 56 a WORKED day, and moveJobDay keeps worked
   * days where they happened, so the job would not leave today when Erik went to move it. A punch the
   * app assigned pinned the schedule, and the pinned schedule made the punch look right.
   *
   * It unpins itself, because a job's worked days are DERIVED from its own time_entries on every read
   * (workedDaysFrom, called by workedDaysForJob with .eq("job_id", jobId) at every moveJobDay) — never
   * stored, so there is nothing to migrate and nothing to clean up. Move the punch and the day is no
   * longer one of that job's worked days.
   */
  const CLOCKED = "2026-10-01T17:54:00Z"; // 10:54 Pacific — Brian's punch
  const TZ = "America/Los_Angeles";

  it("the day stops being the wrong job's worked day the moment the punch leaves it", () => {
    // Before: ARR 56 holds the punch, so Oct 1 is a worked day on it and will not move.
    expect(workedDaysFrom([{ clock_in: CLOCKED }], [], TZ)).toEqual(["2026-10-01"]);
    // After the Change door moves the punch: ARR 56's own entries no longer include it.
    expect(workedDaysFrom([], [], TZ)).toEqual([]);
    // And the day is now a worked day on the job it really was.
    expect(workedDaysFrom([{ clock_in: CLOCKED }], [], TZ)).toEqual(["2026-10-01"]);
  });

  it("a visit somebody closed out as done pins the day on its own, punch or no punch", () => {
    // The one thing a move does NOT free: workedDaysFrom also counts a COMPLETED visit that day, so a
    // job with one keeps the day whatever happens to the hours. Said out loud here so nobody reads the
    // move as a general unpin.
    expect(workedDaysFrom([], [{ starts_at: CLOCKED, status: "completed" }], TZ)).toEqual(["2026-10-01"]);
    expect(workedDaysFrom([], [{ starts_at: CLOCKED, status: "scheduled" }], TZ)).toEqual([]);
  });
});

describe("PART 3 — the offline queue's replay says it too (Brian in the truck)", () => {
  it("a held punch that files onto a job the app chose says so when it lands", () => {
    const told = replayTold({ ok: true, id: PUNCH, jobPick: { chosenBy: "app", id: ARR, from: "schedule", label: "ARR 56 rough-in · 56 Alder Ridge Rd" } });
    expect(told.ask).toBeNull();
    expect(told.told!.sentence).toContain("ARR 56 rough-in · 56 Alder Ridge Rd");
    expect(told.told!.sentence).toContain("The app picked that");
    expect(told.said).toEqual([]);
    expect(told.retryable).toBe(false);
  });

  it("a held punch that files onto no job still asks, exactly as the live clock does", () => {
    const told = replayTold({ ok: true, id: PUNCH, noJob: true });
    expect(told.ask).toEqual({ entryId: PUNCH, moment: "in" });
    expect(told.told).toBeNull();
  });

  it("a held punch that files onto a job the PERSON had picked says nothing new", () => {
    const told = replayTold({ ok: true, id: PUNCH, jobPick: { chosenBy: "person", id: ARR } });
    expect(told.told).toBeNull();
    expect(told.ask).toBeNull();
  });

  it("what else the punch did still rides its own line, and a refusal time fixes is retried, not quarantined", () => {
    expect(replayTold({ ok: true, id: PUNCH, warning: "J-048 was on hold. It's off hold now." }).said).toEqual([
      "J-048 was on hold. It's off hold now.",
    ]);
    expect(replayTold({ ok: false, error: "Not signed in." }).retryable).toBe(true);
    expect(replayTold({ ok: false, error: "You're already clocked in." }).retryable).toBe(false);
    expect(replayTold({ ok: false, error: "You're already clocked in." }).told).toBeNull();
  });
});


// ── THE FIX PASS: the four doors where the sentence was still lost, or still a lie ────────────

/** A day with NOTHING on the schedule and exactly ONE job in progress: resolveTechJobToday tier 2,
 *  which has nothing to do with today's schedule and must not say that it has. */
const onlyOneJobGoing = (q: Q): Reply => {
  if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
  if (q.table === "profiles") return { data: { role: "tech" } };
  if (q.table === "organizations") return SETTINGS;
  if (q.table === "crew_day_assignments") return { data: null };
  if (q.table === "jobs" && q.filters.some((f) => f[0] === "contains")) return { data: [] };
  if (q.table === "jobs" && has(q, "eq", "status", "in_progress")) return { data: [{ id: ARR }] };
  if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1", status: "in_progress" } };
  if (q.table === "jobs" && q.verb === "update") return { data: [] };
  if (q.table === "jobs" && q.cols.startsWith("id, job_number")) return { data: ARR_ROW };
  if (q.table === "time_entries" && q.verb === "insert") return { data: { id: PUNCH } };
};

describe("the sentence names the source the resolver ACTUALLY used", () => {
  it("nothing on the schedule, one job going: it says why, and never points at an empty schedule", async () => {
    state.client = fakeSupabase(onlyOneJobGoing, calls);
    const res = await clockIn({ job_id: null, job_code: null, gps: null });

    expect(res.jobPick).toEqual({ chosenBy: "app", id: ARR, from: "only-job", label: "ARR 56 rough-in · 56 Alder Ridge Rd" });
    const told = tellAppChose(res)!;
    expect(told.sentence).toContain("because it's the only job going");
    // Opening the schedule to check would have found NOTHING there, which makes the one sentence
    // that has to be trusted about money look wrong.
    expect(told.sentence).not.toContain("today's schedule");
    // And it is still a door, not a dead end.
    expect(told.sentence).toContain("change it if you're somewhere else");
  });

  it("a day row still says the schedule, because the schedule is where it came from", async () => {
    state.client = fakeSupabase(schedulePutsHimOnArr(), calls);
    expect(tellAppChose(await clockIn({ job_id: null, job_code: null, gps: null }))!.sentence).toContain("from today's schedule");
  });

  it("a source that can't be known names none at all", () => {
    expect(appChoseSentence("41 Larkspur · 41 Larkspur Dr", "unknown")).toBe(
      "Your punch is on 41 Larkspur · 41 Larkspur Dr. The app picked that — change it if you're somewhere else.",
    );
  });
});

describe("Nort's door: the sentence reaches the MODEL, or nobody hears it at all", () => {
  const CTX: ActionCtx = { userId: "user-1", orgId: "org-1", role: "tech" };
  /** The projection the chat route hands the model, parsed back — Nort's entire knowledge of the
   *  write it just made (lib/actions/agent-tool-result). */
  const projected = (res: ActionResult) => JSON.parse(agentToolResultBody(res, null)) as Record<string, unknown>;

  it('"Nort, clock me in" on a job the app chose comes back SAYING so, in the projected body', async () => {
    state.client = fakeSupabase(schedulePutsHimOnArr(), calls);
    const res = await timeActions["time.clockIn"].handler({ job_id: null, job_code: null, clock_in_at: null }, CTX);

    // THE ONLY THING THAT MATTERS: what the model is actually handed. A field the allowlist does not
    // carry is dropped in silence, and Nort then answers "You're clocked in" for a punch on the
    // wrong customer — the one door in the app that cannot show a Change button.
    const body = projected(res);
    expect(String(body.warning)).toContain("ARR 56 rough-in · 56 Alder Ridge Rd");
    expect(String(body.warning)).toContain("The app picked that");
    expect(body.ok).toBe(true);
  });

  it("the punch's own news and the job it landed on both ride, neither one crowding the other out", async () => {
    // The job the schedule put him on was ON HOLD, and the punch took it off (NY-hold, 0366).
    state.client = fakeSupabase((q) => {
      if (q.table === "jobs" && q.cols.startsWith("org_id"))
        return { data: { org_id: "org-1", status: "on_hold", job_number: "J-013", name: "ARR 56 rough-in", hold_reason: "waiting on the permit" } };
      if (q.table === "jobs" && q.verb === "update") return { data: [{ id: ARR }] };
      return schedulePutsHimOnArr()(q);
    }, calls);
    const res = await timeActions["time.clockIn"].handler({ job_id: null, job_code: null, clock_in_at: null }, CTX);
    const warning = String(projected(res).warning);
    expect(warning).toContain("off hold");
    expect(warning).toContain("The app picked that");
  });

  it("a job the PERSON named says nothing new to the model either", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
      if (q.table === "profiles") return { data: { role: "owner" } };
      if (q.table === "jobs" && q.cols === "id") return { data: { id: ARR } };
      if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1", status: "in_progress" } };
      if (q.table === "jobs" && q.verb === "update") return { data: [] };
      if (q.table === "time_entries" && q.verb === "insert") return { data: { id: PUNCH } };
    }, calls);
    const res = await timeActions["time.clockIn"].handler({ job_id: ARR, job_code: null, clock_in_at: null }, CTX);
    expect(projected(res).warning).toBeUndefined();
  });

  /**
   * THE DOOR WITH NO BUTTON MUST NOT READ OUT THE BUTTON'S WORDS (Erik, 2026-10-01).
   *
   * Nort relayed the screens' sentence verbatim — "change it if you're somewhere else" — and could not
   * change it. His only move on a running shift is switch_job, which CUTS after two minutes: it closes
   * the part so far and opens a new one, so the minutes already billed to the wrong customer stay
   * exactly where they are. An instruction is a dead end when the door it names is not where it is read.
   *
   * NO NEW WRITE VERB WAS REGISTERED FOR HIM, on purpose: moving a punch decides which customer gets
   * billed, the three doors that already do it are one tap away, and agent-write expansion stays frozen
   * until multi-tenant is dialled. His sentence says WHERE, and says he cannot.
   */
  it("THE DEFECT: Nort's sentence never tells somebody to press a button he has not got", async () => {
    state.client = fakeSupabase(schedulePutsHimOnArr(), calls);
    const res = await timeActions["time.clockIn"].handler({ job_id: null, job_code: null, clock_in_at: null }, CTX);
    const warning = String(projected(res).warning);

    // Same facts: the job, named the way a person knows it, and the source it came from.
    expect(warning).toContain("ARR 56 rough-in · 56 Alder Ridge Rd");
    expect(warning).toContain("The app picked that from today's schedule");
    // But NOT the screens' instruction, which points at a button that is not in this conversation.
    expect(warning).not.toContain("change it if you're somewhere else");
    // It names the doors that actually move a punch, and it says out loud that he cannot.
    expect(warning).toContain("My Day");
    expect(warning).toContain("Timeclock");
    expect(warning).toContain("Timecards");
    expect(warning).toContain(CHANGE_JOB_LABEL);
    expect(warning).toContain("I can't move it for you");
  });

  it("and the screens keep their own words, because their button is right there", () => {
    expect(appChoseSentence("ARR 56 rough-in", "schedule")).toContain("change it if you're somewhere else");
    // One place builds both, off the same label and the same source, so they cannot drift.
    const told = tellAppChose({ ok: true, id: PUNCH, jobPick: { chosenBy: "app", id: ARR, from: "only-job", label: "ARR 56" } })!;
    expect(told.sentence).toContain("because it's the only job going");
    expect(told.say).toContain("because it's the only job going");
    expect(told.say).not.toBe(told.sentence);
  });

  /**
   * AND HE CANNOT ANNOUNCE A CORRECTION THAT DID NOT HAPPEN. The move he DOES have on a running shift
   * cuts it, so a "put me on the right job" answered with switch_job leaves the hours already worked
   * exactly where they were.
   */
  it("THE DEFECT, second half: a switch that CUT says where the hours before it stayed", () => {
    const said = switchJobSpoken("cut", 2.32, "J-013 ARR 56 rough-in · 56 Alder Ridge Rd");
    expect(said).toContain("2.32 hours");
    expect(said).toContain("stayed on J-013 ARR 56 rough-in · 56 Alder Ridge Rd");
    expect(said).toContain("it never moves hours already worked");
    expect(said).toContain("Timecards");
    // The old wording read as a correction: the part "closed", and you are on the new job. Nothing
    // in it said the 2.32 hours were still billing the wrong customer.
    expect(said).not.toMatch(/^Done/);
  });

  it("a switch that RE-POINTED really did move the whole shift, and keeps its own words", () => {
    expect(switchJobSpoken("repointed", 0, "J-013 ARR 56")).toBe("Done — this whole shift is on the new job now.");
  });

  it("the hours are never dropped, even when the job they stayed on could not be read", () => {
    const said = switchJobSpoken("cut", 0.75, null);
    expect(said).toContain("0.75 hours");
    expect(said).toContain("the job you were on");
  });

  it("the verb's own description tells the model it is not a way to correct a wrong job", () => {
    const d = timeActions["time.switchJob"].description ?? "";
    expect(d).toContain("NEVER MOVES HOURS ALREADY WORKED");
    expect(d).toContain("Timecards");
    expect(d).toMatch(/no verb that moves worked hours/i);
  });

  it("the projection carries every channel a write has to be heard on, and nothing else", () => {
    const body = projected({ ok: true, warning: "w", recorded: "r", speak: "s", data: { id: "x" }, confirmPrompt: "never shown" });
    expect(Object.keys(body).sort()).toEqual(["data", "error", "ok", "recorded", "speak", "warning"]);
  });
});

describe("the truck's held punch: a punch that already filed still says where it went", () => {
  /**
   * BRIAN WITH ONE BAR, NOT NONE. The live attempt REACHED the server and committed; the answer was
   * lost coming back. The card held the punch, and the drain replayed the same clientOpId — so
   * runOnce tripped the unique index and answered with its two-field stub. jobPick and noJob were
   * both gone, replayTold found nothing to say, and the drain filed the op as sent: the punch landed
   * on the app's job with not one word on screen.
   */
  const alreadyFiled = (over: { entry?: Reply } = {}) => (q: Q): Reply => {
    if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
    if (q.table === "client_operations" && q.verb === "insert")
      return { error: { code: "23505", message: 'duplicate key value violates unique constraint "client_operations_org_op"' } };
    if (q.table === "client_operations") return { data: { result_id: PUNCH } };
    if (q.table === "time_entries" && q.cols === "job_id, job_code") return over.entry ?? { data: { job_id: ARR, job_code: null } };
    if (q.table === "organizations") return SETTINGS;
    if (q.table === "jobs" && q.cols.startsWith("id, job_number")) return { data: ARR_ROW };
  };

  it("the duplicate claim still names the job, and the replay says it with the Change door", async () => {
    state.client = fakeSupabase(alreadyFiled(), calls);
    const res = await clockIn({ job_id: null, job_code: null, gps: null, clientOpId: "op-1" });

    expect(res.ok).toBe(true);
    expect(res.id).toBe(PUNCH);
    // Nobody picked this job: the call named none, so whatever the entry carries is the app's.
    expect(res.jobPick).toEqual({ chosenBy: "app", id: ARR, from: "unknown", label: "ARR 56 rough-in · 56 Alder Ridge Rd" });
    // And the drain's own door — the one that matters most — now has something to put on screen.
    const told = replayTold(res);
    expect(told.told!.sentence).toContain("ARR 56 rough-in · 56 Alder Ridge Rd");
    expect(changeJobAsk(told.told!)).toEqual({ entryId: PUNCH, moment: "move", from: { id: ARR, label: "ARR 56 rough-in · 56 Alder Ridge Rd" } });
    // WHICH tier picked is genuinely gone with the lost answer, so the sentence names no source.
    expect(told.told!.sentence).not.toContain("schedule");
    // The punch is NOT written a second time: this is the exactly-once path, still exactly once.
    expect(calls.some((c) => c.table === "time_entries" && c.verb === "insert")).toBe(false);
  });

  it("the same punch on NO job still asks, exactly as it would have the first time", async () => {
    state.client = fakeSupabase(alreadyFiled({ entry: { data: { job_id: null, job_code: null } } }), calls);
    const res = await clockIn({ job_id: null, job_code: null, gps: null, clientOpId: "op-1" });
    expect(res.noJob).toBe(true);
    expect(replayTold(res).ask).toEqual({ entryId: PUNCH, moment: "in" });
    expect(replayTold(res).told).toBeNull();
  });

  it("a punch the person named, or filed under a time code, is not second-guessed and costs no read", async () => {
    state.client = fakeSupabase(alreadyFiled(), calls);
    const named = await clockIn({ job_id: ARR, job_code: null, gps: null, clientOpId: "op-2" });
    expect(named).toEqual({ ok: true, id: PUNCH });
    expect(replayTold(named).told).toBeNull();
    expect(calls.some((c) => c.cols === "job_id, job_code")).toBe(false);

    calls = [];
    state.client = fakeSupabase(alreadyFiled(), calls);
    const coded = await clockIn({ job_id: null, job_code: "SHOP", gps: null, clientOpId: "op-3" });
    expect(coded.noJob).toBeUndefined();
    expect(calls.some((c) => c.cols === "job_id, job_code")).toBe(false);
  });

  it("an entry that can't be read leaves the punch saved — a failed read is never a refusal", async () => {
    state.client = fakeSupabase(alreadyFiled({ entry: { data: null } }), calls);
    const res = await clockIn({ job_id: null, job_code: null, gps: null, clientOpId: "op-1" });
    expect(res).toEqual({ ok: true, id: PUNCH });
  });
});

describe("the move path never tells a man his hours are on no job", () => {
  const FROM = { label: "ARR 56 rough-in · 56 Alder Ridge Rd" };
  const MOVE = { moment: "move" as const, from: FROM };
  const row = { id: SUPPLY, label: "41 Larkspur" };

  it("the sheet with nothing else going, RENDERED: the one door that shows an empty list", () => {
    // Reachable only where there is no toast to close onto — the offline queue (confirmInline), the
    // brief's most important door. sheetAfterLoad keeps the sheet open, and the view draws the list.
    const loaded = sheetAfterLoad({ ok: true, jobs: [], isStaff: false }, { confirmInline: true, moment: "move" });
    expect(loaded.close).toBe(false);
    const html = renderToStaticMarkup(
      createElement(WhichJobSheetView, {
        moment: "move" as const,
        from: { id: ARR, label: FROM.label },
        state: (loaded as { state: SheetPhase }).state,
        onPick: () => {},
        onSkip: () => {},
      }),
    );
    // His 2h19m IS on ARR 56, and the sheet had just said so one line above.
    expect(html).not.toContain("on no job");
    expect(html).toContain("ARR 56 rough-in");
    expect(html).toContain("no other job going right now");
    expect(html).toContain("Leave It Where It Is");
  });

  it("the ask's empty list keeps its own true words", () => {
    const loaded = sheetAfterLoad({ ok: true, jobs: [], isStaff: false }, { confirmInline: true, moment: "in" });
    const html = renderToStaticMarkup(
      createElement(WhichJobSheetView, {
        moment: "in" as const,
        state: (loaded as { state: SheetPhase }).state,
        onPick: () => {},
        onSkip: () => {},
      }),
    );
    expect(html).toContain("saved on no job");
  });

  it("a pick that drops on the drive says where the punch still is — not that it is on nothing", async () => {
    const dead = async () => {
      throw new Error("offline");
    };
    const out = await pickOutcome(dead, PUNCH, row, MOVE);
    expect(out.kind).toBe("refused");
    expect(out.sentence).toContain(`still on ${FROM.label}`);
    expect(out.sentence).not.toContain("no job");
    // A move's way out is "Leave It Where It Is": there is no Skip to point at.
    expect(out.sentence).not.toContain("skip");
  });

  it("a refusal with no words of its own says it too", async () => {
    const out = await pickOutcome(async () => ({ ok: false }), PUNCH, row, MOVE);
    expect(out.sentence).toBe(`That didn't go through. Your punch is saved, still on ${FROM.label}.`);
  });

  it("the ask's own failures are unchanged: that punch really is on no job", async () => {
    const dead = async () => {
      throw new Error("offline");
    };
    expect((await pickOutcome(dead, PUNCH, row)).sentence).toContain("still on no job");
    expect((await pickOutcome(dead, PUNCH, row)).sentence).toContain("or skip");
    expect((await pickOutcome(async () => ({ ok: false }), PUNCH, row)).sentence).toContain("still on no job");
    expect(punchStillOn({ moment: "out" })).toBe("still on no job");
  });

  it("a list that doesn't load says where the punch is, and never promises the office will pick it", () => {
    const move = jobsDidntLoadSentence(MOVE);
    expect(move).toContain(`still on ${FROM.label}`);
    expect(move).toContain("Timecards");
    expect(move).not.toContain("the office will put");
    expect(jobsDidntLoadSentence({ moment: "in" })).toContain("the office will put it on its job");
  });

  it("and the READ behind the sheet says the same, through the real action", async () => {
    const readFails = (jobId: string | null) => (q: Q): Reply => {
      if (q.table === "profiles") return { data: { role: "tech" } };
      if (q.table === "organizations") return SETTINGS;
      if (q.table === "time_entries" && q.cols === "id, job_id, status") return { data: { id: PUNCH, job_id: jobId, status: "open" } };
      if (q.table === "time_entries") return { data: null };
      if (q.table === "job_schedule_segments") return { data: [] };
      if (q.table === "jobs" && has(q, "eq", "status", "in_progress")) return { error: { message: "boom" } };
      if (q.table === "jobs") return { data: [] };
    };
    state.client = fakeSupabase(readFails(ARR), calls);
    const moving = await whichJobChoices(PUNCH, ARR);
    expect(moving.ok).toBe(false);
    // A punch that already carries a job is not in Hours On No Job, so the office is never prompted:
    // telling him they will is the same lie as "still on no job", one door along.
    expect(moving.ok === false && moving.error).toBe(choicesUnavailable(true));
    expect(moving.ok === false && moving.error).not.toContain("the office will put");

    state.client = fakeSupabase(readFails(null), calls);
    const asking = await whichJobChoices(PUNCH);
    expect(asking.ok === false && asking.error).toContain("the office will put this punch on its job");
  });
});

describe("the sentence retires itself the moment the person answers it another way", () => {
  /**
   * A SWITCH JOB *IS* THE ANSWER, and the Timeclock panel kept the line on screen anyway: the banner
   * read the new job while the box below still said "Your punch is on ARR 56 — the app picked that",
   * offering Change The Job for a piece the person had already left. Over 0288's two minutes a switch
   * CUTS, so that door pointed at the closed pre-switch stub; inside them it re-points whole, so the
   * same door dead-ended on "This punch is already on a job."
   *
   * Fixed by DERIVING it instead of remembering to clear it: the line shows only while the punch on
   * screen is the one it is about and still carries the job it names.
   */
  const notice = tellAppChose({ ok: true, id: PUNCH, jobPick: { chosenBy: "app", id: ARR, from: "schedule", label: "ARR 56 rough-in" } })!;

  it("while the punch is still the one it is about, on the job it names, it stays", () => {
    expect(noticeForEntry(notice, { id: PUNCH, job_id: ARR })).toBe(notice);
  });

  it("a Switch Job that CUT: the clock is on a new entry, so the line about the old one goes", () => {
    expect(noticeForEntry(notice, { id: "b0000000-0000-4000-8000-00000000000b", job_id: SUPPLY })).toBeNull();
  });

  it("a Switch Job that RE-POINTED: same punch, different job, so the sentence is no longer true", () => {
    expect(noticeForEntry(notice, { id: PUNCH, job_id: SUPPLY })).toBeNull();
  });

  it("the office moved it from Timecards while the page sat open — onto a job, or off one", () => {
    expect(noticeForEntry(notice, { id: PUNCH, job_id: "someone-else" })).toBeNull();
    expect(noticeForEntry(notice, { id: PUNCH, job_id: null })).toBeNull();
  });

  it("the shift ended: no punch on screen, no line about one", () => {
    expect(noticeForEntry(notice, null)).toBeNull();
    expect(noticeForEntry(null, { id: PUNCH, job_id: ARR })).toBeNull();
  });
});

/**
 * THE RULE MOVED INTO THE COMPONENT, because a door opted out of it (Erik's law: one rule, one
 * place, and unbypassable — a shared helper the next door can forget to call is a convention).
 *
 * My Day's Now card asked nothing: it rendered the remembered line raw as `notice={chose}`. So when
 * the office re-pointed the punch from Timecards while My Day sat open, the card's banner updated to
 * the new job while the sentence under it still named the old one — and its Change door then refused
 * as stale ("This punch already carries a job"). The card could not ask the rule as it stood, because
 * NowPunch carried `onJob: boolean` instead of the job's id: the shape itself hid the fact the rule
 * needs. Fixed at the shape, not around it.
 *
 * Now the ONE component every clock door draws takes the punch it is about and asks the rule itself,
 * so there is nothing left for a door to skip. `punch` is REQUIRED — a new door cannot render the
 * line without saying which punch it is about, or declaring (NO_PUNCH_ON_SCREEN) that it has none,
 * which is the shell's offline queue: the punch it reports landed hours after the tap and it holds no
 * live entry to check against.
 */
describe("the line is drawn by the rule, not by what a door remembered", () => {
  const told = tellAppChose({ ok: true, id: PUNCH, jobPick: { chosenBy: "app", id: ARR, from: "schedule", label: "ARR 56 rough-in" } })!;
  const draw = (punch: unknown) =>
    renderToStaticMarkup(createElement(AppChoseJobNotice, { notice: told, punch, onDone: () => {} } as never));

  it("while the punch on screen is the one it is about, on the job it names, the line is drawn", () => {
    expect(draw({ id: PUNCH, job_id: ARR })).toContain("ARR 56 rough-in");
  });

  it("THE DEFECT: the office moved the punch while the page sat open — the line goes, not the sentence's word", () => {
    expect(draw({ id: PUNCH, job_id: SUPPLY })).toBe("");
    expect(draw({ id: PUNCH, job_id: null })).toBe("");
  });

  it("a Switch Job that CUT: the clock is on a new entry, so nothing is said about the old one", () => {
    expect(draw({ id: "b0000000-0000-4000-8000-00000000000b", job_id: ARR })).toBe("");
  });

  it("the shift ended: no punch on screen, no line", () => {
    expect(draw(null)).toBe("");
  });

  it("the one door with no punch in its hands says so, and still gets to speak", () => {
    expect(draw(NO_PUNCH_ON_SCREEN)).toContain("ARR 56 rough-in");
  });
});

// ── PART 4 — the teeth ───────────────────────────────────────────────────────────────────────
//
// Two DELIBERATE source greps, and they are the only two: a door that handles a clock answer without
// calling the one rule, or a door that writes the rule again, is exactly the failure this whole fix
// is about, and neither can be caught by exercising that door — the symptom is SILENCE.

const SRC = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/** Every door that handles the answer to a punch. The Now card, the Timeclock page, the shell's
 *  offline queue, and Nort — found by what they import, then pinned here so a new one has to be
 *  added on purpose rather than quietly skipping the sentence. */
const CLOCK_DOORS = [
  "app/(app)/planner/now-card.tsx",
  "app/(app)/timeclock/timeclock-panel.tsx",
  "components/offline-drain.tsx",
  "lib/actions/entities/time.ts",
];

describe("PART 4 — teeth: no clock door may report a resolved job without saying so", () => {
  it("every door that handles a punch's answer calls the ONE rule that decides what to say", () => {
    for (const door of CLOCK_DOORS) {
      const src = read(door);
      expect(src, `${door} must ask clock-told what to say`).toMatch(/from "[^"]*clock-told"/);
      expect(src, `${door} must call tellAppChose or replayTold`).toMatch(/\b(tellAppChose|replayTold)\(/);
    }
  });

  it("a door that ASKS about a no-job punch must also TELL about an app-chosen one: the rules are siblings", () => {
    const files = allSources().filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
    const asks = files.filter((f) => /\baskAfterPunch\(/.test(read(f)) && !f.endsWith("which-job-choices.ts") && !f.endsWith("clock-told.ts"));
    expect(asks.length).toBeGreaterThan(0);
    for (const f of asks) {
      expect(read(f), `${f} asks about a no-job punch, so it must say something about an app-chosen one`).toMatch(
        /\b(tellAppChose|replayTold)\(/,
      );
    }
  });

  it("EVERY door that draws the line names the punch it is about — the list is found, not written", () => {
    // DELIBERATE TRIPWIRE, and the third of only three. It used to name ONE door, the Timeclock panel,
    // and the Now card was quietly outside it — which is how `notice={chose}` shipped there. So the
    // doors are FOUND: every app source that draws the component. Each must hand it the punch, which
    // the component checks the sentence against; a door with none in its hands has to say so by name.
    const doors = allSources()
      .filter((f) => !/\.(test|test-util)\.tsx?$/.test(f) && !f.endsWith("app-chose-notice.tsx"))
      .filter((f) => /<AppChoseJobNotice\b/.test(codeOnly(read(f))));
    // An empty scan can never pass: these are the three doors that draw it today.
    expect(doors.sort()).toEqual([
      "app/(app)/planner/now-card.tsx",
      "app/(app)/timeclock/timeclock-panel.tsx",
      "components/offline-drain.tsx",
    ]);
    for (const door of doors) {
      const src = codeOnly(read(door));
      expect(src, `${door} draws the line, so it must hand the component the punch it is about (or NO_PUNCH_ON_SCREEN)`).toMatch(
        /<AppChoseJobNotice[\s\S]{0,200}?punch=\{/,
      );
    }
  });

  it("and no door re-words the staleness rule for itself: it asks noticeForEntry or hands over the punch", () => {
    for (const f of allSources()) {
      if (f.endsWith("clock-told.ts") || f.endsWith("clock-told.test.ts")) continue;
      const src = codeOnly(read(f));
      // Comparing a notice's entry or its job to a punch's by hand IS the rule, written again.
      expect(src, `${f}: re-tests whether the notice is still about the punch on screen`).not.toMatch(
        /notice\.(entryId|job)\b[^\n]*(===|!==)/,
      );
    }
  });

  it("nobody writes the rule twice: the sentence and the \"did the app choose this\" test live in one file", () => {
    const offenders: string[] = [];
    for (const f of allSources()) {
      if (f.endsWith("clock-told.ts") || f.endsWith("clock-told.test.ts")) continue;
      const src = read(f);
      // Re-deriving the rule: comparing chosenBy to a string anywhere but the one module.
      if (/chosenBy\s*[=!]==?\s*["']/.test(src)) offenders.push(`${f}: re-tests chosenBy`);
      // Re-wording the sentence: a second copy drifts, and then two doors say different things.
      if (/The app picked that/.test(src)) offenders.push(`${f}: a second copy of the sentence`);
    }
    expect(offenders).toEqual([]);
  });
});

/** Every .ts/.tsx file under src, relative to it. */
function allSources(dir = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(SRC, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...allSources(rel));
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}
