import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A NAMED JOB IS THE JOB (2026-10-19). Erik, screen locked: "clock me in on 12 Larkspur Lane" — the
 * punch landed on the job the app picked for the day. Nort passed the spoken name where a uuid
 * belongs, the clock's visibility check read it as a job it could not see and dropped it, and a
 * job-less punch is the app's to place. time.clockIn now resolves the name through the same resolver
 * time.switchJob has used since 0288: a uuid passes, one match resolves, none or several ASK — and
 * the punch says back which job it is on, so a name that matched by CONTAINS is heard.
 */

const state = vi.hoisted(() => ({ punches: [] as any[], resolved: new Map<string, { id: string | null } | { error: string }>() }));
vi.mock("@/app/(app)/timeclock/actions", () => ({
  clockIn: vi.fn(async (input: any) => {
    state.punches.push(input);
    return { ok: true, id: "entry-1" };
  }),
  clockOutCurrent: vi.fn(),
  createManualEntry: vi.fn(),
  switchJob: vi.fn(),
  updateTimeEntry: vi.fn(),
}));
vi.mock("../resolve-id", () => ({
  resolveJobId: vi.fn(async (_s: unknown, v: string | null) => {
    if (v == null || !v.trim()) return { id: null };
    // The resolver's own sentence for zero matches (resolve-id.ts), word for word.
    return state.resolved.get(v) ?? { error: `No job named "${v}" — is it spelled right?` };
  }),
  resolveProfileId: vi.fn(async (_s: unknown, v: string | null) => ({ id: v })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-owner" } } }) },
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () =>
          table === "jobs"
            ? { data: { id: BAYBERRY, job_number: "J-099", name: "Bayberry kitchen", address: "12 Larkspur Lane", customers: { name: "Bayberry" } }, error: null }
            : { data: null, error: null },
      };
      return chain;
    },
  })),
}));

const BAYBERRY = "0af539c6-1111-4222-8333-444455556666";

describe("time.clockIn resolves a spoken job name before the punch", () => {
  beforeEach(() => {
    state.punches.length = 0;
    state.resolved.clear();
    state.resolved.set("Bayberry kitchen", { id: BAYBERRY });
    state.resolved.set("12 Larkspur Lane", { id: BAYBERRY });
    state.resolved.set(BAYBERRY, { id: BAYBERRY });
  });

  it("a job named as the person said it lands the punch on that job's id, and the answer names the job", async () => {
    const { timeActions } = await import("./time");
    const res = (await timeActions["time.clockIn"].handler({ job_id: "Bayberry kitchen" } as any, {} as any)) as any;
    expect(res).toMatchObject({ ok: true, id: "entry-1" });
    expect(state.punches).toHaveLength(1);
    expect(state.punches[0].job_id).toBe(BAYBERRY);
    expect(res.recorded).toMatch(/^Clocked in on .*Bayberry.*\.$/);
  });

  it("a street names the job too", async () => {
    const { timeActions } = await import("./time");
    await timeActions["time.clockIn"].handler({ job_id: "12 Larkspur Lane" } as any, {} as any);
    expect(state.punches[0].job_id).toBe(BAYBERRY);
  });

  it("a uuid passes through unchanged", async () => {
    const { timeActions } = await import("./time");
    await timeActions["time.clockIn"].handler({ job_id: BAYBERRY } as any, {} as any);
    expect(state.punches[0].job_id).toBe(BAYBERRY);
  });

  it("a name that matches no job ASKS and never punches (the app must not pick instead)", async () => {
    const { timeActions } = await import("./time");
    const res = await timeActions["time.clockIn"].handler({ job_id: "Thistlewood" } as any, {} as any);
    expect(res).toEqual({ ok: false, error: 'No job named "Thistlewood" — is it spelled right?' });
    expect(state.punches).toHaveLength(0);
  });

  it("no job named still punches job-less, for the app to place and say so, with no job echoed", async () => {
    const { timeActions } = await import("./time");
    const res = (await timeActions["time.clockIn"].handler({} as any, {} as any)) as any;
    expect(res).toMatchObject({ ok: true });
    expect(res.recorded).toBeUndefined();
    expect(state.punches).toHaveLength(1);
    expect(state.punches[0].job_id).toBeNull();
  });

  it("the verb tells the model a name or street is welcome and a named job is never left empty", async () => {
    const { timeActions } = await import("./time");
    const d = timeActions["time.clockIn"].description;
    expect(d).toContain("OR the job's name, number or street address EXACTLY as the person said it");
    expect(d).toContain("WHEN THE PERSON NAMES A JOB, PASS IT: never leave job_id empty for a named job");
  });
});
