import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE ONE WRITE INTO THE SINK (cn-v1136, 0399). recordAppError carries the level and lifts the
 * tenant off the extras — only a UUID-shaped orgId / org_id, so the 68 call sites that already pass
 * one get the column for free and a job id or a word never joins on it — keeps the title/payload
 * shape every triage query reads, answers what the database said, and never throws, whatever the
 * service client or the RPC does. reportError is it at "error", fire-and-forget; reportErrorAwaited
 * is it under a two-second clock.
 */
const rpc = vi.hoisted(() => ({ fn: vi.fn(), ctorThrows: false }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => {
    if (rpc.ctorThrows) throw new Error("no service key");
    return { rpc: rpc.fn };
  },
}));

import { recordAppError, reportError, reportErrorAwaited } from "./observe";

const ORG = "6f1c2a3e-9b4d-4c5e-8f6a-1b2c3d4e5f60";
const answer = { id: "row-1", inserted: true, reopened: false, event_count: 1, level: "error" };

beforeEach(() => {
  rpc.fn.mockReset();
  rpc.ctorThrows = false;
  rpc.fn.mockResolvedValue({ data: answer, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const sent = () => rpc.fn.mock.calls[0][1] as Record<string, unknown>;

describe("recordAppError", () => {
  it("writes the title, where, level, payload and tenant through record_app_error, and answers what it said", async () => {
    const r = await recordAppError("cron-nudge", new Error("organizations could not be read"), { orgId: ORG, step: "read" }, "blocker");
    expect(rpc.fn).toHaveBeenCalledTimes(1);
    expect(rpc.fn.mock.calls[0][0]).toBe("record_app_error");
    expect(sent()).toEqual({
      p_key: expect.stringMatching(/^[0-9a-f]{16}$/),
      p_title: "organizations could not be read",
      p_where: "cron-nudge",
      p_level: "blocker",
      p_payload: { where: "cron-nudge", message: "organizations could not be read", extra: { orgId: ORG, step: "read" } },
      p_org: ORG,
    });
    // escalated is false when the database does not say it (skeptic #42, S2).
    expect(r).toEqual({ id: "row-1", inserted: true, reopened: false, escalated: false, event_count: 1, level: "error" });
  });

  it.each([
    ["a UUID orgId", { orgId: ORG }, ORG],
    ["an upper-case UUID", { orgId: ORG.toUpperCase() }, ORG.toUpperCase()],
    ["a UUID org_id", { org_id: ORG }, ORG],
    ["a job id", { orgId: "J-047" }, null],
    ["a number", { orgId: 42 }, null],
    ["a null orgId", { orgId: null }, null],
    ["no extras", undefined, null],
    ["extras with no org", { step: "read" }, null],
  ])("the tenant is lifted only when UUID-shaped: %s", async (_, extra, org) => {
    await recordAppError("x", new Error("m"), extra as Record<string, unknown> | undefined, "error");
    expect(sent().p_org).toBe(org);
    // The extras themselves are untouched on the payload, whatever was lifted.
    expect((sent().p_payload as { extra: unknown }).extra).toEqual(extra ?? null);
  });

  it("the key is where::message, so the same words at two places are two rows and the level is not in it", async () => {
    await recordAppError("a", new Error("m"), undefined, "error");
    await recordAppError("a", new Error("m"), undefined, "blocker");
    await recordAppError("b", new Error("m"), undefined, "error");
    const keys = rpc.fn.mock.calls.map((c) => (c[1] as { p_key: string }).p_key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("an empty message titles the row with its where; a plain-object error reads its message · code", async () => {
    await recordAppError("where-only", "", undefined, "error");
    expect(sent().p_title).toBe("where-only");
    rpc.fn.mockClear();
    await recordAppError("db", { message: "permission denied", code: "42501" }, undefined, "error");
    expect(sent().p_title).toBe("permission denied · 42501");
  });

  it("the RPC's handed-back error, a rejected RPC, a thrown service client, or a shapeless answer: null, never a throw", async () => {
    rpc.fn.mockResolvedValue({ data: null, error: { message: "function record_app_error(…) does not exist" } });
    expect(await recordAppError("x", new Error("m"), undefined, "error")).toBeNull();
    rpc.fn.mockRejectedValue(new Error("network"));
    expect(await recordAppError("x", new Error("m"), undefined, "error")).toBeNull();
    rpc.fn.mockResolvedValue({ data: "ok", error: null });
    expect(await recordAppError("x", new Error("m"), undefined, "error")).toBeNull();
    rpc.ctorThrows = true;
    expect(await recordAppError("x", new Error("m"), undefined, "error")).toBeNull();
  });

  it("coerces the answer's booleans and count", async () => {
    rpc.fn.mockResolvedValue({ data: { id: "r", inserted: "yes", reopened: true, escalated: "true", event_count: "7", level: "blocker" }, error: null });
    expect(await recordAppError("x", new Error("m"), undefined, "error")).toEqual({ id: "r", inserted: false, reopened: true, escalated: false, event_count: 7, level: "blocker" });
    rpc.fn.mockResolvedValue({ data: { id: "r", inserted: false, reopened: false, escalated: true, event_count: 2, level: "blocker" }, error: null });
    expect(await recordAppError("x", new Error("m"), undefined, "blocker")).toMatchObject({ escalated: true });
  });

  it("the RPC's handed-back error is said ONCE on the console — '[error-sink] write failed' and the words — and nowhere else (skeptic #42, N5)", async () => {
    const consoleError = vi.mocked(console.error);
    rpc.fn.mockResolvedValue({ data: null, error: { message: "function record_app_error(…) does not exist", code: "42883" } });
    expect(await recordAppError("x", new Error("m"), undefined, "error")).toBeNull();
    expect(consoleError).toHaveBeenCalledWith("[error-sink] write failed", "function record_app_error(…) does not exist · 42883");
    expect(rpc.fn).toHaveBeenCalledTimes(1); // never a second write about the failed write
    // A good write says nothing of the kind.
    consoleError.mockClear();
    rpc.fn.mockResolvedValue({ data: answer, error: null });
    await recordAppError("x", new Error("m"), undefined, "error");
    expect(consoleError.mock.calls.some((c) => c[0] === "[error-sink] write failed")).toBe(false);
  });
});

describe("reportError / reportErrorAwaited", () => {
  it("reportError is the write at level error, fire-and-forget, with the same shape", async () => {
    reportError("push", new Error("VAPID"), { orgId: ORG });
    await Promise.resolve();
    expect(rpc.fn).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ p_where: "push", p_level: "error", p_title: "VAPID", p_org: ORG });
  });

  it("reportError never throws when the service client does", () => {
    rpc.ctorThrows = true;
    expect(() => reportError("x", new Error("m"))).not.toThrow();
  });

  it("reportErrorAwaited waits for the write and resolves under its two-second clock when the write hangs", async () => {
    vi.useFakeTimers();
    rpc.fn.mockReturnValue(new Promise(() => {}));
    let done = false;
    const p = reportErrorAwaited("stripe:webhook:refused", new Error("no secret"), { secretsTried: 0 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(sent()).toMatchObject({ p_where: "stripe:webhook:refused", p_level: "error" });
  });
});
