import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE CLIENT'S DOOR INTO THE SINK (cn-v1136): a public POST endpoint, so the level it may name is a
 * closed set — "error" or "trace" (Nort's voice loop). "blocker" pages North's own team and is NOT
 * the client's to say: it lands as an error, as does anything else or nothing. The source stays the
 * closed set from v800, namespaced client:<source>, and the write goes through recordAppError.
 */
const spies = vi.hoisted(() => ({ record: vi.fn(async () => null), limited: vi.fn(async () => false) }));
vi.mock("@/lib/observe", () => ({ recordAppError: spies.record }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: spies.limited }));

import { reportClientError } from "./report-client-error";

beforeEach(() => {
  spies.record.mockClear();
  spies.limited.mockClear();
  spies.limited.mockResolvedValue(false);
});

const levelSent = () => (spies.record.mock.calls[0] as unknown[])[3];

describe("reportClientError", () => {
  it("default: an error, namespaced client:<source>, through recordAppError", async () => {
    await reportClientError("error-boundary", "Cannot read properties of undefined", { digest: "abc" });
    expect(spies.record).toHaveBeenCalledTimes(1);
    const [where, err, extra, level] = spies.record.mock.calls[0] as unknown as [string, Error, Record<string, unknown>, string];
    expect(where).toBe("client:error-boundary");
    expect(err.message).toBe("Cannot read properties of undefined");
    expect(extra).toEqual({ digest: "abc" });
    expect(level).toBe("error");
  });

  it("\"trace\" is kept: Nort's voice loop ships its lines at trace", async () => {
    await reportClientError("nort-voice", "trace turn 3 (load 1, flush 2)", { why: "ended", lines: "a\nb" }, "trace");
    expect(levelSent()).toBe("trace");
  });

  it("\"blocker\" from the client lands as error — a page is not the client's to send", async () => {
    await reportClientError("global-error", "boom", undefined, "blocker" as never);
    expect(levelSent()).toBe("error");
  });

  it.each([["fatal"], ["warning"], [""], [42], [null]])("any other level (%s) is error", async (lvl) => {
    await reportClientError("camera", "black frame", undefined, lvl as never);
    expect(levelSent()).toBe("error");
  });

  it("a client's word about its company is dropped (S5): orgId and org_id never reach the sink, the rest of the extras do", async () => {
    await reportClientError("error-boundary", "boom", { orgId: "6f1c2a3e-9b4d-4c5e-8f6a-1b2c3d4e5f60", org_id: "6f1c2a3e-9b4d-4c5e-8f6a-1b2c3d4e5f60", digest: "abc", url: "/q/x" });
    const [, , extra] = spies.record.mock.calls[0] as unknown as [string, Error, Record<string, unknown>];
    expect(extra).toEqual({ digest: "abc", url: "/q/x" });
    expect(Object.keys(extra)).not.toContain("orgId");
    expect(Object.keys(extra)).not.toContain("org_id");
  });

  it("an unknown source is written as client:unknown with what was claimed", async () => {
    await reportClientError("app-layout:org", "forged", undefined, "trace");
    const [where, , extra] = spies.record.mock.calls[0] as unknown as [string, Error, Record<string, unknown>];
    expect(where).toBe("client:unknown");
    expect(extra).toEqual({ claimed_where: "app-layout:org" });
  });

  it("over the shared ceiling (or the limiter down): nothing written", async () => {
    spies.limited.mockResolvedValue(true);
    await reportClientError("error-boundary", "boom");
    expect(spies.record).not.toHaveBeenCalled();
    expect(spies.limited).toHaveBeenCalledWith("client-error:hour", 500, 3600, { failClosed: true });
  });

  it("never throws, even when the write does", async () => {
    spies.record.mockImplementation(() => {
      throw new Error("bad");
    });
    await expect(reportClientError("error-boundary", "boom")).resolves.toBeUndefined();
  });
});
