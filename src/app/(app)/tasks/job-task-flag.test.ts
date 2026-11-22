import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE FLAG ON A JOB'S TASK (cn-v1179): setJobTaskFlag, and the two older doors that could write the same
 * column. The owner, 2026-11-22: "there are some tasks id like to flag as a reminder to do for certain
 * jobs sometimes [...] so maybe these tasks should go in the needs you under operations instead and
 * reminders can just be reminders".
 *
 * The flag is `tasks.priority` (flagged = priority > 0, stored 1 or 0). Only the office sets it on a
 * job's task; a zero-row write is said; a Reminder keeps its own flag. A small in-memory database
 * stands in: every read and write applies its filters for real, a "locked" row is one RLS won't let
 * this caller change (a zero-row UPDATE, the clean 204), and the profiles row carries the role and
 * the language.
 */

type Task = { id: string; job_id: string | null; status: "open" | "done"; priority: number; created_by: string };
type Profile = { id: string; role: string; language: string };
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn((p: string) => revalidated.push(p)) }));

import { createTask, setJobTaskFlag, updateTask } from "./actions";
import { dict } from "@/lib/i18n";

function standIn(opts: { me: string; profiles: Profile[]; tasks: Task[]; locked?: string[] }) {
  const tables: Record<string, any[]> = {
    profiles: opts.profiles.map((p) => ({ ...p })),
    tasks: opts.tasks.map((t) => ({ ...t })),
    jobs: [{ id: "job-larkspur", status: "in_progress" }],
  };
  const writes: { table: string; patch: Record<string, unknown> }[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: opts.me } } }) },
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      let patch: Record<string, unknown> | null = null;
      let inserting: any = null;
      const run = () => {
        const rows = tables[table] ?? [];
        if (inserting) {
          const r = { id: "new-task", ...inserting };
          rows.push(r);
          writes.push({ table, patch: inserting });
          return { data: [{ id: r.id }], error: null };
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (patch) {
          const changed = hit.filter((r) => !(opts.locked ?? []).includes(r.id));
          for (const r of changed) Object.assign(r, patch);
          writes.push({ table, patch });
          return { data: changed.map((r) => ({ id: r.id })), error: null };
        }
        return { data: hit, error: null };
      };
      const chain: any = {
        select: () => chain,
        insert: (r: any) => ((inserting = r), chain),
        update: (p: Record<string, unknown>) => ((patch = p), chain),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), chain),
        or: () => chain,
        gte: () => chain,
        // The duplicate check's exact-title match (wildcards escaped), honoured: a stand-in that ignored
        // it would answer every add with "already on the list".
        ilike: (c: string, v: string) => (filters.push((r) => String(r[c] ?? "").toLowerCase() === v.replace(/\\(.)/g, "$1").toLowerCase()), chain),
        limit: () => chain,
        single: async () => ({ data: run().data[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        then: (ok: any, err: any) => Promise.resolve(run()).then(ok, err),
      };
      return chain;
    },
  };
  return { client, tables, writes };
}

const PEOPLE: Profile[] = [
  { id: "u-office", role: "office", language: "en" },
  { id: "u-owner-es", role: "owner", language: "es" },
  { id: "u-tech", role: "tech", language: "en" },
  { id: "u-tech-es", role: "tech", language: "es" },
];
const TASKS = (): Task[] => [
  { id: "t-labels", job_id: "job-larkspur", status: "open", priority: 0, created_by: "u-office" },
  { id: "t-flagged", job_id: "job-larkspur", status: "open", priority: 1, created_by: "u-office" },
  { id: "t-done", job_id: "job-larkspur", status: "done", priority: 1, created_by: "u-office" },
  { id: "r-mine", job_id: null, status: "open", priority: 0, created_by: "u-tech" },
];
let db: ReturnType<typeof standIn>;
const as = (me: string, locked?: string[]) => {
  db = standIn({ me, profiles: PEOPLE, tasks: TASKS(), locked });
  state.client = db.client;
};
const task = (id: string) => db.tables.tasks.find((t) => t.id === id);

beforeEach(() => {
  revalidated.length = 0;
});

describe("setJobTaskFlag", () => {
  it("the office flags an open job task: priority 1, the job page and My Day revalidated", async () => {
    as("u-office");
    const res = await setJobTaskFlag("t-labels", true, { jobId: "job-larkspur" });
    expect(res).toEqual({ ok: true, flagged: true });
    expect(task("t-labels").priority).toBe(1);
    expect(revalidated).toContain("/planner");
    expect(revalidated).toContain("/jobs/job-larkspur");
  });

  it("un-flagging stores 0, and works on a task already checked off", async () => {
    as("u-office");
    expect(await setJobTaskFlag("t-flagged", false)).toEqual({ ok: true, flagged: false });
    expect(task("t-flagged").priority).toBe(0);
    expect(await setJobTaskFlag("t-done", false)).toEqual({ ok: true, flagged: false });
    expect(task("t-done").priority).toBe(0);
  });

  it("the write is ONLY the priority column (nothing else on the task moves)", async () => {
    as("u-office");
    await setJobTaskFlag("t-labels", true);
    expect(db.writes.filter((w) => w.table === "tasks").map((w) => w.patch)).toEqual([{ priority: 1 }]);
  });

  it("a tech is refused in one sentence, in his language, and nothing is written", async () => {
    as("u-tech");
    const res = await setJobTaskFlag("t-labels", true);
    expect(res).toEqual({ ok: false, error: dict("en").tk_flagStaffOnly });
    expect(task("t-labels").priority).toBe(0);
    expect(db.writes).toEqual([]);
    as("u-tech-es");
    expect(await setJobTaskFlag("t-labels", true)).toEqual({ ok: false, error: dict("es").tk_flagStaffOnly });
  });

  it("a zero-row write is said, never a silent ok", async () => {
    as("u-office", ["t-labels"]);
    const res = await setJobTaskFlag("t-labels", true);
    expect(res.ok).toBe(false);
    expect(res.error).toBe(dict("en").tk_noPermissionChange);
    as("u-office");
    expect(await setJobTaskFlag("t-gone", true)).toEqual({ ok: false, error: dict("en").tk_taskNotFound });
  });

  it("a Reminder is not a job task (its own flag lives on Tasks & Reminders); a checked-off task takes no new flag", async () => {
    as("u-owner-es");
    expect(await setJobTaskFlag("r-mine", true)).toEqual({ ok: false, error: dict("es").tk_flagJobTaskOnly });
    expect(await setJobTaskFlag("t-done", true)).toEqual({ ok: false, error: dict("es").tk_flagDoneTask });
    expect(db.writes).toEqual([]);
  });
});

describe("the older doors keep the flag the office's", () => {
  it("updateTask: a tech writing priority on a job task is refused; on his own Reminder it stands", async () => {
    as("u-tech");
    expect(await updateTask("t-labels", { priority: 1 })).toEqual({ ok: false, error: dict("en").tk_flagStaffOnly });
    expect(task("t-labels").priority).toBe(0);
    expect(await updateTask("r-mine", { priority: 1 })).toEqual({ ok: true });
    expect(task("r-mine").priority).toBe(1);
  });

  it("updateTask: the office writing priority on a job task stands", async () => {
    as("u-office");
    expect(await updateTask("t-labels", { priority: 1 })).toEqual({ ok: true });
    expect(task("t-labels").priority).toBe(1);
  });

  it("createTask: a tech's job task with a priority is refused; without one it saves at 0", async () => {
    as("u-tech");
    expect(await createTask({ title: "Print panel labels", job_id: "job-larkspur", priority: 1 })).toEqual({ ok: false, error: dict("en").tk_flagStaffOnly });
    const res = await createTask({ title: "Print panel labels", job_id: "job-larkspur" });
    expect(res.ok).toBe(true);
    expect(db.writes.find((w) => w.table === "tasks")?.patch.priority).toBe(0);
  });
});

/**
 * L1: THE OLDER RULES THAT READ OR WRITE `priority` (cn-v1179's lens). Read from the source, because
 * each is a statement its own tests already exercise; these pins keep the flag's meaning from being
 * reset or misread by a later edit.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const updatePatches = (s: string) => [...s.matchAll(/from\("tasks"\)\s*\.update\(\{([^}]*)\}/g)].map((m) => m[1]);

describe("L1: nothing older resets the flag or picks a flagged job task up", () => {
  it("(a) the estimate sync, the birth and the visit doors never write priority on a task", () => {
    const sync = src("src/lib/estimate/sync-job-tasks.ts");
    const born = src("src/lib/estimate/born-with-tasks.ts");
    const appts = src("src/app/(app)/appointments/actions.ts");
    // The sync's task updates are its re-key (source_key), its tombstone (source_key), its minutes and
    // its rename (title): none carries priority.
    expect(updatePatches(sync).length).toBeGreaterThanOrEqual(4);
    for (const p of updatePatches(sync)) expect(p).not.toMatch(/priority/);
    // The birth and the visit doors never name the column at all.
    for (const s of [born, appts]) expect(s).not.toMatch(/priority/);
    // RE-PINNED ON PURPOSE (cn-v1179, the seam this lane reported): the sync now READS the flag, because
    // its orphan rule met a shape it was never written for: a flagged open task whose estimate line went
    // away read as bare and was DELETED, flag and all. It reads priority (a flagged task is his, kept
    // like one with notes) and its delete is conditional on it; it still never WRITES it. The behaviour
    // is proven in lib/estimate/sync-job-tasks.test.ts.
    expect(sync).toMatch(/isHisTask = \(t: Pick<LineTask, "notes" \| "photo_path" \| "has_steps" \| "priority">\)/);
    expect(sync).toMatch(/\.delete\(\)\.in\("id", plan\.remove\)[^;]*\.eq\("priority", 0\)/);
    expect(sync).not.toMatch(/priority:\s/); // no patch and no insert carries the column
  });

  it("(b) My Day's Reminders cut and the morning six read job_id null only", () => {
    const planner = src("src/app/(app)/planner/page.tsx");
    expect(planner).toContain('(q as any).is("job_id", null).or(');
    // The morning push and the card share ONE pool rule (lib/six-rank rankPoolQuery), fed the same cut.
    const digest = src("src/lib/action-items/digest.ts");
    expect(digest).toMatch(/\.is\("job_id", null\)/);
  });

  it("(c) checking off, closeJobTasks and a reopen leave nothing flagged AND open that should not be", () => {
    // A flagged task is on Needs You only while OPEN: a check-off (toggleTask) and closeJobTasks write
    // status done (the flag stays, read by no one while done). A reopened job reopens no task, so no
    // closed flagged task comes back open on its own.
    const jt = src("src/lib/job-tasks.ts");
    expect(jt).toMatch(/\.update\(\{ status: "done", completed_at: new Date\(\)\.toISOString\(\), done_by: by \?\? null \}\)/);
    expect(jt).toContain("REOPENING A JOB DOES NOT REOPEN THEM");
    expect(jt).not.toMatch(/update\(\{[^}]*status: "open"/);
  });
});
