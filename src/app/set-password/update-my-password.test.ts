import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ONE ACTION SAVES A PERSON'S OWN PASSWORD (set-password/actions updateMyPassword, cn-v1202), for the
 * first-password page and Settings › You › Change My Password alike.
 *   - SAVED AS TYPED: sign-in sends what was typed, so the save does too; the 8 is counted on what
 *     was typed. It used to trim, so a password with a space at an end was saved without it and then
 *     refused at sign-in.
 *   - A REFUSAL IS READ BY ITS CODE and said in the app's own sentence, in the caller's language;
 *     the auth server's English never reaches the screen; an unknown code is reported with its code
 *     and status only, never the password.
 *   - THE OTHER DEVICES: after the save, signOut({ scope: "others" }) once; othersSignedOut is true
 *     only when it answered without an error, and its failure never fails the save.
 *   - The must-reset flag is cleared as before, with the same zero-row check.
 */
const state = vi.hoisted(() => ({
  user: { id: "larkspur" } as { id: string } | null,
  language: "en" as string | null,
  updateError: null as null | Record<string, unknown>,
  signOutError: null as null | Record<string, unknown>,
  signOutThrows: false,
  flagRows: [{ id: "larkspur" }] as { id: string }[],
  calls: [] as string[],
  updateArgs: [] as unknown[],
  signOutArgs: [] as unknown[],
}));
const reportError = vi.fn();
vi.mock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
      updateUser: async (attrs: unknown) => {
        state.calls.push("updateUser");
        state.updateArgs.push(attrs);
        return { data: {}, error: state.updateError };
      },
      signOut: async (opts: unknown) => {
        state.calls.push("signOut");
        state.signOutArgs.push(opts);
        if (state.signOutThrows) throw new Error("network down");
        return { error: state.signOutError };
      },
    },
    from: () => ({
      select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { language: state.language }, error: null }) }) }) }),
      update: (patch: unknown) => ({
        eq: () => ({
          select: async () => {
            state.calls.push(`flag:${JSON.stringify(patch)}`);
            return { data: state.flagRows, error: null };
          },
        }),
      }),
    }),
  })),
}));

import { updateMyPassword } from "./actions";
import { dict } from "@/lib/i18n";

/** Built at run time: never a literal with the shape of a real password. */
const pwOf = (...parts: string[]) => parts.join("-");
const SERVER_ENGLISH = ["The server", "said", "something"].join(" ");

beforeEach(() => {
  state.user = { id: "larkspur" };
  state.language = "en";
  state.updateError = null;
  state.signOutError = null;
  state.signOutThrows = false;
  state.flagRows = [{ id: "larkspur" }];
  state.calls = [];
  state.updateArgs = [];
  state.signOutArgs = [];
  reportError.mockClear();
});

describe("saved as typed", () => {
  it("a password with a space at each end reaches updateUser unchanged", async () => {
    const pw = ` ${pwOf("larkspur", "meadow", "42")} `;
    expect(await updateMyPassword(pw)).toEqual({ ok: true, othersSignedOut: true });
    expect(state.updateArgs).toEqual([{ password: pw }]);
  });
  it("the 8 is counted on what was typed: eight characters with spaces are taken, seven are refused", async () => {
    expect(await updateMyPassword("  abcd  ")).toMatchObject({ ok: true });
    expect(state.updateArgs).toEqual([{ password: "  abcd  " }]);
    expect(await updateMyPassword(" abcde ")).toEqual({ ok: false, error: dict("en").au_password8 });
    expect(state.updateArgs).toHaveLength(1);
  });
});

describe("a refusal by its code, in both languages, never the server's English", () => {
  const cases: [string, (lang: "en" | "es") => string][] = [
    ["weak_password", (l) => dict(l).au_joinWeakPassword],
    ["same_password", (l) => dict(l).au_samePassword],
    ["reauthentication_needed", (l) => dict(l).au_signInFreshToChange.replace("{door}", dict(l).au_signInWithCode)],
    ["current_password_required", (l) => dict(l).au_signInFreshToChange.replace("{door}", dict(l).au_signInWithCode)],
    ["current_password_invalid", (l) => dict(l).au_signInFreshToChange.replace("{door}", dict(l).au_signInWithCode)],
  ];
  for (const lang of ["en", "es"] as const) {
    for (const [code, want] of cases) {
      it(`${lang}: ${code}`, async () => {
        state.language = lang;
        state.updateError = { code, status: 422, message: SERVER_ENGLISH };
        const res = await updateMyPassword(pwOf("larkspur", "meadow", "42"));
        expect(res).toEqual({ ok: false, error: want(lang) });
        expect(res.error).not.toContain(SERVER_ENGLISH);
        expect(res.error).not.toContain("{door}");
        expect(state.calls).not.toContain("signOut");
        expect(reportError).not.toHaveBeenCalled();
      });
    }
    it(`${lang}: a password over 72 bytes the server refused is "too long", counted in bytes`, async () => {
      state.language = lang;
      state.updateError = { code: "validation_failed", status: 400, message: SERVER_ENGLISH };
      const long = "ñ".repeat(37); // 37 characters, 74 bytes
      expect(await updateMyPassword(long)).toEqual({ ok: false, error: dict(lang).au_passwordTooLong });
      state.updateError = { code: "validation_failed", status: 400, message: SERVER_ENGLISH };
      expect(await updateMyPassword("ñ".repeat(36))).toEqual({ ok: false, error: dict(lang).au_couldNotUpdate });
    });
    it(`${lang}: an unknown code is au_couldNotUpdate, reported with its code and status only`, async () => {
      state.language = lang;
      state.updateError = { code: "something_new", status: 418, message: SERVER_ENGLISH };
      const pw = pwOf("larkspur", "meadow", "42");
      expect(await updateMyPassword(pw)).toEqual({ ok: false, error: dict(lang).au_couldNotUpdate });
      expect(reportError).toHaveBeenCalledTimes(1);
      const [where, err, extra] = reportError.mock.calls[0];
      expect(where).toBe("set-password-update");
      expect(extra).toEqual({ code: "something_new", status: 418 });
      expect(JSON.stringify([String(err), (err as Error).message, extra])).not.toContain(pw);
      expect(JSON.stringify([String(err), (err as Error).message, extra])).not.toContain(SERVER_ENGLISH);
    });
  }
});

describe("the other devices", () => {
  it("signOut is called once, with scope others only, after a successful save and before the flag", async () => {
    expect(await updateMyPassword(pwOf("larkspur", "meadow", "42"))).toEqual({ ok: true, othersSignedOut: true });
    expect(state.signOutArgs).toEqual([{ scope: "others" }]);
    expect(state.calls).toEqual(["updateUser", "signOut", 'flag:{"must_reset_password":false}']);
  });
  it("a refused save signs nobody out", async () => {
    state.updateError = { code: "weak_password", status: 422 };
    await updateMyPassword(pwOf("larkspur", "meadow", "42"));
    expect(state.signOutArgs).toEqual([]);
  });
  it("its failure still returns ok with othersSignedOut false, reported with code and status only", async () => {
    state.signOutError = { code: "unexpected_failure", status: 500, message: SERVER_ENGLISH };
    expect(await updateMyPassword(pwOf("larkspur", "meadow", "42"))).toEqual({ ok: true, othersSignedOut: false });
    expect(reportError).toHaveBeenCalledWith("set-password-sign-out-others", expect.any(Error), { code: "unexpected_failure", status: 500 });
    reportError.mockClear();
    state.signOutError = null;
    state.signOutThrows = true;
    expect(await updateMyPassword(pwOf("larkspur", "meadow", "42"))).toEqual({ ok: true, othersSignedOut: false });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(state.calls.filter((c) => c.startsWith("flag:"))).toHaveLength(2);
  });
});

describe("the must-reset flag, as before", () => {
  it("is cleared; zero rows is the saved-but-stuck sentence in the caller's language", async () => {
    state.flagRows = [];
    state.language = "es";
    expect(await updateMyPassword(pwOf("larkspur", "meadow", "42"))).toEqual({ ok: false, error: dict("es").au_savedButStuck, saved: true, othersSignedOut: true });
    expect(reportError).toHaveBeenCalledWith("set-password-clear-flag", expect.any(Error), { userId: "larkspur" });
  });
  it("nobody signed in is refused before anything is sent", async () => {
    state.user = null;
    expect(await updateMyPassword(pwOf("larkspur", "meadow", "42"))).toEqual({ ok: false, error: dict("en").au_notSignedIn });
    expect(state.calls).toEqual([]);
  });
});

describe("too long is said only when that is what the server refused (cn-v1202, skeptic #99)", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const at72 = "ñ".repeat(36); // 36 characters, 72 bytes
  const at73 = "ñ".repeat(36) + "a"; // 73 bytes
  const over = "ñ".repeat(40); // 80 bytes
  it("exactly 72 bytes of multi-byte characters is not too long; 73 is (validation_failed)", async () => {
    expect([bytes(at72), bytes(at73)]).toEqual([72, 73]);
    state.updateError = { code: "validation_failed", status: 422 };
    expect(await updateMyPassword(at72)).toEqual({ ok: false, error: dict("en").au_couldNotUpdate });
    expect(await updateMyPassword(at73)).toEqual({ ok: false, error: dict("en").au_passwordTooLong });
  });
  it("over the limit with reauthentication_needed is the fresh-sign-in sentence", async () => {
    state.updateError = { code: "reauthentication_needed", status: 400 };
    expect(await updateMyPassword(over)).toEqual({ ok: false, error: dict("en").au_signInFreshToChange.replace("{door}", dict("en").au_signInWithCode) });
  });
  it("over the limit with a failed call (no code, status 0 or none) is au_couldNotUpdate, reported once", async () => {
    for (const err of [{ status: 0 }, {}]) {
      reportError.mockClear();
      state.updateError = err;
      expect(await updateMyPassword(over)).toEqual({ ok: false, error: dict("en").au_couldNotUpdate });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0][0]).toBe("set-password-update");
    }
  });
  it("over the limit with a rate limit is au_couldNotUpdate, reported once", async () => {
    state.updateError = { code: "over_request_rate_limit", status: 429 };
    expect(await updateMyPassword(over)).toEqual({ ok: false, error: dict("en").au_couldNotUpdate });
    expect(reportError).toHaveBeenCalledTimes(1);
  });
  it("validation_failed at or under the limit is au_couldNotUpdate, reported once", async () => {
    state.updateError = { code: "validation_failed", status: 400 };
    expect(await updateMyPassword(at72)).toEqual({ ok: false, error: dict("en").au_couldNotUpdate });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][2]).toEqual({ code: "validation_failed", status: 400 });
  });
  it("no code + 422 + over the limit is too long, and nothing is reported", async () => {
    state.updateError = { status: 422 };
    expect(await updateMyPassword(over)).toEqual({ ok: false, error: dict("en").au_passwordTooLong });
    state.updateError = { status: 400 };
    expect(await updateMyPassword(over)).toEqual({ ok: false, error: dict("en").au_passwordTooLong });
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("the way out names the door a person sees first (cn-v1202)", () => {
  it("the fresh-sign-in sentence, filled, in both languages", async () => {
    state.updateError = { code: "reauthentication_needed", status: 400 };
    expect((await updateMyPassword(pwOf("larkspur", "meadow", "42"))).error).toBe(
      'To change it, sign out, choose "Sign In with a Code Instead — No Password" on the sign-in screen, and change it here.',
    );
    state.language = "es";
    expect((await updateMyPassword(pwOf("larkspur", "meadow", "42"))).error).toBe(
      'Para cambiarla, cierra sesión, elige "Iniciar Sesión con un Código — Sin Contraseña" en la pantalla de inicio de sesión y cámbiala aquí.',
    );
  });
});

describe("a saved password is said as saved (cn-v1202)", () => {
  it("saved but the flag stuck: the sentence as before, plus saved and othersSignedOut", async () => {
    state.flagRows = [];
    expect(await updateMyPassword(pwOf("larkspur", "meadow", "42"))).toEqual({
      ok: false,
      error: dict("en").au_savedButStuck,
      saved: true,
      othersSignedOut: true,
    });
    state.signOutError = { code: "unexpected_failure", status: 500 };
    expect(await updateMyPassword(pwOf("larkspur", "meadow", "42"))).toMatchObject({ saved: true, othersSignedOut: false });
  });
  it("a refused save is never saved", async () => {
    state.updateError = { code: "weak_password", status: 422 };
    expect((await updateMyPassword(pwOf("larkspur", "meadow", "42"))).saved).toBeUndefined();
  });
});

describe("a non-string argument is refused as too short and never sent", () => {
  it("a number, an object, undefined", async () => {
    for (const bad of [123456789, { length: 99, toString: () => "x".repeat(99) }, undefined]) {
      expect(await updateMyPassword(bad as unknown as string)).toEqual({ ok: false, error: dict("en").au_password8 });
    }
    expect(state.calls).toEqual([]);
  });
});
