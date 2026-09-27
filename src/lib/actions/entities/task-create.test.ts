import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Nort's task.create reads back WHERE the task landed (0358): on a job's list, or a private Reminder.
 * A step sent with a parent_id and no job_id lands on its parent's job (createTask puts a step where
 * its task lives), so the parent's job decides the read-back and what a job's task leaves off.
 */

const state = vi.hoisted(() => ({ parentJob: null as string | null, created: [] as any[] }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/(app)/tasks/actions", () => ({
  createTask: vi.fn(async (input: any) => {
    state.created.push(input);
    return { ok: true, id: "task-new" };
  }),
  toggleTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}));
vi.mock("../resolve-id", () => ({
  resolveJobId: vi.fn(async (_s: unknown, v: string | null) => ({ id: v })),
  resolveProfileId: vi.fn(async (_s: unknown, v: string | null) => ({ id: v })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-erik" } } }) },
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () =>
          table === "tasks"
            ? { data: { job_id: state.parentJob, assigned_to: null }, error: null }
            : { data: { job_number: "J-055", name: "Apache Ct" }, error: null },
      };
      return chain;
    },
  })),
}));

import { taskActions } from "./task";

const create = (input: Record<string, unknown>) => taskActions["task.create"].handler!(input as any, {} as any) as Promise<any>;

describe("task.create's read-back", () => {
  beforeEach(() => {
    state.parentJob = null;
    state.created = [];
  });

  it("a step under a job's task is a job's task: its date is left off and the read-back names the job", async () => {
    state.parentJob = "job-55";
    const res = await create({ title: "Nail plates", parent_id: "task-parent", due_date: "2026-09-30" });
    expect(state.created[0]).toMatchObject({ job_id: "job-55", due_date: null, focus_date: null, priority: 0 });
    expect(res.speak).toContain("Added to J-055's Tasks, for whoever is on the job.");
  });

  it("says what a job's task left off in plain words", async () => {
    const res = await create({ title: "Hang the panel", job_id: "job-55", due_date: "2026-09-30", priority: 1 });
    expect(res.speak).toBe(
      "Added to J-055's Tasks, for whoever is on the job. A job's task has no due date or priority, so that part wasn't saved.",
    );
  });

  it("a step under a Reminder stays a Reminder, with its date", async () => {
    const res = await create({ title: "Wire nuts", parent_id: "task-parent", due_date: "2026-09-30" });
    expect(state.created[0]).toMatchObject({ job_id: null, due_date: "2026-09-30" });
    expect(res.speak).toBe("Added to your Reminders.");
  });
});
