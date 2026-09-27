import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * createTask's duplicate check (0358). A Reminder is private to its maker and its person, so a
 * same-title Reminder only collapses onto one the caller can see: on a database without 0358 the
 * read was company-wide, and a teammate's Reminder answered "Already on the list" and saved nothing.
 */

type Q = { table: string; verb: string; ors: string[]; eqs: [string, unknown][]; iss: [string, unknown][] };
const state = vi.hoisted(() => ({ client: null as any, queries: [] as any[], dup: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createTask, toggleTask } from "./actions";

function fake() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-brian" } } }) },
    from(table: string) {
      const q: Q = { table, verb: "select", ors: [], eqs: [], iss: [] };
      state.queries.push(q);
      const answer = () => {
        if (table === "jobs") return { data: { id: "job-1" }, error: null };
        if (q.verb === "insert") return { data: { id: "new-task" }, error: null };
        return { data: state.dup, error: null };
      };
      const chain: any = {
        select: () => chain,
        insert: () => ((q.verb = "insert"), chain),
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
 * My Day's Now block). A check-off of a task with open steps closes them with it; its Undo must reopen
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
