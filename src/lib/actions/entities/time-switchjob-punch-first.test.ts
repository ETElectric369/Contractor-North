import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE PUNCH FIRST, THE JOB SECOND (2026-10-19). Erik, on the phone, after closing his punch on the
 * screen without telling Nort: "just no job" → time.switchJob with that as the job → the resolver
 * refused ("No job named 'just no job'") BEFORE anyone looked for a running shift, and Nort,
 * holding a refusal about the name, told him where he was on the clock from memory. With no shift
 * running there is nothing to switch, whatever was said: the handler reads the open entry first
 * and refuses with the true state, and the resolver is never consulted for a switch that cannot be.
 */

const state = vi.hoisted(() => ({
  open: null as null | { id: string; notes: string; job_id: string | null },
  resolverCalls: [] as (string | null)[],
  switches: [] as unknown[],
}));
vi.mock("@/app/(app)/timeclock/actions", () => ({
  clockIn: vi.fn(),
  clockOutCurrent: vi.fn(),
  createManualEntry: vi.fn(),
  switchJob: vi.fn(async (input: unknown) => {
    state.switches.push(input);
    return { ok: true, id: "entry-1", mode: "repointed" };
  }),
  updateTimeEntry: vi.fn(),
}));
vi.mock("../resolve-id", () => ({
  resolveJobId: vi.fn(async (_s: unknown, v: string | null) => {
    state.resolverCalls.push(v);
    if (v == null || !v.trim()) return { id: null };
    // The resolver's own sentence for zero matches (resolve-id.ts), word for word.
    return { error: `No job named "${v}" — is it spelled right?` };
  }),
  resolveProfileId: vi.fn(async (_s: unknown, v: string | null) => ({ id: v })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-tech" } } }) },
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => (table === "time_entries" ? { data: state.open, error: null } : { data: null, error: null }),
      };
      return chain;
    },
  })),
}));

describe("time.switchJob looks for the running shift before it resolves the job", () => {
  beforeEach(() => {
    state.open = null;
    state.resolverCalls.length = 0;
    state.switches.length = 0;
  });

  it("with no shift running it refuses with the true state, and never asks the resolver about the words", async () => {
    const { timeActions } = await import("./time");
    const res = await timeActions["time.switchJob"].handler({ job_id: "just no job" } as any, {} as any);
    expect(res).toEqual({ ok: false, error: "You're not clocked in." });
    expect(state.resolverCalls).toEqual([]);
    expect(state.switches).toHaveLength(0);
  });

  it("with a shift running, a name that matches nothing is the resolver's refusal and no switch", async () => {
    state.open = { id: "entry-1", notes: "", job_id: "job-a" };
    const { timeActions } = await import("./time");
    const res = await timeActions["time.switchJob"].handler({ job_id: "Thistlewood" } as any, {} as any);
    expect(res).toEqual({ ok: false, error: 'No job named "Thistlewood" — is it spelled right?' });
    expect(state.resolverCalls).toEqual(["Thistlewood"]);
    expect(state.switches).toHaveLength(0);
  });
});
