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

import { createTask } from "./actions";

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
