import { describe, it, expect } from "vitest";
import type { Playbook } from "@/lib/playbook/types";
import type { TaskValue } from "@/lib/playbook/tasks";
import { fakeDb } from "@/test/fake-supabase";
import {
  PLANNED_MINUTES_MAX,
  bornTasks,
  bornWithTasks,
  minutesOf,
  partsAsCaptureItems,
  tasksAnswered,
  tasksFromLines,
  tasksFromVisit,
  type LineRow,
} from "./born-with-tasks";

/**
 * THE LAW UNDER TEST: a job is born with exactly the tasks he wrote, in his order; its length is the
 * sum of HIS hours and nothing else; a hole stays a hole ([[no-speculation]]). A line that is not a
 * task is left alone.
 */

const line = (id: string, description: string, sort_order: number, detail: unknown): LineRow => ({ id, description, sort_order, detail });

const detail = (hours: number | null, materials: unknown[] = []) => ({
  task_id: `t-${hours ?? "x"}`,
  hours,
  rate: 120,
  units: null,
  kit_id: null,
  materials,
});

describe("tasksFromLines — what an accepted estimate gives birth to", () => {
  it("only a line with a breakdown is a task; plain lines are left alone", () => {
    const b = tasksFromLines([
      line("a", "14/2 romex [W142]", 0, null),
      line("b", "Install transfer switch", 1, detail(3)),
      line("c", "Labor — 2 hr", 2, null),
      line("d", "Run generator feed ×2", 3, detail(1.5)),
    ]);
    expect(b.tasks).toEqual([
      { source_key: "line:b", title: "Install transfer switch", sort_order: 1 },
      { source_key: "line:d", title: "Run generator feed ×2", sort_order: 3 },
    ]);
  });

  it("the key is the line's id, so a door run twice births nothing twice", () => {
    const b = tasksFromLines([line("abc-1", "Set panel", 0, detail(2))]);
    expect(b.tasks[0].source_key).toBe("line:abc-1");
  });

  it("planned minutes = Σ round(his hours × 60); a task still asking adds nothing", () => {
    const b = tasksFromLines([
      line("a", "Set panel", 0, detail(2)),
      line("b", "Pull permit", 1, detail(null)), // hours? — asks, adds nothing
      line("c", "Trim out", 2, detail(1.25)),
    ]);
    expect(b.plannedMinutes).toBe(120 + 75);
  });

  it("no hours anywhere → null, and the job's How Long box asks as it does today", () => {
    expect(tasksFromLines([line("a", "Set panel", 0, detail(null))]).plannedMinutes).toBeNull();
    expect(tasksFromLines([line("a", "14/2 romex", 0, null)]).plannedMinutes).toBeNull();
    expect(tasksFromLines([]).tasks).toEqual([]);
  });

  it("a sum the column would refuse (0229: ≤ 43200) is left null, never clamped to a number he did not say", () => {
    expect(minutesOf([PLANNED_MINUTES_MAX / 60 + 1])).toBeNull();
    expect(minutesOf([PLANNED_MINUTES_MAX / 60])).toBe(PLANNED_MINUTES_MAX);
    expect(minutesOf([0, -2, null])).toBeNull();
    expect(minutesOf([0.4])).toBe(24);
  });

  it("each named part rides with its task's key, code, count and the cost the line was built with", () => {
    const b = tasksFromLines([
      line("b", "Install transfer switch", 1, detail(3, [
        { code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 460 },
        { code: null, name: "Bayberry clips", qty: null, cost: null, sell: null }, // how many?
        { code: "X9", name: "", qty: 2, cost: 1, sell: 2 }, // nameless → not a part (coerce drops it)
      ])),
    ]);
    expect(b.parts).toEqual([
      { source_key: "line:b", code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400 },
      { source_key: "line:b", code: null, name: "Bayberry clips", qty: null, cost: null },
      // a code with no name is named by its code (coerceTaskDetail), so it stays a part
      { source_key: "line:b", code: "X9", name: "X9", qty: 2, cost: 1 },
    ]);
  });

  it("a hand-edited row that is not a breakdown (an array, a string) is not a task", () => {
    const b = tasksFromLines([line("a", "Set panel", 0, "yes"), line("b", "Set panel", 1, [1, 2])]);
    expect(b.tasks).toEqual([]);
  });

  it("a nameless line is not a task even with a breakdown", () => {
    expect(tasksFromLines([line("a", "   ", 0, detail(2))]).tasks).toEqual([]);
  });
});

const visit = (id: string, name: string, hours: number | null, extra: Partial<TaskValue> = {}): TaskValue => ({
  id,
  name,
  hours,
  units: null,
  kit_id: null,
  materials: [],
  ...extra,
});

describe("tasksFromVisit — Start The Job on an inspection", () => {
  it("his tasks in his order, keyed by the task's own id, ' ×N' for a per-unit task like the estimate line", () => {
    const b = tasksFromVisit([visit("t1", "Set panel", 4), visit("t2", "Footings", 1, { units: 7 }), visit("t3", "Trim out", null, { units: 1 })]);
    expect(b.tasks).toEqual([
      { source_key: "task:t1", title: "Set panel", sort_order: 0 },
      { source_key: "task:t2", title: "Footings ×7", sort_order: 1 },
      { source_key: "task:t3", title: "Trim out", sort_order: 2 },
    ]);
    expect(b.plannedMinutes).toBe(300);
  });

  it("parts by his words and/or code, cost unknown (nothing has priced them yet)", () => {
    const b = tasksFromVisit([
      visit("t1", "Set panel", 4, {
        materials: [
          { code: "BRK50", words: null, qty: 2 },
          { code: null, words: "6/3 SER", qty: null },
          { code: null, words: "  ", qty: 1 }, // nothing said → not a part
        ],
      }),
    ]);
    expect(b.parts).toEqual([
      { source_key: "task:t1", code: "BRK50", name: "BRK50", qty: 2, cost: null },
      { source_key: "task:t1", code: null, name: "6/3 SER", qty: null, cost: null },
    ]);
    expect(partsAsCaptureItems(b.parts)).toEqual([
      { id: "task:t1:0", description: "BRK50", quantity: 2, unit: "ea", code: "BRK50" },
      { id: "task:t1:1", description: "6/3 SER", quantity: null, unit: "ea", code: null },
    ]);
  });

  it("a task that picked a KIT (W4) takes its hours and parts from it through expandTaskKit; his own hours win", () => {
    const kit = {
      id: "k1", name: "Footing", labor_minutes: 120, unit: "footing",
      items: [{ description: "Concrete, 80 lb", quantity: 4, unit: "ea", unit_price: 9.5, qty_round: "none", sort_order: 0 }],
    };
    const kits = new Map([[kit.id, kit]]);
    const b = tasksFromVisit([visit("t1", "Footings", null, { units: 7, kit_id: "k1", materials: [{ code: null, words: "Rebar stake", qty: 14 }] })], kits);
    expect(b.tasks).toEqual([{ source_key: "task:t1", title: "Footings ×7", sort_order: 0 }]);
    expect(b.plannedMinutes).toBe(840);
    expect(b.parts).toEqual([
      { source_key: "task:t1", code: null, name: "Concrete, 80 lb", qty: 28, cost: null },
      { source_key: "task:t1", code: null, name: "Rebar stake", qty: 14, cost: null },
    ]);
    expect(tasksFromVisit([visit("t1", "Footings", 3, { units: 7, kit_id: "k1" })], kits).plannedMinutes).toBe(180);
    // A kit nobody handed in (or one that left the price list) answers nothing: the job asks.
    expect(tasksFromVisit([visit("t1", "Footings", null, { units: 7, kit_id: "k1" })]).plannedMinutes).toBeNull();
  });

  it("no tasks, or no hours → no length", () => {
    expect(tasksFromVisit([]).plannedMinutes).toBeNull();
    expect(tasksFromVisit([visit("t1", "Set panel", null)]).plannedMinutes).toBeNull();
  });
});

const PB: Playbook = {
  needs: [
    { key: "kind", label: "Kind", ask: "Kind?", slot: { type: "select", options: ["Service call", "Contract job"] } },
    { key: "tasks", label: "Tasks", ask: "Tasks?", slot: { type: "tasks" } },
    { key: "extra", label: "Extra tasks", ask: "More?", slot: { type: "tasks" }, when: [{ key: "kind", in: ["Contract job"] }] },
    { key: "panel", label: "Panel", ask: "Panel?", slot: { type: "text" } },
  ],
};

describe("tasksAnswered — the same read the estimate seed does", () => {
  it("every tasks slot that still applies, coerced; a slot a later answer turned off is not read", () => {
    const answers = {
      kind: "Service call",
      tasks: [{ id: "a", name: "Replace outlet", hours: 1, units: null, kit_id: null, materials: [] }],
      extra: [{ id: "b", name: "Should not be born", hours: 9, units: null, kit_id: null, materials: [] }],
      panel: "Square D",
    };
    const got = tasksAnswered(PB, answers);
    expect(got.map((t) => t.name)).toEqual(["Replace outlet"]);
  });

  it("both slots when the condition holds", () => {
    const answers = {
      kind: "Contract job",
      tasks: [{ id: "a", name: "Replace outlet", hours: 1, materials: [] }],
      extra: [{ id: "b", name: "Set panel", hours: 4, materials: [] }],
    };
    expect(tasksAnswered(PB, answers).map((t) => t.name)).toEqual(["Replace outlet", "Set panel"]);
  });

  it("nothing answered → nothing", () => {
    expect(tasksAnswered(PB, {})).toEqual([]);
    expect(tasksAnswered(PB, { tasks: "not a list" })).toEqual([]);
  });
});

const ORG = "org-1";
const birth = {
  tasks: [
    { source_key: "line:a", title: "Set panel", sort_order: 0 },
    { source_key: "line:b", title: "Trim out", sort_order: 2 },
  ],
  plannedMinutes: 195,
  parts: [],
};
const jobs = (planned: number | null) => [{ id: "job-1", org_id: ORG, planned_minutes: planned }];

describe("bornTasks — the write", () => {
  it("inserts the missing tasks with the company, the key, the order and who, and counts them", async () => {
    const db = fakeDb({ tasks: [], jobs: jobs(null) });
    const res = await bornTasks(db.sb, { jobId: "job-1", orgId: ORG, createdBy: "u-1" }, birth);
    expect(res).toEqual({ inserted: 2, plannedSet: true });
    expect(db.inserted.tasks).toEqual([
      { id: "tasks-1", org_id: ORG, job_id: "job-1", title: "Set panel", source_key: "line:a", sort_order: 0, category: null, created_by: "u-1" },
      { id: "tasks-2", org_id: ORG, job_id: "job-1", title: "Trim out", source_key: "line:b", sort_order: 2, category: null, created_by: "u-1" },
    ]);
    expect(db.tables.jobs[0].planned_minutes).toBe(195);
  });

  it("a replay births nothing twice: the keys already on the job are skipped", async () => {
    const db = fakeDb({ tasks: [{ id: "t-old", job_id: "job-1", source_key: "line:a" }], jobs: jobs(195) });
    const res = await bornTasks(db.sb, { jobId: "job-1", orgId: ORG, createdBy: "u-1" }, birth);
    expect(res).toEqual({ inserted: 1, plannedSet: false });
    expect(db.inserted.tasks.map((r) => r.source_key)).toEqual(["line:b"]);
    const again = await bornTasks(db.sb, { jobId: "job-1", orgId: ORG, createdBy: "u-1" }, birth);
    expect(again).toEqual({ inserted: 0, plannedSet: false });
    expect(db.inserted.tasks).toHaveLength(1);
  });

  it("his How Long wins: a job that already has a size keeps it", async () => {
    const db = fakeDb({ tasks: [], jobs: jobs(480) });
    const res = await bornTasks(db.sb, { jobId: "job-1", orgId: ORG, createdBy: "u-1" }, birth);
    expect(res.plannedSet).toBe(false);
    expect(db.tables.jobs[0].planned_minutes).toBe(480);
  });

  it("no hours → the size is not touched; no tasks → nothing is written at all", async () => {
    const db = fakeDb({ tasks: [], jobs: jobs(null) });
    expect(await bornTasks(db.sb, { jobId: "job-1", orgId: ORG, createdBy: "u-1" }, { ...birth, plannedMinutes: null })).toEqual({ inserted: 2, plannedSet: false });
    expect(db.tables.jobs[0].planned_minutes).toBeNull();
    const quiet = fakeDb({ tasks: [], jobs: jobs(null) });
    expect(await bornTasks(quiet.sb, { jobId: "job-1", orgId: ORG, createdBy: "u-1" }, { tasks: [], plannedMinutes: null, parts: [] })).toEqual({ inserted: 0, plannedSet: false });
    expect(quiet.inserted).toEqual({});
  });

  it("two doors in the same second: the loser's unique violation is not a failure when the winner's rows are all there", async () => {
    const db = fakeDb(
      { tasks: [], jobs: jobs(null) },
      {
        onInsert: (table, rows) => {
          if (table !== "tasks") return undefined;
          // the other door landed first: its rows are on the job, ours bounce off the unique index
          db.tables.tasks.push(...rows.map((r) => ({ ...r, id: `winner-${r.source_key}` })));
          return { code: "23505", message: 'duplicate key value violates unique constraint "tasks_job_source_key_uq"' };
        },
      },
    );
    const res = await bornTasks(db.sb, { jobId: "job-1", orgId: ORG, createdBy: "u-1" }, birth);
    expect(res).toEqual({ inserted: 0, plannedSet: true });
  });

  it("any other refusal is said in plain words, and the size is not written", async () => {
    const db = fakeDb({ tasks: [], jobs: jobs(null) }, { onInsert: (t) => (t === "tasks" ? { code: "42501", message: "permission denied for table tasks" } : undefined) });
    const res = await bornTasks(db.sb, { jobId: "job-1", orgId: ORG, createdBy: "u-1" }, birth);
    expect(res.inserted).toBe(0);
    expect(res.error).toBeTruthy();
    expect(db.tables.jobs[0].planned_minutes).toBeNull();
  });
});

describe("bornWithTasks — the estimate doors' half", () => {
  it("reads the accepted estimate's lines (the company's, in order) and births from them", async () => {
    const db = fakeDb({
      quote_line_items: [
        { id: "l1", quote_id: "q-1", org_id: ORG, description: "14/2 romex", sort_order: 0, detail: null },
        { id: "l2", quote_id: "q-1", org_id: ORG, description: "Set panel", sort_order: 1, detail: { task_id: "t", hours: 2, rate: 120, units: null, kit_id: null, materials: [] } },
        { id: "l9", quote_id: "q-1", org_id: "org-2", description: "Not this company's", sort_order: 2, detail: { task_id: "t", hours: 9, rate: 1, units: null, kit_id: null, materials: [] } },
      ],
      tasks: [],
      jobs: jobs(null),
    });
    const res = await bornWithTasks(db.sb, { jobId: "job-1", quoteId: "q-1", orgId: ORG, createdBy: "author" });
    expect(res.inserted).toBe(1);
    expect(res.birth.tasks).toEqual([{ source_key: "line:l2", title: "Set panel", sort_order: 1 }]);
    expect(db.inserted.tasks[0]).toMatchObject({ source_key: "line:l2", created_by: "author", org_id: ORG });
    expect(db.tables.jobs[0].planned_minutes).toBe(120);
  });
});
