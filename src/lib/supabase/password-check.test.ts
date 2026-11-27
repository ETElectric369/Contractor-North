import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE CURRENT-PASSWORD CHECK (lib/supabase/password-check, cn-v1203), with a stand-in for
 * @supabase/supabase-js's createClient. A separate client with no session kept signs in once with
 * exactly what was typed: "ok" and that probe session ended at once (scope "local"), "wrong" on
 * invalid_credentials and no sign-out, "unknown" with its code and status for anything else or a
 * throw, "unknown" with no client built when an env is missing. It never throws and writes nothing
 * to the console.
 */
const h = vi.hoisted(() => ({
  built: [] as { url: string; key: string; options: unknown }[],
  signIns: [] as unknown[],
  signOuts: [] as unknown[],
  answer: { error: null } as { error: unknown } | "throw",
  signOutThrows: false,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, options: unknown) => {
    h.built.push({ url, key, options });
    return {
      auth: {
        signInWithPassword: async (c: unknown) => {
          h.signIns.push(c);
          if (h.answer === "throw") throw Object.assign(new Error("stand-in failure"), { status: 503 });
          return { data: {}, ...h.answer };
        },
        signOut: async (o: unknown) => {
          h.signOuts.push(o);
          if (h.signOutThrows) throw new Error("stand-in sign-out failure");
          return { error: null };
        },
      },
    };
  },
}));

import { checkCurrentPassword } from "./password-check";

/** Built at run time: never a literal of a real password's shape. */
const pw = () => ` ${["larkspur", "meadow", String(6 * 7)].join("-")} `;
const EMAIL = "sam.tillery@example.com";
const consoleCalls: unknown[] = [];

beforeEach(() => {
  h.built = [];
  h.signIns = [];
  h.signOuts = [];
  h.answer = { error: null };
  h.signOutThrows = false;
  consoleCalls.length = 0;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", `stand-in-${Math.random().toString(36).slice(2)}`);
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a) => void consoleCalls.push(a));
});
afterEach(() => {
  expect(consoleCalls, "nothing written to the console").toEqual([]);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkCurrentPassword", () => {
  it("a match: ok, one sign-in with exactly what was typed, and the probe session ended with scope local", async () => {
    const p = pw();
    expect(await checkCurrentPassword(EMAIL, p)).toEqual({ result: "ok", code: null, status: null });
    expect(h.signIns).toEqual([{ email: EMAIL, password: p }]);
    expect(h.signOuts).toEqual([{ scope: "local" }]);
  });
  it("a separate client from the two env names, keeping no session, refreshing nothing, reading no URL", async () => {
    await checkCurrentPassword(EMAIL, pw());
    expect(h.built).toHaveLength(1);
    expect(h.built[0].url).toBe("https://example.supabase.co");
    expect(h.built[0].key).toBe(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    expect(h.built[0].options).toEqual({ auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  });
  it("invalid_credentials: wrong, and no sign-out", async () => {
    h.answer = { error: { code: "invalid_credentials", status: 400, message: "stand-in" } };
    expect(await checkCurrentPassword(EMAIL, pw())).toEqual({ result: "wrong", code: "invalid_credentials", status: 400 });
    expect(h.signOuts).toEqual([]);
  });
  it("another code: unknown, with its code and status, and no sign-out", async () => {
    h.answer = { error: { code: "over_request_rate_limit", status: 429, message: "stand-in" } };
    expect(await checkCurrentPassword(EMAIL, pw())).toEqual({ result: "unknown", code: "over_request_rate_limit", status: 429 });
    h.answer = { error: { status: 0 } };
    expect(await checkCurrentPassword(EMAIL, pw())).toEqual({ result: "unknown", code: null, status: 0 });
    expect(h.signOuts).toEqual([]);
  });
  it("the one fallback (cn-v1203): no code, 400 and \"Invalid login credentials\" in any letter case is wrong", async () => {
    for (const message of ["Invalid login credentials", "INVALID LOGIN CREDENTIALS", "invalid login credentials"]) {
      h.answer = { error: { status: 400, message } };
      expect(await checkCurrentPassword(EMAIL, pw())).toEqual({ result: "wrong", code: null, status: 400 });
      h.answer = { error: { code: "", status: 400, message } };
      expect(await checkCurrentPassword(EMAIL, pw())).toEqual({ result: "wrong", code: null, status: 400 });
    }
    expect(h.signOuts).toEqual([]);
  });
  it("every other 400 is unknown, never wrong (skeptic #100): another code, or no code with another message", async () => {
    const cases: [Record<string, unknown>, string | null][] = [
      [{ code: "email_not_confirmed", status: 400, message: "Email not confirmed" }, "email_not_confirmed"],
      [{ code: "validation_failed", status: 400, message: "stand-in" }, "validation_failed"],
      // A code that is not invalid_credentials wins over the sentence.
      [{ code: "validation_failed", status: 400, message: "Invalid login credentials" }, "validation_failed"],
      [{ status: 400, message: "stand-in" }, null],
      [{ status: 400 }, null],
    ];
    for (const [error, code] of cases) {
      h.answer = { error };
      expect(await checkCurrentPassword(EMAIL, pw())).toEqual({ result: "unknown", code, status: 400 });
    }
    // The sentence with another status, or no status, is not the fallback.
    for (const status of [401, 422, undefined]) {
      h.answer = { error: { status, message: "Invalid login credentials" } };
      expect((await checkCurrentPassword(EMAIL, pw())).result).toBe("unknown");
    }
  });
  it("a throw: unknown, never thrown on", async () => {
    h.answer = "throw";
    expect(await checkCurrentPassword(EMAIL, pw())).toEqual({ result: "unknown", code: null, status: 503 });
  });
  it("a sign-out that throws after a match is ignored: still ok", async () => {
    h.signOutThrows = true;
    expect(await checkCurrentPassword(EMAIL, pw())).toEqual({ result: "ok", code: null, status: null });
    expect(h.signOuts).toHaveLength(1);
  });
  it("a missing env: unknown, with no client built and nothing sent", async () => {
    for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "stand-in");
      vi.stubEnv(name, "");
      expect(await checkCurrentPassword(EMAIL, pw())).toEqual({ result: "unknown", code: null, status: null });
    }
    expect(h.built).toEqual([]);
    expect(h.signIns).toEqual([]);
  });
});
