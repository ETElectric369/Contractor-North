import { describe, it, expect } from "vitest";
import { fakeDb } from "@/test/fake-supabase";
import { estimateLines, hoursWords, isHisTask, planLineSync, retitleLineTask, syncJobTasks, syncWords, type LineTask, type SyncResult } from "./sync-job-tasks";
import type { BornTask } from "./born-with-tasks";

/**
 * A JOB FOLLOWS ITS ESTIMATE. The job's line tasks are the task lines of its accepted estimates; what he
 * added to a task is his; the size follows only while it is still the estimate's figure. The plan is
 * pure; the sync is run against the thenable fake so every write is seen to select what it wrote.
 * Names are stand-ins ("Bayberry"), never a customer's.
 */
const wanted = (over: Partial<BornTask> & { source_key: string }): BornTask => ({ title: "Trench", sort_order: 0, ...over });
const have = (over: Partial<LineTask> & { id: string }): LineTask => ({
  source_key: `line:${over.id}`, title: "Trench", status: "open", notes: null, photo_path: null, ...over,
});
const result = (over: Partial<SyncResult> = {}): SyncResult => ({ inserted: 0, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: false, ...over });

describe("planLineSync — the plan", () => {
  it("keeps a task whose line is still on an accepted estimate, and inserts the wanted ones nobody has", () => {
    const plan = planLineSync([wanted({ source_key: "line:a" }), wanted({ source_key: "line:b", title: "Set the panel", sort_order: 1 })], [have({ id: "a" })]);
    expect(plan.rekey).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.kept).toEqual([]);
    expect(plan.insert).toEqual([{ source_key: "line:b", title: "Set the panel", sort_order: 1 }]);
  });

  it("re-keys an orphan to the line that now carries its exact title (the builder's new ids), done or open, instead of remove + insert", () => {
    const plan = planLineSync(
      [wanted({ source_key: "line:new1" }), wanted({ source_key: "line:new2", title: "Set the panel", sort_order: 1 })],
      [have({ id: "old1" }), have({ id: "old2", title: "Set the panel", status: "done" })],
    );
    expect(plan.rekey).toEqual([
      { id: "old1", source_key: "line:new1" },
      { id: "old2", source_key: "line:new2" },
    ]);
    expect(plan.insert).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("an OPEN orphan claims a name before a done one (a done task on a new line would hide new work); the done one is kept", () => {
    const plan = planLineSync([wanted({ source_key: "line:new" })], [have({ id: "done", status: "done" }), have({ id: "open" })]);
    expect(plan.rekey).toEqual([{ id: "open", source_key: "line:new" }]);
    expect(plan.kept.map((t) => t.id)).toEqual(["done"]);
    expect(plan.remove).toEqual([]);
  });

  it("matches by EXACT title: a renamed-and-rebuilt task is new, and the bare open orphan goes", () => {
    const plan = planLineSync([wanted({ source_key: "line:new1", title: "Trench to the shed" })], [have({ id: "old1" })]);
    expect(plan.insert.map((t) => t.source_key)).toEqual(["line:new1"]);
    expect(plan.remove).toEqual(["old1"]);
  });

  it("never re-keys onto a line whose task already exists by key (no duplicates)", () => {
    const plan = planLineSync([wanted({ source_key: "line:a" })], [have({ id: "a" }), have({ id: "orphan" })]);
    expect(plan.rekey).toEqual([]);
    expect(plan.remove).toEqual(["orphan"]);
  });

  it("removes an open, bare orphan; keeps one that is done, has steps, or carries his notes or a photo — and says so", () => {
    const plan = planLineSync(
      [],
      [
        have({ id: "bare" }),
        have({ id: "done", status: "done" }),
        have({ id: "noted", notes: "Call before digging" }),
        have({ id: "shot", photo_path: "jobs/x/y.jpg" }),
        have({ id: "stepped", has_steps: true }),
        have({ id: "blank-notes", notes: "   " }),
      ],
    );
    expect(plan.remove).toEqual(["bare", "blank-notes"]);
    expect(plan.kept.map((t) => t.id)).toEqual(["done", "noted", "shot", "stepped"]);
  });

  it("a key he dismissed by hand is never inserted and never re-keyed into", () => {
    const plan = planLineSync(
      [wanted({ source_key: "line:a" }), wanted({ source_key: "line:b", title: "Set the panel", sort_order: 1 })],
      [have({ id: "orphan" })],
      new Set(["line:a"]),
    );
    expect(plan.insert.map((t) => t.source_key)).toEqual(["line:b"]);
    expect(plan.rekey).toEqual([]); // the orphan "Trench" would have matched line:a by name
    expect(plan.remove).toEqual(["orphan"]);
  });

  it("isHisTask: notes with words, a photo or steps; blank notes are not his", () => {
    expect(isHisTask({ notes: null, photo_path: null })).toBe(false);
    expect(isHisTask({ notes: "  ", photo_path: null })).toBe(false);
    expect(isHisTask({ notes: "x", photo_path: null })).toBe(true);
    expect(isHisTask({ notes: null, photo_path: "p" })).toBe(true);
    expect(isHisTask({ notes: null, photo_path: null, has_steps: true })).toBe(true);
  });
});

const taskLine = (id: string, quote_id: string, description: string, hours: number | null, sort_order: number, extra: Record<string, unknown> = {}) => ({
  id, quote_id, description, sort_order, detail: { task_id: `t-${id}`, hours, rate: 100, units: null, kit_id: null, materials: [] }, ...extra,
});
const plain = (id: string, quote_id: string, sort_order: number) => ({ id, quote_id, description: "Permit", sort_order, detail: null });

describe("planLineSync — the deferred items (cn-v1084)", () => {
  it("a dismissal that remembers the title bars the same task on a rebuilt line (the builder's new id): left off and said, the dismissal MOVED to the new key", () => {
    const plan = planLineSync([wanted({ source_key: "line:NEW" })], [], new Set(["line:OLD#Trench"]));
    expect(plan.insert).toEqual([]);
    expect(plan.leftOff).toEqual(["Trench"]);
    expect(plan.consumed).toEqual(["line:OLD#Trench"]);
    expect(plan.redismiss).toEqual(["line:NEW#Trench"]);
  });
  it("two rebuilds: one deletion stays ONE entry, so a second same-titled line is new work and a live task is never lost (the skeptic's case)", () => {
    // Two "Install outlet" lines; he deleted the second task. Rebuild 1: T1 claims L1', L2' is left off, the entry moves.
    const w1 = [wanted({ source_key: "line:L1b", title: "Install outlet" }), wanted({ source_key: "line:L2b", title: "Install outlet", sort_order: 1 })];
    const p1 = planLineSync(w1, [have({ id: "T1", source_key: "line:L1", title: "Install outlet" })], new Set(["line:L2#Install outlet"]));
    expect(p1.rekey).toEqual([{ id: "T1", source_key: "line:L1b" }]);
    expect(p1.leftOff).toEqual(["Install outlet"]);
    expect(p1.consumed).toEqual(["line:L2#Install outlet"]);
    expect(p1.redismiss).toEqual(["line:L2b#Install outlet"]);
    // What the sync writes: the consumed entry gone, the new one in. Rebuild 2 with that list: the same shape, T1 kept.
    const after1 = ["line:L2b#Install outlet"];
    const w2 = [wanted({ source_key: "line:L1c", title: "Install outlet" }), wanted({ source_key: "line:L2c", title: "Install outlet", sort_order: 1 })];
    const p2 = planLineSync(w2, [have({ id: "T1", source_key: "line:L1b", title: "Install outlet" })], new Set(after1));
    expect(p2.rekey).toEqual([{ id: "T1", source_key: "line:L1c" }]);
    expect(p2.remove).toEqual([]);
    expect(p2.leftOff).toEqual(["Install outlet"]);
    expect(p2.redismiss).toEqual(["line:L2c#Install outlet"]);
  });
  it("a live task of the dismissed title claims BEFORE the bar: a dismissal never costs a task that is there", () => {
    const plan = planLineSync([wanted({ source_key: "line:NEW" })], [have({ id: "T", source_key: "line:OLD" })], new Set(["line:GONE#Trench"]));
    expect(plan.rekey).toEqual([{ id: "T", source_key: "line:NEW" }]);
    expect(plan.remove).toEqual([]);
    expect(plan.leftOff).toEqual([]);
    expect(plan.consumed).toEqual([]);
  });
  it("a dismissal whose line is still current bars only that line — the same title on another line is new work", () => {
    const plan = planLineSync([wanted({ source_key: "line:a" }), wanted({ source_key: "line:b", sort_order: 1 })], [], new Set(["line:a#Trench"]));
    expect(plan.insert.map((t) => t.source_key)).toEqual(["line:b"]);
    expect(plan.redismiss).toEqual([]);
  });
  it("a visit's task finds the line built from it by the task id the line remembers — done or open, whatever its name — else by exact title; one with no line stays", () => {
    const w = [wanted({ source_key: "line:a", title: "Trench ×2", task_id: "T1" }), wanted({ source_key: "line:b", title: "Set the panel", task_id: "T2", sort_order: 1 })];
    const others = [
      { id: "v1", source_key: "task:T1", title: "Old name", status: "done" },
      { id: "v2", source_key: "task:T9", title: "Set the panel", status: "open" },
      { id: "v3", source_key: "task:T8", title: "Nothing like it", status: "open" },
    ];
    const plan = planLineSync(w, [], new Set(), others);
    expect(plan.rekey).toEqual([{ id: "v1", source_key: "line:a" }, { id: "v2", source_key: "line:b" }]);
    expect(plan.insert).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.kept).toEqual([]);
  });
  it("an OPEN task he made by hand under the same exact title becomes the line's (re-keyed, said as matched); a done one does not bar new work", () => {
    const w = [wanted({ source_key: "line:a" }), wanted({ source_key: "line:b", title: "Set the panel", sort_order: 1 })];
    const others = [
      { id: "h1", source_key: null, title: "Trench", status: "open" },
      { id: "h2", source_key: null, title: "Set the panel", status: "done" },
    ];
    const plan = planLineSync(w, [], new Set(), others);
    expect(plan.rekey).toEqual([{ id: "h1", source_key: "line:a" }]);
    expect(plan.insert.map((t) => t.source_key)).toEqual(["line:b"]);
  });
  it("a kept orphan goes under the tombstone, so it is said this once — and is the line's again when that line returns", () => {
    const plan = planLineSync([], [have({ id: "k", status: "done" }), have({ id: "gone" })]);
    expect(plan.kept.map((t) => t.id)).toEqual(["k"]);
    expect(plan.tombstone).toEqual([{ id: "k", source_key: "gone:line:k" }]);
    expect(plan.remove).toEqual(["gone"]);
    // The estimate comes back (moved away and back): the tombstone is restored, nothing inserted, nothing said as kept.
    const back = planLineSync([wanted({ source_key: "line:k" })], [have({ id: "k", status: "done", gone: true })]);
    expect(back.rekey).toEqual([{ id: "k", source_key: "line:k" }]);
    expect(back.insert).toEqual([]);
    expect(back.kept).toEqual([]);
    // A tombstone whose line stays gone is left alone: not kept again, not removed.
    const still = planLineSync([], [have({ id: "k", status: "done", gone: true })]);
    expect(still).toMatchObject({ insert: [], rekey: [], remove: [], kept: [], tombstone: [] });
  });
});

describe("estimateLines — the accepted estimates' task lines, in order", () => {
  it("reads only ACCEPTED estimates of the job, offsets a later-ACCEPTED estimate past the earlier one, and sums his hours", async () => {
    const { sb } = fakeDb({
      quotes: [
        // q2 was CREATED first but ACCEPTED second: it sits after q1.
        { id: "q1", job_id: "j1", status: "accepted", created_at: "2026-10-03", accepted_at: "2026-10-04" },
        { id: "q2", job_id: "j1", status: "accepted", created_at: "2026-10-01", accepted_at: "2026-10-05" },
        { id: "q3", job_id: "j1", status: "declined", created_at: "2026-10-06", accepted_at: null },
        { id: "q9", job_id: "other", status: "accepted", created_at: "2026-10-02", accepted_at: "2026-10-02" },
      ],
      quote_line_items: [
        taskLine("b", "q2", "Phase two", 1.5, 0),
        plain("p", "q1", 1),
        taskLine("a", "q1", "Trench", 2, 0),
        taskLine("a2", "q1", "Set the panel", null, 2),
        taskLine("x", "q3", "Declined work", 8, 0),
        taskLine("y", "q9", "Another job", 8, 0),
      ],
    });
    const est = await estimateLines(sb, { jobId: "j1", orgId: null });
    expect(est.error).toBeUndefined();
    expect(est.lines.map((l) => [l.id, l.sort_order])).toEqual([["a", 0], ["p", 1], ["a2", 2], ["b", 3]]);
    expect(est.minutes).toBe(210); // 2 h + 1.5 h; the hole asks, the plain line is not a task
    // Each task line's own figure, by key — what a door hands back as `tasksBefore` (0395).
    expect([...est.taskMinutes]).toEqual([["line:a", 120], ["line:a2", null], ["line:b", 90]]);
  });

  it("`except` leaves one estimate out — the figure before THIS acceptance", async () => {
    const { sb } = fakeDb({
      quotes: [
        { id: "q1", job_id: "j1", status: "accepted", created_at: "2026-10-01", accepted_at: "2026-10-01" },
        { id: "q2", job_id: "j1", status: "accepted", created_at: "2026-10-02", accepted_at: "2026-10-02" },
      ],
      quote_line_items: [taskLine("a", "q1", "Trench", 2, 0), taskLine("b", "q2", "Phase two", 1, 0)],
    });
    expect((await estimateLines(sb, { jobId: "j1", orgId: null, except: "q2" })).minutes).toBe(120);
    expect((await estimateLines(sb, { jobId: "j1", orgId: null, except: "q1" })).minutes).toBe(60);
    expect(await estimateLines(sb, { jobId: "j1", orgId: null, except: "q1" }).then((e) => e.lines.map((l) => l.sort_order))).toEqual([0]);
  });

  it("no accepted estimate → no lines, no figure, no second read", async () => {
    const est = await estimateLines(fakeDb({ quotes: [{ id: "q1", job_id: "j1", status: "sent" }] }).sb, { jobId: "j1", orgId: null });
    expect(est).toEqual({ lines: [], minutes: null, taskMinutes: new Map() });
  });
});

const db = (
  over: { tasks?: Record<string, unknown>[]; lines?: Record<string, unknown>[]; planned?: number | null; quotes?: Record<string, unknown>[]; dismissed?: string[] } = {},
  opts?: Parameters<typeof fakeDb>[1],
) =>
  fakeDb(
    {
      quotes: over.quotes ?? [{ id: "q1", job_id: "j1", status: "accepted", created_at: "2026-10-01", accepted_at: "2026-10-01" }],
      quote_line_items: over.lines ?? [taskLine("a", "q1", "Trench", 2, 0), taskLine("b", "q1", "Set the panel", 1, 1)],
      tasks: over.tasks ?? [],
      jobs: [{ id: "j1", planned_minutes: over.planned === undefined ? null : over.planned, dismissed_task_keys: over.dismissed ?? [] }],
    },
    opts,
  );
// A row as the database holds it: every column present, the minutes null until something writes them (0395).
const task = (over: Record<string, unknown>) => ({ job_id: "j1", status: "open", notes: null, photo_path: null, parent_id: null, planned_minutes: null, ...over });

describe("syncJobTasks — the writes", () => {
  it("inserts the wanted tasks nobody has, through the birth's own insert (source_key, title, sort_order, category null)", async () => {
    const { sb, tables, inserted } = db();
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res).toEqual(result({ inserted: 2 }));
    expect(inserted.tasks.map((t) => [t.source_key, t.title, t.sort_order, t.category, t.job_id, t.created_by])).toEqual([
      ["line:a", "Trench", 0, null, "j1", "u1"],
      ["line:b", "Set the panel", 1, null, "j1", "u1"],
    ]);
    expect(tables.tasks).toHaveLength(2);
  });

  it("re-keys orphans by exact title, removes the bare open orphan, keeps his — and touches no visit or hand task", async () => {
    const { sb, tables, inserted } = db({
      tasks: [
        task({ id: "t1", source_key: "line:old-a", title: "Trench", status: "done" }),
        task({ id: "t2", source_key: "line:gone", title: "Old scope" }),
        task({ id: "t3", source_key: "line:gone2", title: "Old noted", notes: "Keep" }),
        task({ id: "t4", source_key: "task:v1", title: "From the visit" }),
        task({ id: "t5", source_key: null, title: "By hand" }),
      ],
    });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res).toEqual(result({ inserted: 1, rekeyed: 1, removed: 1, kept: 1, timed: 1, keptNames: ["Old noted"] }));
    const byId = Object.fromEntries(tables.tasks.map((t) => [t.id, t]));
    expect(byId.t1.source_key).toBe("line:a"); // done, re-keyed, still done
    expect(byId.t1.status).toBe("done");
    expect(byId.t1.planned_minutes).toBe(120); // it had no minutes of its own: the line's (0395)
    expect(byId.t2).toBeUndefined(); // bare and open: gone
    expect(byId.t3.source_key).toBe("gone:line:gone2"); // his notes: kept, under the tombstone so "kept" is said this once (cn-v1084)
    expect(byId.t3.notes).toBe("Keep");
    expect(byId.t4.source_key).toBe("task:v1"); // a visit's task that matches no line stays the visit's
    expect(byId.t5.source_key).toBe(null);
    expect(inserted.tasks.map((t) => t.source_key)).toEqual(["line:b"]);
  });

  it("a line task with steps under it is kept (0055 would cascade the delete to the steps)", async () => {
    const { sb, tables } = db({
      lines: [],
      tasks: [task({ id: "parent", source_key: "line:gone", title: "Rough in" }), task({ id: "step", source_key: null, title: "Pull wire", parent_id: "parent" })],
    });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res).toEqual(result({ kept: 1, keptNames: ["Rough in"] }));
    expect(tables.tasks.map((t) => t.id)).toEqual(["parent", "step"]);
  });

  it("a key he dismissed by hand (jobs.dismissed_task_keys) is not born again", async () => {
    const { sb, inserted } = db({ dismissed: ["line:a"] });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res).toEqual(result({ inserted: 1 }));
    expect(inserted.tasks.map((t) => t.source_key)).toEqual(["line:b"]);
  });

  it("a done orphan is kept, named, and stays in the table", async () => {
    const { sb, tables } = db({ lines: [], tasks: [task({ id: "t1", source_key: "line:gone", title: "Trench", status: "done" })] });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res).toEqual(result({ kept: 1, keptNames: ["Trench"] }));
    expect(tables.tasks).toHaveLength(1);
  });

  it("a task he deleted stays gone through a rebuild: the title in the dismissal bars the new line (left off, said) and the dismissal MOVES to the new key", async () => {
    const { sb, inserted, tables } = db({ dismissed: ["line:OLD#Trench"] });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res).toEqual(result({ inserted: 1, leftOff: ["Trench"] }));
    expect(inserted.tasks.map((t) => t.source_key)).toEqual(["line:b"]);
    expect(tables.jobs[0].dismissed_task_keys).toEqual(["line:a#Trench"]);
    expect(syncWords(res)).toBe("The job's list follows the estimate: 1 task added · 1 left off (Trench) — deleted from the job before.");
  });
  it("a visit's task is re-keyed to the line built from it (the id the line remembers) and an open hand task to its twin — both said as matched", async () => {
    // The fixture's lines remember tasks "t-a" and "t-b" (taskLine).
    const { sb, tables, inserted } = db({
      tasks: [task({ id: "v", source_key: "task:t-a", title: "Trench, as the visit said it", status: "done" }), task({ id: "h", source_key: null, title: "Set the panel" })],
    });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res).toEqual(result({ rekeyed: 2, timed: 2 }));
    expect(tables.tasks.find((t) => t.id === "v")?.source_key).toBe("line:a");
    expect(tables.tasks.find((t) => t.id === "h")?.source_key).toBe("line:b");
    expect(inserted.tasks ?? []).toEqual([]);
    expect(syncWords(res)).toBe("The job's list follows the estimate: 2 matched · 2 tasks' hours updated.");
  });
  it("a kept orphan is said once: it goes under the tombstone, the next sync says nothing, and the line finds it again if it returns", async () => {
    const { sb, tables } = db({ lines: [], tasks: [task({ id: "k", source_key: "line:a", title: "Trench", notes: "Keep" })] });
    const first = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(first).toEqual(result({ kept: 1, keptNames: ["Trench"] }));
    expect(tables.tasks.find((t) => t.id === "k")?.source_key).toBe("gone:line:a");
    const again = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(again).toEqual(result());
    // The estimate's line "a" is back: the task is the line's again, no second copy.
    tables.quote_line_items.push(taskLine("a", "q1", "Trench", 2, 0));
    const back = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(back).toEqual(result({ rekeyed: 1, timed: 1 }));
    expect(tables.tasks).toHaveLength(1);
    expect(tables.tasks[0].source_key).toBe("line:a");
  });
  it("a visit's task whose line another door just filled (23505) is not swallowed: it is on the list twice, said by name", async () => {
    const { sb } = db({ tasks: [task({ id: "v", source_key: "task:t-a", title: "Trench" })] }, { onUpdate: (table, patch) => (table === "tasks" && patch.source_key === "line:a" ? { code: "23505", message: "duplicate key" } : undefined) });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res.twice).toEqual(["Trench"]);
    expect(syncWords(res)).toContain("1 on the list twice (Trench) — remove one");
  });
  it("is idempotent: a second run changes nothing", async () => {
    const { sb, tables } = db();
    await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    const again = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(again).toEqual(result());
    expect(tables.tasks).toHaveLength(2);
  });

  it("the words: what the list did, or nothing when nothing changed", () => {
    expect(syncWords(result())).toBeNull();
    expect(syncWords(result({ rekeyed: 3 }))).toBe("The job's list follows the estimate: 3 matched.");
    expect(syncWords(result({ rekeyed: 1 }), "The job it left (J-047) follows too")).toBe("The job it left (J-047) follows too: 1 matched.");
    expect(syncWords(result({ inserted: 2, removed: 1, kept: 1, keptNames: ["Trench"], sizeSet: true, sizeNow: 180 }))).toBe(
      "The job's list follows the estimate: 2 tasks added · 1 removed · 1 kept (Trench) — done, or with notes, a photo or steps · the job's length is now 3 h.",
    );
    expect(syncWords(result({ inserted: 1, kept: 4, keptNames: ["A", "B", "C", "D"], sizeStays: { box: 480, estimate: 90 } }))).toBe(
      "The job's list follows the estimate: 1 task added · 4 kept (A, B, C, …) — done, or with notes, a photo or steps · the job's length stays at 8 h (the estimate now says 1.5 h).",
    );
    expect(hoursWords(null)).toBe("none");
    expect(hoursWords(100)).toBe("1.7 h");
  });
});

describe("syncJobTasks — the size follows only while it is the estimate's figure", () => {
  it("a job never sized takes the estimate's figure (sizeBefore null, box null)", async () => {
    const { sb, tables } = db({ planned: null });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1", sizeBefore: null });
    expect(res.sizeSet).toBe(true);
    expect(res.sizeNow).toBe(180);
    expect(tables.jobs[0].planned_minutes).toBe(180);
  });

  it("the box still holds the old figure → it follows to the new one; a deleted task's hours leave", async () => {
    // Before the delete the estimate said 180 (2 h + 1 h) and the box held 180; now the 1 h line is gone.
    const { sb, tables } = db({ planned: 180, lines: [taskLine("a", "q1", "Trench", 2, 0)] });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1", sizeBefore: 180 });
    expect(res.sizeSet).toBe(true);
    expect(tables.jobs[0].planned_minutes).toBe(120);
  });

  it("his own figure stands (the box differs from the old estimate figure) — and that is SAID with both figures", async () => {
    const { sb, tables } = db({ planned: 480 });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1", sizeBefore: 120 });
    expect(res.sizeSet).toBe(false);
    expect(res.sizeStays).toEqual({ box: 480, estimate: 180 });
    expect(tables.jobs[0].planned_minutes).toBe(480);
    expect(syncWords(res)).toContain("the job's length stays at 8 h (the estimate now says 3 h)");
  });

  it("a walk-back and re-accept: the old figure left the accepted set, so the box stays and both figures are said", async () => {
    // Accepted at 3 h (box 180), walked back to sent, hours lowered to 2 h, accepted again: the door's
    // sizeBefore is the OTHER accepted estimates' figure (none → null), the box still says 180.
    const { sb, tables } = db({ planned: 180, lines: [taskLine("a", "q1", "Trench", 2, 0)] });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1", sizeBefore: null });
    expect(res.sizeSet).toBe(false);
    expect(res.sizeStays).toEqual({ box: 180, estimate: 120 });
    expect(tables.jobs[0].planned_minutes).toBe(180);
  });

  it("a visit-sized job (box set, estimate had no figure before) keeps its own size", async () => {
    const { sb, tables } = db({ planned: 480 });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1", sizeBefore: null });
    expect(res.sizeSet).toBe(false);
    expect(tables.jobs[0].planned_minutes).toBe(480);
  });

  it("when every hour leaves, the estimate's figure goes back to none (null), never zero", async () => {
    const { sb, tables } = db({ planned: 180, lines: [taskLine("a", "q1", "Trench", null, 0)] });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1", sizeBefore: 180 });
    expect(res.sizeSet).toBe(true);
    expect(res.sizeNow).toBe(null);
    expect(tables.jobs[0].planned_minutes).toBe(null);
  });

  it("no sizeBefore → the size is never touched and nothing about it is said", async () => {
    const { sb, tables } = db({ planned: null });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res.sizeSet).toBe(false);
    expect(res.sizeStays).toBeUndefined();
    expect(tables.jobs[0].planned_minutes).toBe(null);
  });

  it("unchanged figure → no write, nothing said", async () => {
    const { sb, tables } = db({ planned: 180 });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1", sizeBefore: 180 });
    expect(res.sizeSet).toBe(false);
    expect(res.sizeStays).toBeUndefined();
    expect(tables.jobs[0].planned_minutes).toBe(180);
  });
});

describe("syncJobTasks — a task's own minutes follow its line under the size's rule (0395)", () => {
  // The fixture's lines say Trench 2 h (line:a) and Set the panel 1 h (line:b).
  const lineTasks = (over: { a?: number | null; b?: number | null } = {}) => [
    task({ id: "ta", source_key: "line:a", title: "Trench", planned_minutes: over.a === undefined ? 120 : over.a }),
    task({ id: "tb", source_key: "line:b", title: "Set the panel", planned_minutes: over.b === undefined ? 60 : over.b }),
  ];

  it("a task born before the column (null) takes the line's figure, with or without a before-figure", async () => {
    const { sb, tables } = db({ tasks: lineTasks({ a: null, b: null }) });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res).toEqual(result({ timed: 2 }));
    expect(tables.tasks.map((t) => t.planned_minutes)).toEqual([120, 60]);
    expect(syncWords(res)).toBe("The job's list follows the estimate: 2 tasks' hours updated.");
  });

  it("the line's hours changed: a task still holding the OLD line figure follows; one he set on the job stays, said by name", async () => {
    // Before the edit line:a said 3 h (180) and line:b 1 h (60); now they say 2 h and 1 h.
    const { sb, tables } = db({ tasks: lineTasks({ a: 180, b: 45 }) });
    const before = new Map<string, number | null>([["line:a", 180], ["line:b", 60]]);
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1", tasksBefore: before });
    expect(res).toEqual(result({ timed: 1, hoursStay: ["Set the panel"] }));
    expect(tables.tasks.map((t) => t.planned_minutes)).toEqual([120, 45]);
    expect(syncWords(res)).toBe("The job's list follows the estimate: 1 task's hours updated · 1 kept its hours (Set the panel) — set on the job.");
  });

  it("without a before-figure a task with minutes of its own stays — the sync never guesses whose figure it is", async () => {
    const { sb, tables } = db({ tasks: lineTasks({ a: 180 }) });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res).toEqual(result({ hoursStay: ["Trench"] }));
    expect(tables.tasks[0].planned_minutes).toBe(180);
  });

  it("an unchanged figure is no write and no news; a re-keyed task follows by the key it HAD", async () => {
    const quiet = db({ tasks: lineTasks() });
    expect(await syncJobTasks(quiet.sb, { jobId: "j1", orgId: null, createdBy: "u1", tasksBefore: new Map([["line:a", 120]]) })).toEqual(result());
    // The builder re-id'd the line (old key line:OLD, 3 h then); the task holds that old figure → it follows to line:a's 2 h.
    const { sb, tables } = db({ tasks: [task({ id: "t", source_key: "line:OLD", title: "Trench", planned_minutes: 180 })] });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1", tasksBefore: new Map([["line:OLD", 180]]) });
    expect(res).toEqual(result({ inserted: 1, rekeyed: 1, timed: 1 }));
    expect(tables.tasks.find((t) => t.id === "t")?.planned_minutes).toBe(120);
  });

  it("a figure typed between the read and the write wins (zero rows is that answer, not a failure)", async () => {
    const { sb, tables } = db({ tasks: lineTasks({ a: null }) }, {
      onUpdate: (table, patch) => {
        if (table === "tasks" && "planned_minutes" in patch) tables.tasks[0].planned_minutes = 999; // he typed meanwhile
        return undefined;
      },
    });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res).toEqual(result());
    expect(tables.tasks[0].planned_minutes).toBe(999);
  });
});

describe("syncJobTasks — says when it could not", () => {
  it("a refused insert is the answer, not a quiet success", async () => {
    const { sb } = fakeDb(
      {
        quotes: [{ id: "q1", job_id: "j1", status: "accepted" }],
        quote_line_items: [taskLine("a", "q1", "Trench", 2, 0)],
        tasks: [],
        jobs: [{ id: "j1", planned_minutes: null, dismissed_task_keys: [] }],
      },
      { onInsert: (table) => (table === "tasks" ? { code: "42501", message: "permission denied" } : undefined) },
    );
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: null, createdBy: "u1" });
    expect(res.error).toBeTruthy();
    expect(res.inserted).toBe(0);
  });

  it("a job it cannot read is said", async () => {
    const res = await syncJobTasks(db().sb, { jobId: "nope", orgId: null, createdBy: "u1" });
    expect(res.error).toBe("That job could not be read.");
  });

  it("scopes every read and write to the company when told who", async () => {
    const { sb, inserted } = fakeDb({
      quotes: [{ id: "q1", job_id: "j1", status: "accepted", org_id: "o1" }, { id: "q2", job_id: "j1", status: "accepted", org_id: "o2" }],
      quote_line_items: [taskLine("a", "q1", "Trench", 2, 0, { org_id: "o1" }), taskLine("z", "q2", "Not ours", 2, 0, { org_id: "o2" })],
      tasks: [],
      jobs: [{ id: "j1", org_id: "o1", planned_minutes: null, dismissed_task_keys: [] }],
    });
    const res = await syncJobTasks(sb, { jobId: "j1", orgId: "o1", createdBy: "u1", sizeBefore: null });
    expect(res.error).toBeUndefined();
    expect(inserted.tasks.map((t) => [t.source_key, t.org_id])).toEqual([["line:a", "o1"]]);
    expect(res.sizeSet).toBe(true);
  });
});

describe("retitleLineTask — a rename follows only while the task still reads as the line put it", () => {
  const tasks = () => [{ id: "t1", job_id: "j1", source_key: "line:a", title: "Trench", status: "open" }];
  it("renames the task that still carries the old words, and reads the write back", async () => {
    const { sb, tables } = fakeDb({ tasks: tasks() });
    expect(await retitleLineTask(sb, { jobId: "j1", orgId: null, lineId: "a", from: "Trench", to: "Trench to the shed" })).toEqual({ renamed: true });
    expect(tables.tasks[0].title).toBe("Trench to the shed");
  });
  it("a task he renamed by hand stands — zero rows is that answer, not a failure", async () => {
    const { sb, tables } = fakeDb({ tasks: [{ ...tasks()[0], title: "His own words" }] });
    expect(await retitleLineTask(sb, { jobId: "j1", orgId: null, lineId: "a", from: "Trench", to: "Trench to the shed" })).toEqual({ renamed: false });
    expect(tables.tasks[0].title).toBe("His own words");
  });
  it("nothing to rename when the words did not change or the new name is blank", async () => {
    const { sb } = fakeDb({ tasks: tasks() });
    expect(await retitleLineTask(sb, { jobId: "j1", orgId: null, lineId: "a", from: "Trench", to: " Trench " })).toEqual({ renamed: false });
    expect(await retitleLineTask(sb, { jobId: "j1", orgId: null, lineId: "a", from: "Trench", to: "" })).toEqual({ renamed: false });
  });
});
