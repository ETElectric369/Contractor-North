import { describe, expect, it, vi } from "vitest";
import {
  canDeleteTask,
  checkedOffWords,
  closeJobTasks,
  countOpenJobTasks,
  jobTaskTally,
  OPEN_TASK_JOB,
  whereJobTaskOpen,
  whereReminderOpen,
  doneWhenWords,
  doneWords,
  isMissingColumn,
  JOB_TASK_COLUMNS,
  JOB_TASK_COLUMNS_BEFORE_0358,
  JOB_TASK_COLUMNS_BEFORE_0395,
  readJobTasks,
  splitJobTasks,
  taskPhoto,
  tasksHeader,
  toJobTaskRow,
  undoCheckOff,
  undoneWords,
  type JobTaskRow,
} from "./job-tasks";
import { isOpenTask } from "./open-counts";

/**
 * THE JOB'S ONE TASK LIST (0358): the words the Done fold says, the order, the delete rule said before
 * the tap, and the read that keeps working on a database without 0358.
 */
const LA = "America/Los_Angeles";
// Saturday 2026-09-26, 12:00 PM in Los Angeles.
const NOW = new Date("2026-09-26T19:00:00Z");

const row = (over: Partial<JobTaskRow> = {}): JobTaskRow => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  title: "Hang the panel",
  status: "open",
  created_by: "u-office",
  created_at: "2026-09-20T17:00:00Z",
  completed_at: null,
  done_by: null,
  done_by_name: null,
  photo_path: null,
  done_photo_path: null,
  sort_order: 0,
  notes: null,
  ...over,
});

describe("doneWhenWords: when, in the company's time zone", () => {
  it("the same day reads Today with the time", () => {
    expect(doneWhenWords("2026-09-26T16:30:00Z", LA, NOW)).toBe("Today 9:30 AM");
  });

  it("the last six days read the weekday and the time", () => {
    expect(doneWhenWords("2026-09-22T21:14:00Z", LA, NOW)).toBe("Tue 2:14 PM");
  });

  it("the company's day, never UTC's: 10:30 PM Friday in LA is Friday, not 'Today'", () => {
    expect(doneWhenWords("2026-09-26T05:30:00Z", LA, NOW)).toBe("Fri 10:30 PM");
    // The same instant in New York is already Saturday there.
    expect(doneWhenWords("2026-09-26T05:30:00Z", "America/New_York", NOW)).toBe("Today 1:30 AM");
  });

  it("older than a week reads the date; another year carries it", () => {
    expect(doneWhenWords("2026-09-17T18:00:00Z", LA, NOW)).toBe("9/17");
    expect(doneWhenWords("2025-06-17T18:00:00Z", LA, NOW)).toBe("6/17/25");
  });

  it("a clock a little ahead reads as today; a broken time reads as nothing", () => {
    expect(doneWhenWords("2026-09-26T20:00:00Z", LA, NOW)).toBe("Today 1:00 PM");
    expect(doneWhenWords("not a date", LA, NOW)).toBe("");
  });

  it("a plain space before AM/PM, whatever the runtime's ICU does", () => {
    expect(doneWhenWords("2026-09-22T21:14:00Z", LA, NOW)).not.toMatch(/[  ]/);
  });
});

describe("doneWords: the Done fold's line", () => {
  it("who and when: the first name and the time", () => {
    expect(doneWords({ completed_at: "2026-09-22T21:14:00Z", done_by_name: "Brian Smith" }, LA, NOW)).toBe("Brian · Tue 2:14 PM");
  });

  it("a task checked off before 0358 recorded no one: 'Done 6/17', never a guessed name", () => {
    expect(doneWords({ completed_at: "2026-06-17T18:00:00Z", done_by_name: null }, LA, NOW)).toBe("Done 6/17");
    expect(doneWords({ completed_at: "2026-09-26T16:30:00Z", done_by_name: null }, LA, NOW)).toBe("Done 9/26");
  });

  it("no time at all: just Done", () => {
    expect(doneWords({ completed_at: null, done_by_name: null }, LA, NOW)).toBe("Done");
    expect(doneWords({ completed_at: null, done_by_name: "Brian" }, LA, NOW)).toBe("Done");
  });
});

describe("the list's order and header", () => {
  it("open tasks in the list's order (sort_order, then as added); done newest first, undated last", () => {
    const a = row({ id: "a", created_at: "2026-09-20T17:00:00Z" });
    const b = row({ id: "b", created_at: "2026-09-19T17:00:00Z" });
    const c = row({ id: "c", created_at: "2026-09-21T17:00:00Z", sort_order: -1 });
    const d1 = row({ id: "d1", status: "done", completed_at: "2026-09-22T17:00:00Z" });
    const d2 = row({ id: "d2", status: "done", completed_at: "2026-09-25T17:00:00Z" });
    const d3 = row({ id: "d3", status: "done", completed_at: null });
    const input = [a, d1, b, d3, c, d2];
    const { open, done } = splitJobTasks(input);
    expect(open.map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(done.map((t) => t.id)).toEqual(["d2", "d1", "d3"]);
    expect(input.map((t) => t.id)).toEqual(["a", "d1", "b", "d3", "c", "d2"]); // never mutated
  });

  it("the header is the one-number answer", () => {
    expect(tasksHeader(12, 7)).toBe("Tasks: 7 of 12 done");
  });
});

describe("canDeleteTask: 0358's delete rule, said before the tap", () => {
  it("the office deletes any task; anyone else only the ones they added", () => {
    expect(canDeleteTask({ created_by: "u-office" }, "u-tech", true)).toBe(true);
    expect(canDeleteTask({ created_by: "u-tech" }, "u-tech", false)).toBe(true);
    expect(canDeleteTask({ created_by: "u-office" }, "u-tech", false)).toBe(false);
    expect(canDeleteTask({ created_by: null }, "u-tech", false)).toBe(false);
    expect(canDeleteTask({ created_by: null }, null, false)).toBe(false);
  });
});

describe("taskPhoto: the photo, or a plain word", () => {
  const signed = new Map([["o/j/a.jpg", "https://x.test/a.jpg"]]);
  const files = new Set(["o/j/a.jpg", "o/j/b.jpg"]);
  it("a signed path is the photo; no path is nothing", () => {
    expect(taskPhoto("o/j/a.jpg", signed, files)).toEqual({ url: "https://x.test/a.jpg" });
    expect(taskPhoto(null, signed, files)).toBeNull();
  });
  it("still the job's but unsigned just now: unavailable (never claims it's gone)", () => {
    expect(taskPhoto("o/j/b.jpg", signed, files)).toBe("unavailable");
  });
  it("deleted from the job's photos: removed", () => {
    expect(taskPhoto("o/j/c.jpg", signed, files)).toBe("removed");
  });
});

describe("readJobTasks: safe before 0395 and before 0358", () => {
  const missing = (col: string) => ({ data: null, error: { code: "42703", message: `column tasks.${col} does not exist` } });
  /** A fake PostgREST: answers per column list — "new" (0395), "mid" (0358), "old" (before). */
  const fake = (answers: Record<string, { data: any[] | null; error: any }>) => {
    const asked: string[] = [];
    const client = {
      from: () => ({
        select: (cols: string) => {
          asked.push(cols);
          const chain = { eq: () => chain, order: () => chain, limit: async () => answers[cols.includes("planned_minutes") ? "new" : cols.includes("done_by") ? "mid" : "old"] };
          return chain;
        },
      }),
    };
    return { client, asked };
  };

  it("with 0395: the stamps, the photo, the doer's name and the task's own minutes ride along", async () => {
    const { client } = fake({
      new: { data: [{ id: "t1", title: "x", status: "done", created_at: "2026-09-20T17:00:00Z", completed_at: "2026-09-22T21:14:00Z", done_by: "u1", doer: { full_name: "Brian" }, photo_path: "o/j/a.jpg", sort_order: 0, planned_minutes: 240 }], error: null },
      old: { data: [], error: null },
    });
    const r = await readJobTasks(client, "j1");
    expect(r).toMatchObject({ stamps: true, failed: false });
    expect(r.rows[0]).toMatchObject({ done_by: "u1", done_by_name: "Brian", photo_path: "o/j/a.jpg", planned_minutes: 240 });
  });

  it("without 0395 (the minutes column doesn't exist yet): 0358's columns, the stamps still ride, the minutes wait", async () => {
    const { client, asked } = fake({
      new: missing("planned_minutes"),
      mid: { data: [{ id: "t1", title: "x", status: "done", created_at: "2026-09-20T17:00:00Z", done_by: "u1", doer: { full_name: "Brian" }, sort_order: 2 }], error: null },
      old: { data: [], error: null },
    });
    const r = await readJobTasks(client, "j1");
    expect(asked).toHaveLength(2);
    expect(r).toMatchObject({ stamps: true, failed: false });
    expect(r.rows[0]).toMatchObject({ id: "t1", done_by: "u1", done_by_name: "Brian", sort_order: 2, planned_minutes: null });
  });

  it("without 0358 (the column doesn't exist): the old columns, stamps:false, the list still works", async () => {
    const { client, asked } = fake({
      new: missing("planned_minutes"),
      mid: missing("done_by"),
      old: { data: [{ id: "t1", title: "x", status: "open", created_at: "2026-09-20T17:00:00Z" }], error: null },
    });
    const r = await readJobTasks(client, "j1");
    expect(asked).toHaveLength(3);
    expect(r).toMatchObject({ stamps: false, failed: false });
    expect(r.rows[0]).toMatchObject({ id: "t1", done_by: null, photo_path: null, sort_order: 0, planned_minutes: null });
  });

  it("any other error is a failure the card says, never an empty list read as 'no tasks'", async () => {
    const { client } = fake({ new: { data: null, error: { code: "57014", message: "canceling statement" } }, old: { data: [], error: null } });
    expect(await readJobTasks(client, "j1")).toEqual({ rows: [], stamps: false, failed: true });
  });

  it("isMissingColumn knows Postgres' and PostgREST's shapes, and nothing else", () => {
    expect(isMissingColumn({ code: "42703" })).toBe(true);
    expect(isMissingColumn({ code: "PGRST204", message: "Could not find the 'photo_path' column of 'tasks' in the schema cache" })).toBe(true);
    expect(isMissingColumn({ code: "PGRST200" })).toBe(true);
    expect(isMissingColumn({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingColumn(null)).toBe(false);
  });

  it("toJobTaskRow fills what an old row lacks; the minutes are a whole number or null, never 0", () => {
    expect(toJobTaskRow({ id: "t", title: "x", created_at: "c" })).toMatchObject({ status: "open", done_by_name: null, sort_order: 0, notes: null, planned_minutes: null });
    expect(toJobTaskRow({ id: "t", title: "x", created_at: "c", planned_minutes: "240" }).planned_minutes).toBe(240);
    expect(toJobTaskRow({ id: "t", title: "x", created_at: "c", planned_minutes: 0 }).planned_minutes).toBeNull();
  });

  it("the note rides along, before 0358 and after (a long materials request keeps its whole text there); the minutes only after 0395", () => {
    expect(JOB_TASK_COLUMNS).toMatch(/\bnotes\b/);
    expect(JOB_TASK_COLUMNS_BEFORE_0358).toMatch(/\bnotes\b/);
    expect(JOB_TASK_COLUMNS).toMatch(/\bplanned_minutes\b/);
    expect(JOB_TASK_COLUMNS_BEFORE_0395).not.toMatch(/\bplanned_minutes\b/);
    expect(JOB_TASK_COLUMNS_BEFORE_0395).toMatch(/\bdone_by\b/);
    expect(toJobTaskRow({ id: "t", title: "Materials: 3/4 EMT…", notes: "Brian on site: the whole request" }).notes).toBe(
      "Brian on site: the whole request",
    );
  });
});

describe("a check-off's Undo, after the check-off closed open steps with it (the cascade)", () => {
  const T = { id: "t-rough", title: "Rough-in" };

  it("the toast says the steps went with it; a plain check-off says just the task", () => {
    expect(checkedOffWords("Rough-in", 0)).toBe("Checked off: Rough-in");
    expect(checkedOffWords("Rough-in", 1)).toBe("Checked off: Rough-in and its open step");
    expect(checkedOffWords("Rough-in", 2)).toBe("Checked off: Rough-in and its 2 open steps");
  });

  it("Undo hands back exactly the steps the check-off closed, and says they came back", async () => {
    const reopen = vi.fn(async () => ({ ok: true, reopenedSteps: 2, stepsStillDone: 0 }));
    const u = await undoCheckOff(reopen, T, ["s-homeruns", "s-cans"], "j1");
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledWith("t-rough", false, { jobId: "j1", reopenSteps: ["s-homeruns", "s-cans"] });
    expect(u).toEqual({ ok: true, say: { text: "Reopened: Rough-in and its 2 steps.", tone: "info" } });
  });

  it("a check-off that closed no steps: Undo reopens the task alone, sends no steps, and stays quiet", async () => {
    const reopen = vi.fn(async () => ({ ok: true }));
    const u = await undoCheckOff(reopen, T, [], "j1");
    expect(reopen).toHaveBeenCalledWith("t-rough", false, { jobId: "j1" });
    expect(u).toEqual({ ok: true, say: null });
  });

  it("a step that stayed checked off is said, never an all-clear", async () => {
    const one = await undoCheckOff(async () => ({ ok: true, reopenedSteps: 1, stepsStillDone: 1 }), T, ["a", "b"], "j1");
    expect(one.ok).toBe(true);
    expect(one.say).toEqual({
      text: "Reopened: Rough-in. 1 of its 2 steps is still checked off: reopen it on the job's Tasks tab.",
      tone: "error",
    });
    expect(undoneWords("Rough-in", 3, { ok: true, reopenedSteps: 1, stepsStillDone: 2 })?.text).toBe(
      "Reopened: Rough-in. 2 of its 3 steps are still checked off: reopen them on the job's Tasks tab.",
    );
    expect(undoneWords("Rough-in", 1, { ok: true, reopenedSteps: 0, stepsStillDone: 1 })?.text).toBe(
      "Reopened: Rough-in. Its step is still checked off: reopen it on the job's Tasks tab.",
    );
  });

  it("a step deleted or reopened by someone else meanwhile isn't counted as back, or as stuck", () => {
    expect(undoneWords("Rough-in", 2, { ok: true, reopenedSteps: 1, stepsStillDone: 0 })).toEqual({
      text: "Reopened: Rough-in and its step.",
      tone: "info",
    });
    expect(undoneWords("Rough-in", 2, { ok: true, reopenedSteps: 0, stepsStillDone: 0 })).toEqual({ text: "Reopened: Rough-in.", tone: "info" });
  });

  it("a refused or failed reopen says so and reports not ok (the card puts the check back)", async () => {
    const refused = await undoCheckOff(async () => ({ ok: false, error: "You don't have permission to change that task." }), T, ["a"], "j1");
    expect(refused).toEqual({ ok: false, say: { text: "You don't have permission to change that task.", tone: "error" } });
    const thrown = await undoCheckOff(
      async () => {
        throw new Error("offline");
      },
      T,
      [],
      "j1",
    );
    expect(thrown).toEqual({ ok: false, say: { text: "Couldn't reopen the task. Try again.", tone: "error" } });
  });
});

/**
 * ONE RULE, ONE FUNCTION (cn-v1174; Erik, 2026-11-21: "it says 3 above and there are a bunch down there
 * so how is this number getting calculated?"). A task is OPEN when its status is open and it has no job,
 * or its job is neither complete nor cancelled; a job on hold keeps its tasks open. The rule lives in
 * lib/open-counts; its query twin, the split, the tally and the deed that closes a job's tasks live here.
 */
describe("isOpenTask: the rule's table", () => {
  const cases: Array<[string, { status: string }, { status: string | null } | null, boolean]> = [
    ["a Reminder (no job), open", { status: "open" }, null, true],
    ["a Reminder (no job), done", { status: "done" }, null, false],
    ["a job task, job to be scheduled", { status: "open" }, { status: "to_be_scheduled" }, true],
    ["a job task, job scheduled", { status: "open" }, { status: "scheduled" }, true],
    ["a job task, job in progress", { status: "open" }, { status: "in_progress" }, true],
    ["a job task, job ON HOLD (coming back)", { status: "open" }, { status: "on_hold" }, true],
    ["a job task, job complete", { status: "open" }, { status: "complete" }, false],
    ["a job task, job cancelled", { status: "open" }, { status: "cancelled" }, false],
    ["a job task, job's status unknown", { status: "open" }, { status: null }, true],
    ["a done job task on a job in progress", { status: "done" }, { status: "in_progress" }, false],
  ];
  for (const [name, task, job, open] of cases) it(name, () => expect(isOpenTask(task, job)).toBe(open));
});

describe("the job's list and its count read the rule with the job's status", () => {
  const rows = [row({ id: "a", status: "open" }), row({ id: "b", status: "open" }), row({ id: "c", status: "done", completed_at: NOW.toISOString() })];

  it("a job in flight (or no status given): as before", () => {
    expect(jobTaskTally(rows, null)).toEqual({ total: 3, done: 1, open: 2 });
    expect(jobTaskTally(rows, null, "on_hold")).toEqual({ total: 3, done: 1, open: 2 });
    expect(splitJobTasks(rows, "in_progress").open.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("a job that is over: no task is open, the header reads all of them done, and the rows sit in the Done fold", () => {
    for (const s of ["complete", "cancelled"]) {
      expect(jobTaskTally(rows, null, s)).toEqual({ total: 3, done: 3, open: 0 });
      const { open, done } = splitJobTasks(rows, s);
      expect(open).toEqual([]);
      expect(done.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
    }
  });

  it("the badge and the header are one tally: open + done is the total, whatever the status", () => {
    for (const s of ["scheduled", "on_hold", "complete", "cancelled", null]) {
      const t = jobTaskTally(rows, { open: 2, lines: [] }, s);
      expect(t.open + t.done).toBe(t.total);
      expect(splitJobTasks(rows, s).open.length + 1).toBe(t.open); // + the live Buy Materials row
    }
  });
});

/** A builder that records every call, for the query twins and the close. */
function recorder(result: { data?: unknown; error?: unknown; count?: number | null } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const q: any = {};
  for (const m of ["from", "select", "update", "eq", "not", "is", "in", "order", "limit"]) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, ...a]);
      return q;
    };
  }
  q.then = (res: (v: unknown) => unknown) => res({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null });
  return { q, calls };
}

describe("the query twin: the database cuts by the same rule", () => {
  it("a job task: status open, and its job (an inner embed named jobs) not complete or cancelled", () => {
    expect(OPEN_TASK_JOB).toBe("jobs!inner(status)");
    const { q, calls } = recorder();
    whereJobTaskOpen(q);
    expect(calls).toEqual([
      ["eq", "status", "open"],
      ["not", "jobs.status", "in", "(complete,cancelled)"],
    ]);
  });

  it("a Reminder: status open and no job", () => {
    const { q, calls } = recorder();
    whereReminderOpen(q);
    expect(calls).toEqual([
      ["eq", "status", "open"],
      ["is", "job_id", null],
    ]);
  });

  it("the Finish window's count reads the twin, head only; a failed read is null, never 0", async () => {
    const ok = recorder({ count: 4 });
    expect(await countOpenJobTasks(ok.q, "j1")).toBe(4);
    expect(ok.calls).toContainEqual(["select", `id, ${OPEN_TASK_JOB}`, { count: "exact", head: true }]);
    expect(ok.calls).toContainEqual(["eq", "job_id", "j1"]);
    expect(ok.calls).toContainEqual(["not", "jobs.status", "in", "(complete,cancelled)"]);
    expect(await countOpenJobTasks(recorder({ error: { message: "down" } }).q, "j1")).toBeNull();
  });
});

describe("closeJobTasks: the deed closes a job's open tasks", () => {
  it("checks off only this job's OPEN tasks, selects what it wrote, and counts it", async () => {
    const { q, calls } = recorder({ data: [{ id: "t1" }, { id: "t2" }] });
    const res = await closeJobTasks(q, "j1", "u1");
    expect(res).toEqual({ ok: true, closed: 2 });
    expect(calls[0]).toEqual(["from", "tasks"]);
    expect(calls[1][0]).toBe("update");
    expect(calls[1][1]).toEqual({ status: "done", completed_at: expect.any(String), done_by: "u1" });
    expect(calls).toContainEqual(["eq", "job_id", "j1"]);
    expect(calls).toContainEqual(["eq", "status", "open"]);
    expect(calls.at(-1)).toEqual(["select", "id"]);
  });

  it("nothing open is a true zero; no person leaves done_by empty", async () => {
    const { q, calls } = recorder({ data: [] });
    expect(await closeJobTasks(q, "j1")).toEqual({ ok: true, closed: 0 });
    expect((calls[1][1] as { done_by: unknown }).done_by).toBeNull();
  });

  it("a failed write is handed back to be said, never thrown", async () => {
    const err = { message: "permission denied" };
    expect(await closeJobTasks(recorder({ error: err }).q, "j1")).toEqual({ ok: false, error: err });
    const throws: any = { from: () => { throw new Error("offline"); } };
    expect((await closeJobTasks(throws, "j1")).ok).toBe(false);
  });
});
