import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * createTask's duplicate check (0358). A Reminder is private to its maker and its person, so a
 * same-title Reminder only collapses onto one the caller can see: on a database without 0358 the
 * read was company-wide, and a teammate's Reminder answered "Already on the list" and saved nothing.
 */

type Q = { table: string; verb: string; ors: string[]; eqs: [string, unknown][]; iss: [string, unknown][] };
const state = vi.hoisted(() => ({ client: null as any, queries: [] as any[], dup: null as any, jobStatus: "in_progress" as string }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createTask, toggleTask, updateTask } from "./actions";
import { dict } from "@/lib/i18n";

function fake() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-brian" } } }) },
    from(table: string) {
      const q: Q = { table, verb: "select", ors: [], eqs: [], iss: [] };
      state.queries.push(q);
      const answer = () => {
        if (table === "jobs") return { data: { id: "job-1", status: state.jobStatus }, error: null };
        if (q.verb === "insert") return { data: { id: "new-task" }, error: null };
        // A step's parent, a task on job-1.
        if (table === "tasks" && q.eqs.some(([c, v]) => c === "id" && v === "parent-1")) return { data: { job_id: "job-1" }, error: null };
        // updateTask's read of the task being moved: on job-1 already, or on another job.
        if (table === "tasks" && q.eqs.some(([c, v]) => c === "id" && v === "on-job-1")) return { data: { job_id: "job-1" }, error: null };
        if (table === "tasks" && q.eqs.some(([c, v]) => c === "id" && v === "on-job-2")) return { data: { job_id: "job-2" }, error: null };
        return { data: state.dup, error: null };
      };
      const chain: any = {
        select: () => chain,
        insert: () => ((q.verb = "insert"), chain),
        // updateTask's write: .update(clean).eq("id", id).select("id"), answered as one row changed.
        update: () => {
          q.verb = "update";
          const w: any = { eq: (c: string, v: unknown) => (q.eqs.push([c, v]), w), select: async () => ({ data: [{ id: "task-1" }], error: null }) };
          return w;
        },
        eq: (c: string, v: unknown) => (q.eqs.push([c, v]), chain),
        is: (c: string, v: unknown) => (q.iss.push([c, v]), chain),
        or: (f: string) => (q.ors.push(f), chain),
        gte: () => chain,
        ilike: () => chain,
        limit: () => chain,
        single: async () => answer(),
        maybeSingle: async () => answer(),
      };
      return chain;
    },
  };
}

const dupRead = () => state.queries.find((q) => q.table === "tasks" && q.verb === "select") as Q;

describe("createTask's duplicate check", () => {
  beforeEach(() => {
    state.queries = [];
    state.dup = null;
    state.jobStatus = "in_progress";
    state.client = fake();
  });

  it("a Reminder's check is cut to the caller's own (made by them, or for them)", async () => {
    const res = await createTask({ title: "Order breakers" });
    expect(res).toMatchObject({ ok: true, id: "new-task" });
    expect(dupRead().ors).toEqual(["created_by.eq.user-brian,assigned_to.eq.user-brian"]);
    expect(dupRead().iss).toContainEqual(["job_id", null]);
  });

  it("a job's task checks the whole job's list (the crew works one list)", async () => {
    await createTask({ title: "Hang the panel", job_id: "job-1" });
    expect(dupRead().ors).toEqual([]);
    expect(dupRead().eqs).toContainEqual(["job_id", "job-1"]);
  });
});

/**
 * toggleTask's cascade, and the Undo that takes it back (the 10-second toast on the job's card and
 * My Day's Now card). A check-off of a task with open steps closes them with it; its Undo must reopen
 * exactly the steps that check-off closed, never one that was already done. A tiny in-memory tasks
 * table stands in for the database: each write's filters are applied for real, a "locked" row is
 * one RLS won't let this caller change, and the log keeps every query in order.
 */
type Row = { id: string; status: "open" | "done"; parent_id: string | null };
type W = { verb: "select" | "update"; patch?: Partial<Row>; filters: ["eq" | "in", string, unknown][] };

function tasksTable(rows: Row[], opt: { locked?: string[]; beforeUpdate?: (db: Map<string, Row>, w: W) => void } = {}) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  const log: W[] = [];
  const hits = (w: W) =>
    [...db.values()].filter((r) =>
      w.filters.every(([op, c, v]) => (op === "eq" ? (r as any)[c] === v : (v as unknown[]).includes((r as any)[c]))),
    );
  const answer = (w: W) => {
    if (w.verb === "update") {
      opt.beforeUpdate?.(db, w);
      const changed = hits(w).filter((r) => !opt.locked?.includes(r.id));
      for (const r of changed) Object.assign(r, w.patch);
      return { data: changed.map((r) => ({ id: r.id })), error: null };
    }
    return { data: hits(w).map((r) => ({ id: r.id })), error: null };
  };
  const client = {
    from() {
      const w: W = { verb: "select", filters: [] };
      log.push(w);
      const chain: any = {
        select: () => chain,
        update: (patch: Partial<Row>) => ((w.verb = "update"), (w.patch = patch), chain),
        eq: (c: string, v: unknown) => (w.filters.push(["eq", c, v]), chain),
        in: (c: string, v: unknown[]) => (w.filters.push(["in", c, v]), chain),
        maybeSingle: async () => ({ data: answer(w).data[0] ?? null, error: null }),
        then: (ok: any, err: any) => Promise.resolve(answer(w)).then(ok, err),
      };
      return chain;
    },
  };
  const status = (id: string) => db.get(id)?.status;
  return { client, log, status };
}

// Rough-in, with two open steps and one already done before anyone checked it off.
const ROUGH_IN: Row[] = [
  { id: "P", status: "open", parent_id: null },
  { id: "A", status: "open", parent_id: "P" },
  { id: "B", status: "open", parent_id: "P" },
  { id: "C", status: "done", parent_id: "P" },
];
const allDone = () => ROUGH_IN.map((r) => ({ ...r, status: "done" as const }));

describe("toggleTask: a cascaded check-off, and its Undo", () => {
  it("the check-off answers with exactly the steps it closed, never the one already done", async () => {
    const t = tasksTable(ROUGH_IN);
    state.client = t.client;
    const res = await toggleTask("P", true, { jobId: "j1", cascade: true });
    expect(res.ok).toBe(true);
    expect([...(res.closedSteps ?? [])].sort()).toEqual(["A", "B"]);
    expect(["P", "A", "B", "C"].map(t.status)).toEqual(["done", "done", "done", "done"]);
    // The steps' write only touches rows still open: what came back is what this call closed.
    const stepsWrite = t.log.find((w) => w.verb === "update" && w.filters.some(([op]) => op === "in"));
    expect(stepsWrite?.filters).toContainEqual(["eq", "status", "open"]);
  });

  it("without consent it asks first and writes nothing (the needsCascade contract is unchanged)", async () => {
    const t = tasksTable(ROUGH_IN);
    state.client = t.client;
    const res = await toggleTask("P", true, { jobId: "j1" });
    expect(res).toMatchObject({ ok: false, needsCascade: true, openChildren: 2 });
    expect(res.closedSteps).toBeUndefined();
    expect(t.log.some((w) => w.verb === "update")).toBe(false);
  });

  it("a plain check-off (no steps) answers with no closedSteps", async () => {
    const t = tasksTable([{ id: "Q", status: "open", parent_id: null }]);
    state.client = t.client;
    expect(await toggleTask("Q", true, { jobId: "j1" })).toEqual({ ok: true });
  });

  it("a step a teammate checked off in the same moment isn't claimed, so Undo won't reopen it", async () => {
    const t = tasksTable(ROUGH_IN, {
      beforeUpdate: (db, w) => {
        if (w.patch?.status === "done" && w.filters.some(([op]) => op === "in")) db.get("B")!.status = "done";
      },
    });
    state.client = t.client;
    const res = await toggleTask("P", true, { jobId: "j1", cascade: true });
    expect(res.ok).toBe(true);
    expect(res.closedSteps).toEqual(["A"]);
  });

  it("a step this caller couldn't close is still said, and the task stays open", async () => {
    const t = tasksTable(ROUGH_IN, { locked: ["B"] });
    state.client = t.client;
    const res = await toggleTask("P", true, { jobId: "j1", cascade: true });
    expect(res).toEqual({ ok: false, error: "Couldn't complete 1 of the 2 subtasks. Refresh the page and try again." });
    expect(t.status("P")).toBe("open");
  });

  it("Undo reopens the task, then exactly the steps its check-off closed; the step done before stays done", async () => {
    const t = tasksTable(ROUGH_IN);
    state.client = t.client;
    const checked = await toggleTask("P", true, { jobId: "j1", cascade: true });
    t.log.length = 0;
    const res = await toggleTask("P", false, { jobId: "j1", reopenSteps: checked.closedSteps });
    expect(res).toEqual({ ok: true, reopenedSteps: 2, stepsStillDone: 0 });
    expect(["P", "A", "B", "C"].map(t.status)).toEqual(["open", "open", "open", "done"]);
    // The task first (never open steps under a done task), then only this task's steps still done.
    const writes = t.log.filter((w) => w.verb === "update");
    expect(writes).toHaveLength(2);
    expect(writes[0].filters).toEqual([["eq", "id", "P"]]);
    expect(writes[1].filters).toEqual(
      expect.arrayContaining([
        ["in", "id", expect.arrayContaining(["A", "B"])],
        ["eq", "parent_id", "P"],
        ["eq", "status", "done"],
      ]),
    );
  });

  it("Undo says how many steps stayed checked off when one can't be reopened", async () => {
    const t = tasksTable(allDone(), { locked: ["B"] });
    state.client = t.client;
    const res = await toggleTask("P", false, { jobId: "j1", reopenSteps: ["A", "B"] });
    expect(res).toEqual({ ok: true, reopenedSteps: 1, stepsStillDone: 1 });
    expect(["P", "A", "B"].map(t.status)).toEqual(["open", "open", "done"]);
  });

  it("a plain reopen touches no step; a refused reopen touches no step either", async () => {
    const plain = tasksTable(allDone());
    state.client = plain.client;
    expect(await toggleTask("P", false, { jobId: "j1" })).toEqual({ ok: true });
    expect(["P", "A", "B"].map(plain.status)).toEqual(["open", "done", "done"]);

    const refused = tasksTable(allDone(), { locked: ["P"] });
    state.client = refused.client;
    const res = await toggleTask("P", false, { jobId: "j1", reopenSteps: ["A", "B"] });
    expect(res.ok).toBe(false);
    expect(["P", "A", "B"].map(refused.status)).toEqual(["done", "done", "done"]);
  });
});

/**
 * NO NEW TASK ON A JOB THAT IS OVER (cn-v1174). Finishing or cancelling a job checks its tasks off, so a
 * task added to it afterwards is refused in ONE sentence naming ONE action, and nothing is written. A
 * step under one of its tasks is its task too. On hold is not over; a Reminder is untouched.
 */
describe("createTask on a job that is over (cn-v1174)", () => {
  beforeEach(() => {
    state.queries = [];
    state.dup = null;
    state.client = fake();
  });
  const inserts = () => state.queries.filter((q) => q.table === "tasks" && q.verb === "insert");

  for (const status of ["complete", "cancelled"]) {
    it(`${status}: refused in one sentence, nothing written`, async () => {
      state.jobStatus = status;
      const res = await createTask({ title: "Hang the panel", job_id: "job-1" });
      expect(res).toEqual({ ok: false, error: dict("en").tk_jobOverNoTask });
      expect(inserts()).toEqual([]);
      state.queries = [];
      const step = await createTask({ title: "Label it", parent_id: "parent-1" });
      expect(step).toEqual({ ok: false, error: dict("en").tk_jobOverNoTask });
      expect(inserts()).toEqual([]);
    });
  }

  it("on hold is not over, and a Reminder never asks", async () => {
    state.jobStatus = "on_hold";
    expect(await createTask({ title: "Hang the panel", job_id: "job-1" })).toMatchObject({ ok: true, id: "new-task" });
    state.jobStatus = "complete";
    expect(await createTask({ title: "Call the inspector" })).toMatchObject({ ok: true, id: "new-task" });
  });

  it("the sentence is one sentence with one action, in both languages", () => {
    const en = dict("en").tk_jobOverNoTask;
    const es = dict("es").tk_jobOverNoTask;
    expect(en).toBe("This job is over, so it takes no new tasks: set its status back to In Progress first.");
    expect(es).toBe("Este trabajo ya terminó, así que no acepta tareas nuevas: primero regresa su estado a En Curso.");
    for (const s of [en, es]) expect(s.match(/[.!?]/g)).toHaveLength(1);
    // The one action names the status by the words the status menu shows.
    expect(en).toContain(dict("en").jb_statusInProgress);
    expect(es).toContain(dict("es").jb_statusInProgress);
  });
});

describe("updateTask moving a task onto a job that is over (skeptic, cn-v1174)", () => {
  beforeEach(() => {
    state.queries = [];
    state.dup = null;
    state.client = fake();
  });
  const writes = () => state.queries.filter((q) => q.table === "tasks" && q.verb === "update");

  for (const status of ["complete", "cancelled"]) {
    it(`${status}: a move from another job is refused with createTask's sentence, nothing written`, async () => {
      state.jobStatus = status;
      const res = await updateTask("on-job-2", { job_id: "job-1" });
      expect(res).toEqual({ ok: false, error: dict("en").tk_jobOverNoTask });
      expect(writes()).toEqual([]);
      state.queries = [];
      // A Reminder (no job yet) moved onto it: the same.
      expect(await updateTask("reminder-1", { job_id: "job-1" })).toEqual({ ok: false, error: dict("en").tk_jobOverNoTask });
      expect(writes()).toEqual([]);
    });
  }

  it("an edit that hands the task's own job back is not a move; a job still being worked takes the move", async () => {
    state.jobStatus = "complete";
    expect(await updateTask("on-job-1", { title: "Hang the panel", job_id: "job-1" })).toEqual({ ok: true });
    expect(writes()).toHaveLength(1);
    state.queries = [];
    state.jobStatus = "on_hold";
    expect(await updateTask("on-job-2", { job_id: "job-1" })).toEqual({ ok: true });
    expect(writes()).toHaveLength(1);
  });
});
