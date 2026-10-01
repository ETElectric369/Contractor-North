import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE CLOCK SAYS WHICH JOB IT PUT YOUR PUNCH ON (Erik, 2026-10-01).
 *
 * "we didn't do the job at TTP 56 this morning. Brian clocked in on his way to the Supply house to
 * get materials for Whitney before I could switch the schedule." Two punches landed on the job the
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
import { askAfterPunch, orderWhichJobChoices, sheetAfterLoad, type ChoiceJob } from "./which-job-choices";
import { workedDaysFrom } from "@/lib/schedule-math";
import { WhichJobSheetView } from "../planner/which-job";
import { AppChoseJobNotice } from "./app-chose-notice";

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
const TTP = "d0000000-0000-4000-8000-00000000000d";
const SUPPLY = "e0000000-0000-4000-8000-00000000000e";
const SETTINGS = { data: { settings: { timezone: "America/Los_Angeles", timeclock_job_codes: true } } };

/** The job row the label read brings back: Erik's own morning, named the way he names jobs. */
const TTP_ROW = { id: TTP, job_number: "J-013", name: "TTP 56 rough-in", address: "56 Timber Trail Pl", customers: { name: "Jackie Burks" } };

/**
 * BRIAN'S MORNING. The schedule puts him on TTP 56 today (the office's day row, tier 0), he taps the
 * one Clock In button, and the punch carries no job of its own.
 */
const schedulePutsHimOnTtp =
  (over: { jobRow?: Reply; insert?: Reply } = {}) =>
  (q: Q): Reply => {
    if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
    if (q.table === "profiles") return { data: { role: "tech" } };
    if (q.table === "organizations") return SETTINGS;
    if (q.table === "crew_day_assignments") return { data: { job_id: TTP, kind: "job" } };
    // The day row's job is still in flight (resolveTechJobToday tier 0's own check).
    if (q.table === "jobs" && q.cols === "id") return { data: { id: TTP } };
    // The promotion's read (lib/job-promote), then its write.
    if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1", status: "scheduled" } };
    if (q.table === "jobs" && q.verb === "update") return { data: [] };
    // The LABEL read: what the sentence names.
    if (q.table === "jobs" && q.cols.startsWith("id, job_number")) return over.jobRow ?? { data: TTP_ROW };
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
    state.client = fakeSupabase(schedulePutsHimOnTtp(), calls);
    const res = await clockIn({ job_id: null, job_code: null, gps: null });

    expect(res.ok).toBe(true);
    expect(res.id).toBe(PUNCH);
    // THE HONEST SHAPE: who chose it is its own fact, not something inferred from job_id being set.
    expect(res.jobPick).toEqual({ chosenBy: "app", id: TTP, label: "TTP 56 rough-in · 56 Timber Trail Pl" });

    const told = tellAppChose(res);
    expect(told).not.toBeNull();
    expect(told!.entryId).toBe(PUNCH);
    expect(told!.job).toEqual({ id: TTP, label: "TTP 56 rough-in · 56 Timber Trail Pl" });
    // The sentence a person sees: plain words, the job named, and it says who picked it.
    expect(told!.sentence).toBe(
      "Your punch is on TTP 56 rough-in · 56 Timber Trail Pl. The app picked that from today's schedule — change it if you're somewhere else.",
    );
    // The punch still landed before any of this: the clock never waits on the sentence.
    const insert = calls.find((c) => c.verb === "insert")!;
    expect(insert.payload).toMatchObject({ job_id: TTP, status: "open" });
    expect(insert.returning).toBe("id");
    expect(calls.indexOf(insert)).toBeLessThan(calls.findIndex((c) => c.cols.startsWith("id, job_number")));
  });

  it("a punch whose job the PERSON picked says nothing new — they already know", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
      if (q.table === "profiles") return { data: { role: "owner" } };
      if (q.table === "jobs" && q.cols === "id") return { data: { id: TTP } };
      if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1", status: "scheduled" } };
      if (q.table === "jobs" && q.verb === "update") return { data: [] };
      if (q.table === "time_entries" && q.verb === "insert") return { data: { id: PUNCH } };
    }, calls);
    const res = await clockIn({ job_id: TTP, job_code: null, gps: null });

    expect(res.jobPick).toEqual({ chosenBy: "person", id: TTP });
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
      schedulePutsHimOnTtp({ insert: { error: { code: "23505", message: 'duplicate key value violates unique constraint "one_open_entry"' } } }),
      calls,
    );
    const res = await clockIn({ job_id: null, job_code: null, gps: null });
    expect(res.ok).toBe(false);
    expect(tellAppChose(res)).toBeNull();
  });

  it("a job whose own row couldn't be read is still said out loud — silence is the one wrong answer", async () => {
    state.client = fakeSupabase(schedulePutsHimOnTtp({ jobRow: { data: null } }), calls);
    const res = await clockIn({ job_id: null, job_code: null, gps: null });
    expect(res.jobPick).toEqual({ chosenBy: "app", id: TTP, label: UNREAD_JOB_LABEL });
    expect(tellAppChose(res)!.sentence).toContain(UNREAD_JOB_LABEL);
  });

  it("the rule reads the ANSWER, not the shape of it: no id, not ok, or no pick tells nothing", () => {
    const pick = { chosenBy: "app" as const, id: TTP, label: "TTP 56" };
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
    expect(punchJobLabel(job({ name: "TTP 56 rough-in", address: "56 Timber Trail Pl" }), true)).toBe("TTP 56 rough-in · 56 Timber Trail Pl");
  });

  it("a name that already carries the street doesn't say it twice", () => {
    expect(punchJobLabel(job({ name: "13631 Northwoods — Garage Subpanel", address: "13631 Northwoods" }), true)).toBe(
      "13631 Northwoods — Garage Subpanel",
    );
  });

  it("codes off: the Timeclock's own label — customer · street", () => {
    expect(punchJobLabel(job({ name: "TTP 56 rough-in", address: "56 Timber Trail Pl", customers: { name: "Jackie Burks" } }), false)).toBe(
      "Jackie Burks · 56 Timber Trail Pl",
    );
  });

  it("a job nobody named still says where it is, so the number is never alone (Erik: \"i cant tell by job numbers alone\")", () => {
    const label = punchJobLabel(job({ address: "5659 Rhodesia" }), true);
    expect(label).toBe("J-013 · 5659 Rhodesia");
    expect(appChoseSentence(label)).toContain("5659 Rhodesia");
    expect(label).not.toBe("J-013");
  });
});

describe("PART 2 — one tap to change it, and it is not a dead end", () => {
  it("the Change door opens the clock's own sheet, in move mode, off the job the app chose", () => {
    const told = tellAppChose({ ok: true, id: PUNCH, jobPick: { chosenBy: "app", id: TTP, label: "TTP 56" } })!;
    expect(changeJobAsk(told)).toEqual({ entryId: PUNCH, moment: "move", from: { id: TTP, label: "TTP 56" } });
  });

  it("the sentence carries the Change door, and both are rendered by every clock door's one component", () => {
    const told = tellAppChose({ ok: true, id: PUNCH, jobPick: { chosenBy: "app", id: TTP, label: "TTP 56 rough-in · 56 Timber Trail Pl" } })!;
    const html = renderToStaticMarkup(createElement(AppChoseJobNotice, { notice: told, onDone: () => {} }));
    expect(html).toContain("TTP 56 rough-in · 56 Timber Trail Pl");
    expect(html).toContain("The app picked that from today&#x27;s schedule");
    expect(html).toContain(CHANGE_JOB_LABEL);
    // Title Case, 44px, and NOT a modal: the clock stays two buttons.
    expect(CHANGE_JOB_LABEL).toBe("Change The Job");
    expect(html).toContain("min-h-11");
    expect(html).not.toContain("role=\"dialog\"");
  });

  it("nothing to say, nothing rendered: a person-picked punch puts no line on the card", () => {
    expect(renderToStaticMarkup(createElement(AppChoseJobNotice, { notice: null, onDone: () => {} }))).toBe("");
  });

  it("the sheet in move mode names the job it is moving the punch OFF, and its way out is not a lie", () => {
    const html = renderToStaticMarkup(
      createElement(WhichJobSheetView, {
        moment: "move" as const,
        from: { id: TTP, label: "TTP 56 rough-in" },
        state: { phase: "ready" as const, jobs: [{ id: SUPPLY, label: "85 Whitney" }], isStaff: false },
        onPick: () => {},
        onSkip: () => {},
      }),
    );
    expect(html).toContain("The app put this punch on TTP 56 rough-in");
    expect(html).toContain("the whole punch moves");
    expect(html).toContain("Leave It Where It Is");
    // "Skip, The Office Will Pick" would be a lie: the punch already has a job.
    expect(html).not.toContain("Skip, The Office Will Pick");
  });

  it("the sheet never offers the job the punch is already on", () => {
    const jobs: ChoiceJob[] = [
      { id: TTP, name: "TTP 56 rough-in", status: "in_progress", created_at: "2026-09-01T00:00:00Z" },
      { id: SUPPLY, name: "85 Whitney", status: "in_progress", created_at: "2026-09-02T00:00:00Z" },
    ];
    const common = { jobs, lastJobId: TTP, segToday: new Set([TTP]), hasSegments: new Set<string>(), todayStr: "2026-10-01", tz: "America/Los_Angeles", codesOn: true };
    expect(orderWhichJobChoices(common).map((o) => o.id)).toEqual([TTP, SUPPLY]);
    expect(orderWhichJobChoices({ ...common, excludeJobId: TTP }).map((o) => o.id)).toEqual([SUPPLY]);
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
      return { data: over.entry ?? { id: PUNCH, job_id: TTP, job_code: null, status: "open", clock_out: null } };
    if (q.table === "time_entries" && q.verb === "update") return over.hit ?? { data: { id: PUNCH } };
    if (q.table === "organizations") return SETTINGS;
    if (q.table === "jobs" && q.cols.startsWith("id, status")) return { data: { id: SUPPLY, status: "in_progress", job_number: "J-020", name: "85 Whitney", address: "85 Whitney Dr", customers: { name: "Nora Smith" } } };
    if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1", status: "in_progress" } };
    if (q.table === "jobs" && q.verb === "update") return { data: [] };
  };

  it("one tap moves every hour of the punch, and the write names the job it is coming off", async () => {
    state.client = fakeSupabase(onAppsPick(), calls);
    const res = await putPunchOnJob(PUNCH, SUPPLY, TTP);
    expect(res).toMatchObject({ ok: true, label: "85 Whitney" });

    const write = calls.find((c) => c.table === "time_entries" && c.verb === "update")!;
    expect(write.payload).toEqual({ job_id: SUPPLY });
    // The whole punch: the update touches the ENTRY, never its clock times, and never splits it.
    expect(has(write, "eq", "id", PUNCH)).toBe(true);
    expect(has(write, "eq", "profile_id", "user-1")).toBe(true);
    // NAMED ON THE WRITE: a punch that moved underneath is a zero-row UPDATE, not a second landing.
    expect(has(write, "eq", "job_id", TTP)).toBe(true);
    expect(has(write, "is", "job_id", null)).toBe(false);
    // The silent-write law.
    expect(write.returning).toBe("id");
  });

  it("a punch that moved underneath is reported, never assumed landed", async () => {
    state.client = fakeSupabase(onAppsPick({ hit: { data: null } }), calls);
    const res = await putPunchOnJob(PUNCH, SUPPLY, TTP);
    expect(res.ok).toBe(false);
    expect(res.stale).toBe(true);
    expect(res.error).toContain("Nothing changed");
  });

  it("a punch on some OTHER job is still the office's to move", async () => {
    state.client = fakeSupabase(onAppsPick({ entry: { id: PUNCH, job_id: "someone-else", job_code: null, status: "open", clock_out: null } }), calls);
    const res = await putPunchOnJob(PUNCH, SUPPLY, TTP);
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
      if (q.table === "jobs") return { data: [{ ...TTP_ROW, status: "in_progress", scheduled_start: null, scheduled_end: null, created_at: "2026-09-01T00:00:00Z" }] };
    };
    state.client = fakeSupabase(listRoute(TTP), calls);
    const moving = await whichJobChoices(PUNCH, TTP);
    expect(moving.ok).toBe(true);
    // The job it is on is not offered back to itself.
    expect(moving.ok && moving.jobs.map((j) => j.id)).toEqual([]);

    state.client = fakeSupabase(listRoute("another-job"), calls);
    const wrong = await whichJobChoices(PUNCH, TTP);
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.error).toContain("already on a job");
  });
});

describe("and then the schedule frees itself — why no migration is needed", () => {
  /**
   * THE LOOP THAT CLOSED ON ERIK. Brian's hours made TTP 56 a WORKED day, and moveJobDay keeps worked
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
    // Before: TTP 56 holds the punch, so Oct 1 is a worked day on it and will not move.
    expect(workedDaysFrom([{ clock_in: CLOCKED }], [], TZ)).toEqual(["2026-10-01"]);
    // After the Change door moves the punch: TTP 56's own entries no longer include it.
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
    const told = replayTold({ ok: true, id: PUNCH, jobPick: { chosenBy: "app", id: TTP, label: "TTP 56 rough-in · 56 Timber Trail Pl" } });
    expect(told.ask).toBeNull();
    expect(told.told!.sentence).toContain("TTP 56 rough-in · 56 Timber Trail Pl");
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
    const told = replayTold({ ok: true, id: PUNCH, jobPick: { chosenBy: "person", id: TTP } });
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
