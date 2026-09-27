import { describe, expect, it } from "vitest";
import {
  canDeleteTask,
  doneWhenWords,
  doneWords,
  isMissingColumn,
  JOB_TASK_COLUMNS,
  JOB_TASK_COLUMNS_BEFORE_0358,
  readJobTasks,
  splitJobTasks,
  taskPhoto,
  tasksHeader,
  toJobTaskRow,
  type JobTaskRow,
} from "./job-tasks";

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

describe("readJobTasks: safe before 0358", () => {
  /** A fake PostgREST: answers per column list. */
  const fake = (answers: Record<string, { data: any[] | null; error: any }>) => {
    const asked: string[] = [];
    const client = {
      from: () => ({
        select: (cols: string) => {
          asked.push(cols);
          const chain = { eq: () => chain, order: () => chain, limit: async () => answers[cols.includes("done_by") ? "new" : "old"] };
          return chain;
        },
      }),
    };
    return { client, asked };
  };

  it("with 0358: the stamps, the photo and the doer's name ride along", async () => {
    const { client } = fake({
      new: { data: [{ id: "t1", title: "x", status: "done", created_at: "2026-09-20T17:00:00Z", completed_at: "2026-09-22T21:14:00Z", done_by: "u1", doer: { full_name: "Brian" }, photo_path: "o/j/a.jpg", sort_order: 0 }], error: null },
      old: { data: [], error: null },
    });
    const r = await readJobTasks(client, "j1");
    expect(r).toMatchObject({ stamps: true, failed: false });
    expect(r.rows[0]).toMatchObject({ done_by: "u1", done_by_name: "Brian", photo_path: "o/j/a.jpg" });
  });

  it("without 0358 (the column doesn't exist): the old columns, stamps:false, the list still works", async () => {
    const { client, asked } = fake({
      new: { data: null, error: { code: "42703", message: 'column tasks.done_by does not exist' } },
      old: { data: [{ id: "t1", title: "x", status: "open", created_at: "2026-09-20T17:00:00Z" }], error: null },
    });
    const r = await readJobTasks(client, "j1");
    expect(asked).toHaveLength(2);
    expect(r).toMatchObject({ stamps: false, failed: false });
    expect(r.rows[0]).toMatchObject({ id: "t1", done_by: null, photo_path: null, sort_order: 0 });
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

  it("toJobTaskRow fills what an old row lacks", () => {
    expect(toJobTaskRow({ id: "t", title: "x", created_at: "c" })).toMatchObject({ status: "open", done_by_name: null, sort_order: 0, notes: null });
  });

  it("the note rides along, before 0358 and after (a long materials request keeps its whole text there)", () => {
    expect(JOB_TASK_COLUMNS).toMatch(/\bnotes\b/);
    expect(JOB_TASK_COLUMNS_BEFORE_0358).toMatch(/\bnotes\b/);
    expect(toJobTaskRow({ id: "t", title: "Materials: 3/4 EMT…", notes: "Brian on site: the whole request" }).notes).toBe(
      "Brian on site: the whole request",
    );
  });
});
