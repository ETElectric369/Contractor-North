import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A FLAGGED JOB TASK IS A NEEDS YOU ROW (cn-v1179, decision B). The owner, 2026-11-22: "there are some
 * tasks id like to flag as a reminder to do for certain jobs sometimes like [a job: print panel labels]
 * [...] so maybe these tasks should go in the needs you under operations instead and reminders can just
 * be reminders". Every OPEN job task with priority > 0 on a job that is not over is one row under
 * Operations, "<job> · <task>", PLAIN (a flag records no day), Check Off and Open the Job; two or more
 * are the Flagged Tasks pile, counted as its count; a cut read says "N+"; a lost read says so. Staff only.
 *
 * The stand-in database HONOURS the tasks read's filters and its embeds (a stand-in that ignored them
 * would pass a feeder that read every task): eq, not … is null, not jobs.status in (…), gt, the inner
 * embed, the order and the limit, and the exact count.
 */

const TODAY = "2026-11-22";
const TZ = "America/Los_Angeles";

type TaskRow = {
  id: string;
  org_id: string;
  job_id: string | null;
  title: string;
  status: "open" | "done";
  priority: number;
  created_at: string;
};
type JobRow = { id: string; status: string; job_number: string; name: string; customer: string | null };

const state = vi.hoisted(() => ({
  tasks: [] as TaskRow[],
  jobs: [] as JobRow[],
  failTasks: false,
  taskReads: [] as { select: string; filters: unknown[][] }[],
}));

/** The tasks read, answered by its own filters over the rows above. */
function tasksQuery() {
  const filters: unknown[][] = [];
  let select = "";
  let wantCount = false;
  let limit = Infinity;
  let asc = true;
  const run = () => {
    if (state.failTasks) return { data: null, error: { code: "57014", message: "statement timeout" }, count: null };
    state.taskReads.push({ select, filters });
    const inner = select.includes("jobs!inner(status");
    // The job's words ride the ONE inner embed (never a second embed of jobs): only what it lists comes back.
    const wide = select.includes("jobs!inner(status, job_number, name, customers(name))");
    let rows = state.tasks.map((t) => {
      const j = state.jobs.find((x) => x.id === t.job_id) ?? null;
      return {
        ...t,
        ...(inner ? { jobs: j ? { status: j.status, ...(wide ? { job_number: j.job_number, name: j.name, customers: j.customer ? { name: j.customer } : null } : {}) } : null } : {}),
      } as Record<string, any>;
    });
    if (inner) rows = rows.filter((r) => r.jobs);
    for (const f of filters) {
      const [op, col, a, b] = f as [string, string, unknown, unknown];
      if (op === "eq") rows = rows.filter((r) => r[col] === a);
      else if (op === "gt") rows = rows.filter((r) => Number(r[col]) > Number(a));
      else if (op === "not" && a === "is" && b === null) rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
      else if (op === "not" && a === "in") {
        const list = String(b).replace(/[()]/g, "").split(",");
        const [emb, c] = col.split(".");
        rows = rows.filter((r) => !list.includes(String(c ? r[emb]?.[c] : r[col])));
      } else throw new Error(`the stand-in does not know ${op} ${col}`);
    }
    rows.sort((x, y) => (asc ? 1 : -1) * String(x.created_at).localeCompare(String(y.created_at)));
    const count = rows.length;
    return { data: rows.slice(0, limit), error: null, count: wantCount ? count : null };
  };
  const q: any = {
    select: (c: string, o?: { count?: string }) => {
      select = c;
      wantCount = o?.count === "exact";
      return q;
    },
    order: (_c: string, o?: { ascending?: boolean }) => {
      asc = o?.ascending !== false;
      return q;
    },
    limit: (n: number) => {
      limit = n;
      return q;
    },
    then: (ok: any, err: any) => Promise.resolve(run()).then(ok, err),
  };
  for (const m of ["eq", "gt", "not", "is", "in", "lt", "lte", "gte", "neq", "or", "contains"]) {
    q[m] = (...args: unknown[]) => {
      filters.push([m, ...args]);
      return q;
    };
  }
  return q;
}

/** Every other read answers empty (a profile says the company). */
function emptyQuery(table: string) {
  const q: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          const data = table === "profiles" ? { org_id: "org-1", role: "owner" } : [];
          return (ok: any, err: any) => Promise.resolve({ data, error: null, count: Array.isArray(data) ? 0 : null }).then(ok, err);
        }
        if (prop === "maybeSingle" || prop === "single") return async () => ({ data: table === "profiles" ? { org_id: "org-1", role: "owner" } : null, error: null });
        return () => q;
      },
    },
  );
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => (t === "tasks" ? tasksQuery() : emptyQuery(t)), rpc: () => emptyQuery("rpc") }),
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { getActionItems, FLAGGED_TASKS_READ } from "./query";
import { summarize } from "./needs-you-rule";
import { rowButtons } from "./row-buttons";
import { rowWords } from "./row-words";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import type { ActionItem } from "./types";

const job = (id: string, number: string, name: string, status = "scheduled", customer: string | null = "Dana Rook"): JobRow => ({ id, status, job_number: number, name, customer });
let n = 0;
const task = (o: Partial<TaskRow>): TaskRow => ({
  id: `t${++n}`,
  org_id: "org-1",
  job_id: "j1",
  title: "Print panel labels",
  status: "open",
  priority: 1,
  created_at: `2026-11-${String(10 + (n % 10)).padStart(2, "0")}T17:00:00Z`,
  ...o,
});
const build = (isStaff = true) => getActionItems({ todayStr: TODAY, isStaff, userId: isStaff ? "owner-1" : "tech-1", tz: TZ });
const flat = (rows: ActionItem[]) => [...rows, ...rows.flatMap((r) => r.children ?? [])];

beforeEach(() => {
  n = 0;
  state.tasks = [];
  state.jobs = [job("j1", "J-041", "Larkspur Deck"), job("j2", "J-052", "Snowbell Panel", "on_hold"), job("j3", "J-963", "Bayberry Porch", "complete"), job("j4", "J-074", "Thistlewood Barn", "cancelled")];
  state.failTasks = false;
  state.taskReads = [];
});

describe("the feeder", () => {
  it("a flagged open task is one plain Operations row: the job in bold, the task and the customer under it, Check Off and Open the Job", async () => {
    state.tasks = [task({ id: "t-a", title: "Print panel labels" })];
    const r = await build();
    const row = r.now.find((x) => x.id === "flagtask-t-a")!;
    expect(row).toMatchObject({
      kind: "job_task_flagged",
      group: "run_jobs",
      level: "none",
      title: "Larkspur Deck · J-041 · Print panel labels",
      who: "Larkspur Deck · J-041",
      subtitle: "Print panel labels · Dana Rook",
      when: null,
      clock: null,
      href: "/jobs/j1?tab=tasks",
      affordances: ["do", "open"],
    });
    expect(row.older).toBeFalsy();
    expect(row.waitKey ?? null).toBeNull();
    // One thing on Operations, the header and the dock's badge.
    const sum = summarize(r.now, { isStaff: true });
    expect(sum.total).toBe(1);
    expect(sum.tiles.find((t) => t.group === "run_jobs")!.count).toBe(1);
    expect(sum.soon).toBe(0);
    // The read: the company by hand, flagged, a job set, open by the one rule, oldest first, capped.
    const read = state.taskReads[0];
    expect(read.select).toContain("jobs!inner(status, job_number, name, customers(name))");
    expect(read.select).not.toContain("job:job_id("); // one embed of jobs, the shape already run in production
    expect(read.filters).toContainEqual(["eq", "org_id", "org-1"]);
    expect(read.filters).toContainEqual(["gt", "priority", 0]);
    expect(read.filters).toContainEqual(["eq", "status", "open"]);
  });

  it("left out: an unflagged task, a done one, one on a finished or cancelled job, a Reminder, another company's", async () => {
    state.tasks = [
      task({ id: "keep", title: "Pick up the meter base" }),
      task({ id: "plain", priority: 0 }),
      task({ id: "done", status: "done" }),
      task({ id: "finished", job_id: "j3" }),
      task({ id: "cancelled", job_id: "j4" }),
      task({ id: "reminder", job_id: null }),
      task({ id: "elsewhere", org_id: "org-2" }),
      // A held job is not over: its flagged task still asks.
      task({ id: "held", job_id: "j2", title: "Call the inspector" }),
    ];
    const ids = flat((await build()).now)
      .filter((x) => x.kind === "job_task_flagged" && !x.pile)
      .map((x) => x.id)
      .sort();
    expect(ids).toEqual(["flagtask-held", "flagtask-keep"]);
  });

  it("a tech gets none, and his build reads no task at all", async () => {
    state.tasks = [task({ id: "t-a" })];
    const r = await build(false);
    expect(flat(r.now).some((x) => x.kind === "job_task_flagged")).toBe(false);
    expect(state.taskReads).toHaveLength(0);
  });

  it("two make the Flagged Tasks pile, counted as two, unfolding in place, its button See Them", async () => {
    state.tasks = [task({ id: "t-a" }), task({ id: "t-b", job_id: "j2", title: "Order the panel" })];
    const r = await build();
    const pile = r.now.find((x) => x.id === "pile:flagged_tasks")!;
    expect(pile.title).toBe("Flagged Tasks · 2");
    expect(pile.pile).toMatchObject({ name: "flagged_tasks", count: 2, capped: false, listHref: null });
    expect(pile.level).toBe("none");
    expect(summarize(r.now, { isStaff: true }).total).toBe(2);
    expect(rowButtons(pile, { isStaff: true }).primary).toEqual({ label: "See Them", act: { type: "unfold" } });
    const es = { isStaff: true, lang: "es", words: translator("es") };
    expect(rowButtons(pile, es).primary?.label).toBe("Verlas");
    expect(rowWords(pile, { ...es, todayStr: TODAY, tz: TZ }).who).toBe("Tareas Marcadas · 2");
  });

  it("a cut read says N+: the count is a floor, never the read's limit", async () => {
    state.tasks = Array.from({ length: FLAGGED_TASKS_READ + 7 }, (_, i) => task({ id: `t-${i}` }));
    const r = await build();
    const pile = r.now.find((x) => x.id === "pile:flagged_tasks")!;
    expect(pile.pile).toMatchObject({ count: FLAGGED_TASKS_READ, capped: true });
    expect(pile.title).toBe(`Flagged Tasks · ${FLAGGED_TASKS_READ}+`);
    expect(summarize(r.now, { isStaff: true })).toMatchObject({ total: FLAGGED_TASKS_READ, capped: true });
  });

  it("a lost read claims nothing and says so in one Couldn't Check line", async () => {
    state.failTasks = true;
    const r = await build();
    const rows = flat(r.now).filter((x) => x.kind === "job_task_flagged");
    expect(rows.map((x) => x.id)).toEqual(["flagtasks-unread"]);
    expect(rows[0]).toMatchObject({ whoSay: { key: "ny_who_unread", vars: { labelKey: "ny_btn_pile_flaggedTasks" } }, what: { key: "ny_w_unreadFlaggedTasks" }, affordances: ["open"] });
    expect(rowButtons(rows[0], { isStaff: true })).toEqual({ primary: null, also: null, more: [] });
    // skeptic #82, S4: no Open the Job (a button that names a job and opens the list) and no Check Off,
    // in either language; the line's one door is the plain open it already has.
    expect(rowButtons(rows[0], { isStaff: true, lang: "es", words: translator("es") })).toEqual({ primary: null, also: null, more: [] });
    expect(rows[0].href).toBe("/jobs");
    const said = rowWords(rows[0], { isStaff: true, lang: "es", words: translator("es"), todayStr: TODAY, tz: TZ });
    expect(said.who).toBe(fillSlots(translator("es")("ny_who_unread"), { label: "Tareas Marcadas" }));
    expect(said.who).toMatch(/^Tareas Marcadas · /);
  });
});

describe("the row's doors", () => {
  it("Check Off sends do (task.complete) and Open the Job opens its Tasks tab; no ⋯, in both languages", async () => {
    state.tasks = [task({ id: "t-a" })];
    const row = (await build()).now.find((x) => x.id === "flagtask-t-a")!;
    expect(rowButtons(row, { isStaff: true })).toEqual({
      primary: { label: "Check Off", act: { type: "run", verb: "do" } },
      also: { label: "Open the Job", act: { type: "open", href: "/jobs/j1?tab=tasks" } },
      more: [],
    });
    const es = rowButtons(row, { isStaff: true, lang: "es", words: translator("es") });
    expect([es.primary?.label, es.also?.label]).toEqual(["Marcar como Hecha", "Abrir el Trabajo"]);
  });
});

describe("the source", () => {
  it("the feeder reads through the ONE open rule and its embed, never a hand-written open test", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    expect(src).toContain('import { OPEN_TASK_JOB, isMissingColumn, whereJobTaskOpen } from "@/lib/job-tasks";');
    const at = src.indexOf('.from("tasks")');
    const read = src.slice(at - 120, at + 400);
    expect(read).toContain("whereJobTaskOpen(");
    expect(read).toContain("${OPEN_TASK_JOB.replace(");
    expect(read).not.toMatch(/"jobs\.status"/);
  });
});
