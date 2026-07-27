import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE HARM: the offline queue retries. If a retry isn't exactly-once, a timeout halfway through
 * a write leaves the record saved AND the queue convinced it failed — so the replay makes a second
 * one, and nobody notices until there are two of something. Every branch below is a way that could
 * happen, so every branch is pinned.
 */

// A minimal stand-in for the service client: an insert that can be told to collide, a select that
// returns whatever the ledger holds, and recorded deletes/updates.
const state = {
  collide: false,
  priorResultId: null as string | null,
  deletes: [] as string[],
  updates: [] as Record<string, unknown>[],
  inserts: 0,
};

const fakeClient = {
  from() {
    const api: Record<string, unknown> = {};
    const chain = {
      insert: () => {
        state.inserts++;
        return {
          select: () => ({
            maybeSingle: async () =>
              state.collide
                ? { data: null, error: { code: "23505", message: "duplicate key" } }
                : { data: { id: "claim-1" }, error: null },
          }),
        };
      },
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { result_id: state.priorResultId }, error: null }) }),
        }),
      }),
      delete: () => ({ eq: (_c: string, v: string) => { state.deletes.push(v); return Promise.resolve({ error: null }); } }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => { state.updates.push(patch); return Promise.resolve({ error: null }); },
      }),
    };
    Object.assign(api, chain);
    return api;
  },
};

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => fakeClient }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const { runOnce } = await import("./run-once");

const base = { action: "test.op", orgId: "org-1", profileId: "user-1" };

beforeEach(() => {
  state.collide = false;
  state.priorResultId = null;
  state.deletes = [];
  state.updates = [];
  state.inserts = 0;
});

describe("the online path is untouched", () => {
  it("with no clientOpId it calls straight through and never touches the ledger", async () => {
    const fn = vi.fn(async () => ({ ok: true, id: "row-1" }));
    const res = await runOnce({ ...base, clientOpId: null }, fn);
    expect(res).toEqual({ ok: true, id: "row-1" });
    expect(state.inserts).toBe(0);
  });

  it("an org we can't identify also calls straight through", async () => {
    const fn = vi.fn(async () => ({ ok: true }));
    await runOnce({ ...base, orgId: null, clientOpId: "op-1" }, fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(state.inserts).toBe(0);
  });
});

describe("a replay does the work exactly once", () => {
  it("the first attempt runs and records the result", async () => {
    const fn = vi.fn(async () => ({ ok: true, id: "row-9" }));
    const res = await runOnce({ ...base, clientOpId: "op-1" }, fn);
    expect(res.id).toBe("row-9");
    expect(fn).toHaveBeenCalledOnce();
    expect(state.updates[0]).toMatchObject({ result_id: "row-9" });
  });

  it("a duplicate key does NOT re-run the work, and returns the ORIGINAL row id", async () => {
    state.collide = true;
    state.priorResultId = "row-9";
    const fn = vi.fn(async () => ({ ok: true, id: "row-DIFFERENT" }));
    const res = await runOnce({ ...base, clientOpId: "op-1" }, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, id: "row-9" });
  });

  it("a duplicate while the first attempt is still in flight reports accepted, not failed", async () => {
    state.collide = true;
    state.priorResultId = null; // original hasn't finished
    const res = await runOnce({ ...base, clientOpId: "op-1" }, vi.fn(async () => ({ ok: true, id: undefined as string | undefined })));
    expect(res.ok).toBe(true);
    expect(res.id).toBeUndefined();
  });
});

describe("a genuine failure must stay retryable", () => {
  it("a thrown error RELEASES the claim, so the retry can still run", async () => {
    // Without the release, one network blip would be remembered forever as "already done" and the
    // work could never happen — the queue would drop it silently.
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(runOnce({ ...base, clientOpId: "op-1" }, fn)).rejects.toThrow("boom");
    expect(state.deletes).toContain("claim-1");
  });

  it("an ok:false result also releases the claim", async () => {
    const res = await runOnce({ ...base, clientOpId: "op-1" }, async () => ({ ok: false, error: "nope" }));
    expect(res.ok).toBe(false);
    expect(state.deletes).toContain("claim-1");
  });

  it("a claim that fails for a NON-duplicate reason still does the work", async () => {
    // The ledger being unavailable must not block a contractor's save. We accept the small
    // duplicate risk in that window rather than losing the write outright.
    state.collide = false;
    const broken = { ...fakeClient };
    vi.spyOn(fakeClient, "from").mockImplementationOnce(
      () =>
        ({
          insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "42P01" } }) }) }),
        }) as never,
    );
    const fn = vi.fn(async () => ({ ok: true, id: "row-2" }));
    const res = await runOnce({ ...base, clientOpId: "op-1" }, fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(res.id).toBe("row-2");
    void broken;
  });
});
