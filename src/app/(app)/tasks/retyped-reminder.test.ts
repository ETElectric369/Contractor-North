import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * DEFECT 3, AS ERIK WOULD HIT IT. He types a reminder he has typed before, the duplicate check hands
 * back the row that already exists (right — nothing should mint a twin), and then: nothing. A grey
 * "Already on the list" and a card that looks exactly as it did. If the row it collapsed onto is one
 * no surface was showing him — waiting on a day next month, or an undated office task — then "already
 * on the list" was true about a list he could not see, and the toast gave him no door.
 *
 * These cases run the REAL createTask against an in-memory tasks table, and assert on what is IN THE
 * ROW afterwards and what the sentence says. Not on source text: the broken version's source read
 * perfectly well.
 */

type Row = Record<string, any>;
const db: { tasks: Row[]; jobs: Row[]; writes: number } = { tasks: [], jobs: [], writes: 0 };
const UID = "erik";

/** Enough of PostgREST's chain for this door: the filters it uses, applied to the array. */
function table(name: "tasks" | "jobs") {
  const tests: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  let inserted: Row | null = null;
  const rows = () => db[name].filter((r) => tests.every((t) => t(r)));
  const q: any = {
    select: () => q,
    insert(r: Row) {
      inserted = { id: `new-${db.tasks.length + 1}`, created_at: new Date().toISOString(), ...r };
      return q;
    },
    update(p: Row) {
      patch = p;
      return q;
    },
    eq(k: string, v: unknown) {
      tests.push((r) => r[k] === v);
      return q;
    },
    is(k: string, v: null) {
      tests.push((r) => (r[k] ?? null) === v);
      return q;
    },
    gte(k: string, v: string) {
      tests.push((r) => String(r[k]) >= v);
      return q;
    },
    ilike(k: string, v: string) {
      const want = v.replace(/\\(.)/g, "$1").toLowerCase();
      tests.push((r) => String(r[k]).toLowerCase() === want);
      return q;
    },
    /** `created_by.eq.X,assigned_to.eq.X` — the only or() this door sends. */
    or(filters: string) {
      const arms = filters.split(",").map((a) => a.split("."));
      tests.push((r) => arms.some(([k, , v]) => r[k] === v));
      return q;
    },
    limit: () => q,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => {
      if (inserted) {
        db.tasks.push(inserted);
        db.writes++;
        return { data: { id: inserted.id }, error: null };
      }
      return { data: rows()[0] ?? null, error: null };
    },
    then(res: (v: unknown) => unknown) {
      // A bare await: the update path (`.select("id")` returns the rows it wrote).
      if (patch) {
        const hit = rows();
        for (const r of hit) Object.assign(r, patch);
        db.writes += hit.length;
        return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(res);
      }
      return Promise.resolve({ data: rows(), error: null }).then(res);
    },
  };
  return q;
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: UID } } }) },
    from: (n: "tasks" | "jobs") => table(n),
  }),
}));

const { createTask } = await import("./actions");

const TODAY = "2026-09-30";
/** An open Reminder of Erik's, created just now so the 48-hour duplicate window catches it. */
const existing = (over: Row = {}): Row => ({
  id: "old-1",
  title: "Call the PUD about the meter",
  status: "open",
  priority: 0,
  due_date: null,
  focus_date: null,
  category: null,
  job_id: null,
  parent_id: null,
  assigned_to: null,
  created_by: UID,
  created_at: new Date(Date.now() - 3600_000).toISOString(),
  ...over,
});

beforeEach(() => {
  db.tasks = [];
  db.jobs = [];
  db.writes = 0;
});

describe("re-typing a reminder that is already open, out of sight", () => {
  it("one waiting on a day next month: it is pinned to the top and the sentence says so", async () => {
    db.tasks.push(existing({ due_date: "2026-11-15" }));
    const res = await createTask({ title: "Call the PUD about the meter", today: TODAY });
    expect(res.ok).toBe(true);
    expect(res.duplicate).toBe(true);
    // No twin — and the row he can now see is the one that was already there.
    expect(db.tasks).toHaveLength(1);
    expect(db.tasks[0].focus_date).toBe(TODAY);
    // Its DUE DAY is untouched: he set that, and nothing here gets to move it.
    expect(db.tasks[0].due_date).toBe("2026-11-15");
    expect(res.speak).toContain("pinned to the top of Tasks & Reminders");
    expect(res.id).toBe("old-1");
  });

  it("an undated OFFICE reminder (behind the Office door): same — pinned, and said", async () => {
    db.tasks.push(existing({ category: "office" }));
    const res = await createTask({ title: "Call the PUD about the meter", today: TODAY });
    expect(db.tasks).toHaveLength(1);
    expect(db.tasks[0].focus_date).toBe(TODAY);
    expect(res.speak).toContain("waiting out of sight");
  });

  it("one he can already see: nothing is written, and the sentence does not claim a pin", async () => {
    db.tasks.push(existing()); // plain, undated — VISIBLE on the card since this build
    const res = await createTask({ title: "Call the PUD about the meter", today: TODAY });
    expect(res.duplicate).toBe(true);
    expect(db.writes).toBe(0);
    expect(db.tasks[0].focus_date).toBeNull();
    expect(res.speak).not.toContain("pinned");
    expect(res.speak).toContain("Already on the list");
  });

  it("one already PINNED, including a pin that carried from an earlier day: it says where it is", async () => {
    db.tasks.push(existing({ focus_date: "2026-09-24" }));
    const res = await createTask({ title: "Call the PUD about the meter", today: TODAY });
    expect(db.writes).toBe(0); // a standing pin is not re-stamped to today
    expect(db.tasks[0].focus_date).toBe("2026-09-24");
    expect(res.speak).toContain("It's pinned at the top of Tasks & Reminders.");
  });

  it("a caller that doesn't know the company's day pins nothing and still tells the truth", async () => {
    db.tasks.push(existing({ due_date: "2026-11-15" }));
    const res = await createTask({ title: "Call the PUD about the meter" });
    expect(db.writes).toBe(0);
    expect(res.speak).toBe('Already on the list: "Call the PUD about the meter" — open since ' + new Date(db.tasks[0].created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ".");
  });
});

describe("what the duplicate answer must NOT do", () => {
  it("a JOB's task is never pinned — a job's tasks are the job's list, not a person's reminders", async () => {
    db.jobs.push({ id: "job-55" });
    db.tasks.push(existing({ job_id: "job-55", due_date: "2026-11-15" }));
    const res = await createTask({ title: "Call the PUD about the meter", job_id: "job-55", today: TODAY });
    expect(res.duplicate).toBe(true);
    expect(db.writes).toBe(0);
    expect(db.tasks[0].focus_date).toBeNull();
  });

  it("a brand new reminder is created WITHOUT a pin (the Add line stopped stamping one)", async () => {
    const res = await createTask({ title: "Pick up the breaker", today: TODAY });
    expect(res.ok).toBe(true);
    expect(res.duplicate).toBeUndefined();
    expect(db.tasks).toHaveLength(1);
    expect(db.tasks[0].focus_date).toBeNull();
    // `today` is a decision input, never a stored column.
    expect(db.tasks[0]).not.toHaveProperty("today");
  });

  it("a different reminder is a different reminder, not a duplicate", async () => {
    db.tasks.push(existing());
    await createTask({ title: "Order the meter base", today: TODAY });
    expect(db.tasks).toHaveLength(2);
  });
});
