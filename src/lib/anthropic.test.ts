import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * NORT IS DEAD AND SOMEBODY SAYS SO (cn-v1136). A missing ANTHROPIC_API_KEY in production files ONE
 * blocker per server instance (nort:model-dead) before the throw every caller already handles; dev,
 * CI and previews stay quiet. isModelDead tells a refused credential (401 / 403 / authentication_error)
 * from a call's own failure, so the chat route and the nightly review page for the key and not for a
 * timeout.
 */
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn() }));

async function fresh() {
  vi.resetModules();
  const blocker = await import("@/lib/observe-blocker");
  vi.mocked(blocker.reportBlocker).mockClear();
  const anthropic = await import("@/lib/anthropic");
  return { anthropic, reportBlocker: vi.mocked(blocker.reportBlocker) };
}

describe("getAnthropic with no key", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it("in production: throws as before, and files one blocker however often it is asked", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { anthropic, reportBlocker } = await fresh();
    for (let i = 0; i < 3; i++) expect(() => anthropic.getAnthropic()).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(reportBlocker).toHaveBeenCalledTimes(1);
    expect(reportBlocker.mock.calls[0][0]).toBe("nort:model-dead");
    expect((reportBlocker.mock.calls[0][1] as Error).message).toContain("ANTHROPIC_API_KEY is not set");
  });

  it("outside production (dev, CI, preview): the throw only", async () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { anthropic, reportBlocker } = await fresh();
    expect(() => anthropic.getAnthropic()).toThrow();
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(() => anthropic.getAnthropic()).toThrow();
    expect(reportBlocker).not.toHaveBeenCalled();
  });

  it("a key present: no throw, no row", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key-for-this-test-only");
    const { anthropic, reportBlocker } = await fresh();
    expect(anthropic.getAnthropic()).toBeTruthy();
    expect(reportBlocker).not.toHaveBeenCalled();
  });
});

describe("isModelDead", () => {
  it.each([
    ["a 401", { status: 401, message: "invalid x-api-key" }, true],
    ["a 403", { status: 403 }, true],
    ["type authentication_error", { type: "authentication_error" }, true],
    ["a body typed authentication_error", { status: undefined, error: { type: "authentication_error" } }, true],
    ["the SDK's nested body", { status: undefined, error: { type: "error", error: { type: "authentication_error", message: "invalid key" } } }, true],
    ["a 429", { status: 429 }, false],
    ["a 529 overloaded", { status: 529, error: { type: "error", error: { type: "overloaded_error" } } }, false],
    ["a 400", { status: 400, error: { type: "error", error: { type: "invalid_request_error" } } }, false],
    ["a timeout", new Error("Request timed out"), false],
    ["a string", "boom", false],
    ["nothing", undefined, false],
  ])("%s → %s", async (_, e, dead) => {
    const { anthropic } = await fresh();
    expect(anthropic.isModelDead(e)).toBe(dead);
  });
});

/**
 * THE BLOCKER'S WORDS ARE CONSTANT PER STATUS (skeptic #42, B1): the SDK's message carries a
 * per-request request_id, so filing it raw gave every turn under a revoked key its own row and its
 * own page. modelDeadError names the status and nothing else; the raw words ride in the extras.
 */
describe("modelDeadError", () => {
  it("two 401s with different request ids are the SAME words, and the status is in them", async () => {
    const { anthropic } = await fresh();
    const a = Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_111"}'), { status: 401 });
    const b = Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_222"}'), { status: 401 });
    expect(a.message).not.toBe(b.message);
    expect(anthropic.modelDeadError(a).message).toBe(anthropic.modelDeadError(b).message);
    expect(anthropic.modelDeadError(a).message).toBe("Anthropic refused the API key (HTTP 401)");
    expect(anthropic.modelDeadError(a).message).not.toContain("req_111");
  });

  it("a 403 names 403; no status is '?'", async () => {
    const { anthropic } = await fresh();
    expect(anthropic.modelDeadError({ status: 403 }).message).toBe("Anthropic refused the API key (HTTP 403)");
    expect(anthropic.modelDeadError({ type: "authentication_error" }).message).toBe("Anthropic refused the API key (HTTP ?)");
    expect(anthropic.modelDeadError(new Error("x")).message).toBe("Anthropic refused the API key (HTTP ?)");
    expect(anthropic.modelDeadError(undefined).message).toBe("Anthropic refused the API key (HTTP ?)");
  });
});
