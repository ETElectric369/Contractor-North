import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EMAIL ME A RESET LINK (set-password/actions emailMyResetLink, cn-v1203): the way out for a forgotten
 * current password, from inside Settings › You › Change My Password. It takes no argument; the address
 * is the signed-in person's own login email. The email goes out as the forgot page's does: the two
 * limits first (lib/auth-mail authMailRefused, stood in), then the app's own reset email in after()
 * (mailOneTimeCode, stood in). Answers in the caller's language: not signed in; no email on the login;
 * too many; on its way.
 */
const state = vi.hoisted(() => ({
  user: { id: "larkspur", email: "Sam.Tillery@Example.com" } as { id: string; email?: string } | null,
  language: "en" as string,
  refused: false,
  refusedArgs: [] as unknown[][],
  mailed: [] as Record<string, unknown>[],
  afterCalls: 0,
  headers: new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "accept-language": "es-MX,es;q=0.9" }),
}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    state.afterCalls++;
    return fn();
  },
}));
vi.mock("@/lib/auth-mail", () => ({
  authMailRefused: async (...a: unknown[]) => {
    state.refusedArgs.push(a);
    return state.refused;
  },
  mailOneTimeCode: async (input: Record<string, unknown>) => {
    state.mailed.push(input);
  },
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/password-check", () => ({ checkCurrentPassword: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => ({
      select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { language: state.language }, error: null }) }) }) }),
    }),
  })),
}));

import { emailMyResetLink } from "./actions";
import { dict } from "@/lib/i18n";

beforeEach(() => {
  state.user = { id: "larkspur", email: "Sam.Tillery@Example.com" };
  state.language = "en";
  state.refused = false;
  state.refusedArgs = [];
  state.mailed = [];
  state.afterCalls = 0;
});

describe("emailMyResetLink", () => {
  for (const lang of ["en", "es"] as const) {
    it(`${lang}: nobody signed in: not signed in, nothing checked or sent`, async () => {
      state.language = lang;
      state.user = null;
      expect(await emailMyResetLink()).toEqual({ ok: false, message: dict("en").au_notSignedIn });
      expect(state.refusedArgs).toEqual([]);
      expect(state.mailed).toEqual([]);
    });
    it(`${lang}: limited: too many, in the caller's language, nothing sent`, async () => {
      state.language = lang;
      state.refused = true;
      expect(await emailMyResetLink()).toEqual({ ok: false, message: dict(lang).au_tooManyEmails });
      expect(state.mailed).toEqual([]);
      expect(state.afterCalls).toBe(0);
    });
    it(`${lang}: ok: the reset email to the caller's own address, after the answer's limits; on its way, in the caller's language`, async () => {
      state.language = lang;
      expect(await emailMyResetLink()).toEqual({ ok: true, message: dict(lang).au_resetSentToYou });
      expect(state.refusedArgs).toEqual([["203.0.113.7", "sam.tillery@example.com"]]);
      expect(state.afterCalls).toBe(1);
      expect(state.mailed).toHaveLength(1);
      expect(state.mailed[0]).toMatchObject({ kind: "reset", email: "sam.tillery@example.com", requestLang: "es" });
      expect(typeof state.mailed[0].translatorFor).toBe("function");
    });
  }
  it("a login with no email: could not send, nothing checked or sent", async () => {
    state.user = { id: "larkspur" };
    expect(await emailMyResetLink()).toEqual({ ok: false, message: dict("en").au_resetNotSent });
    expect(state.refusedArgs).toEqual([]);
    expect(state.mailed).toEqual([]);
  });
  it("takes no argument: whatever a caller sends, the address is the signed-in person's own", async () => {
    expect(emailMyResetLink.length).toBe(0);
    const call = emailMyResetLink as unknown as (...a: unknown[]) => Promise<unknown>;
    await call("dana.rook@example.com", { email: "dana.rook@example.com" });
    expect(state.mailed.map((m) => m.email)).toEqual(["sam.tillery@example.com"]);
    const src = readFileSync(join(process.cwd(), "src/app/set-password/actions.ts"), "utf8");
    expect(src).toMatch(/export async function emailMyResetLink\(\): Promise/);
  });
  it("the two words are sentences in both languages", () => {
    expect([dict("en").au_resetSentToYou, dict("es").au_resetSentToYou]).toEqual([
      "A reset link is on its way to your email.",
      "Ya va en camino a tu correo un enlace para restablecerla.",
    ]);
    expect([dict("en").au_forgotCurrent, dict("es").au_forgotCurrent]).toEqual(["Forgot it?", "¿La olvidaste?"]);
  });
});
