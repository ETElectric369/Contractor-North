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
 *   - WHO GIVES THE CURRENT PASSWORD (cn-v1203): the caller's own must_reset_password. Flagged (the
 *     first-password page): none asked, checked or sent. Not flagged (Settings › You): required,
 *     checked by lib/supabase/password-check (stood in here), and sent as current_password with the
 *     save only after a match. The cases above this rule run as a flagged person; its own block is
 *     at the end.
 */
const state = vi.hoisted(() => ({
  user: { id: "larkspur", email: "sam.tillery@example.com" } as { id: string; email?: string } | null,
  mustReset: true as boolean | null,
  /** When set, the flag read answers exactly this row (a row without the field, or with null). */
  flagRow: undefined as undefined | Record<string, unknown>,
  flagReadError: null as null | Record<string, unknown>,
  flagReadThrows: false,
  check: { result: "ok", code: null, status: null } as { result: "ok" | "wrong" | "unknown"; code: string | null; status: number | null },
  checkArgs: [] as unknown[][],
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
vi.mock("@/lib/supabase/password-check", () => ({
  checkCurrentPassword: async (...a: unknown[]) => {
    state.calls.push("check");
    state.checkArgs.push(a);
    return state.check;
  },
}));
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
      select: (cols: string) => ({
        eq: () => ({
          limit: () => ({ maybeSingle: async () => ({ data: { language: state.language }, error: null }) }),
          // cn-v1203: the caller's own must_reset_password.
          maybeSingle: async () => {
            expect(cols).toBe("must_reset_password");
            state.calls.push("read-flag");
            if (state.flagReadThrows) throw new Error("stand-in network failure");
            if (state.flagReadError) return { data: null, error: state.flagReadError };
            if (state.flagRow !== undefined) return { data: state.flagRow, error: null };
            return { data: state.mustReset === null ? null : { must_reset_password: state.mustReset }, error: null };
          },
        }),
      }),
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
  state.user = { id: "larkspur", email: "sam.tillery@example.com" };
  state.mustReset = true;
  state.flagRow = undefined;
  state.flagReadError = null;
  state.flagReadThrows = false;
  state.check = { result: "ok", code: null, status: null };
  state.checkArgs = [];
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
    // cn-v1203: the current password sent was wrong.
    ["current_password_invalid", (l) => dict(l).au_currentPasswordWrong],
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
    expect(state.calls).toEqual(["read-flag", "updateUser", "signOut", 'flag:{"must_reset_password":false}']);
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

describe("who gives the current password (cn-v1203)", () => {
  const NEW = () => ` ${["snowbell", "ridge", String(8 * 9)].join("-")} `;
  const CUR = () => ` ${["larkspur", "meadow", String(6 * 7)].join("-")} `;
  beforeEach(() => {
    state.mustReset = false;
  });

  it("not flagged and no current password (undefined, empty, a non-string): needed; neither the check nor updateUser", async () => {
    for (const lang of ["en", "es"] as const) {
      state.language = lang;
      for (const cur of [undefined, "", 12345678, { toString: () => "x" }]) {
        expect(await updateMyPassword(NEW(), cur as unknown as string)).toEqual({ ok: false, error: dict(lang).au_currentPasswordNeeded });
      }
    }
    expect(state.calls.filter((c) => c !== "read-flag")).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("not flagged and wrong: the wrong sentence in both languages; updateUser never called", async () => {
    state.check = { result: "wrong", code: "invalid_credentials", status: 400 };
    for (const lang of ["en", "es"] as const) {
      state.language = lang;
      expect(await updateMyPassword(NEW(), CUR())).toEqual({ ok: false, error: dict(lang).au_currentPasswordWrong });
    }
    expect(state.calls).not.toContain("updateUser");
    expect(state.calls).not.toContain("signOut");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("not flagged and unknown: the unchecked sentence, one report with the code and status only", async () => {
    state.check = { result: "unknown", code: "over_request_rate_limit", status: 429 };
    const cur = CUR();
    const res = await updateMyPassword(NEW(), cur);
    expect(res).toEqual({ ok: false, error: dict("en").au_currentPasswordUnchecked });
    expect(state.calls).not.toContain("updateUser");
    expect(reportError).toHaveBeenCalledTimes(1);
    const [where, err, extra] = reportError.mock.calls[0];
    expect(where).toBe("set-password-check-current");
    expect(extra).toEqual({ code: "over_request_rate_limit", status: 429 });
    const said = JSON.stringify([String(err), (err as Error).message, extra]);
    for (const secret of [cur, cur.trim(), NEW(), "sam.tillery@example.com", "example.com"]) expect(said).not.toContain(secret);
  });

  it("not flagged, and the user carries no email: unchecked, reported, nothing saved", async () => {
    state.user = { id: "larkspur" };
    expect(await updateMyPassword(NEW(), CUR())).toEqual({ ok: false, error: dict("en").au_currentPasswordUnchecked });
    expect(state.calls).not.toContain("check");
    expect(state.calls).not.toContain("updateUser");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0]).toBe("set-password-check-current");
  });

  it("not flagged and ok: the check with the person's own email and what was typed, then updateUser ONCE with exactly { password, current_password }, then the rest as before", async () => {
    const [nw, cur] = [NEW(), CUR()];
    expect(await updateMyPassword(nw, cur)).toEqual({ ok: true, othersSignedOut: true });
    expect(state.checkArgs).toEqual([["sam.tillery@example.com", cur]]);
    expect(state.updateArgs).toEqual([{ password: nw, current_password: cur }]);
    expect(state.calls).toEqual(["read-flag", "check", "updateUser", "signOut", 'flag:{"must_reset_password":false}']);
    expect(state.signOutArgs).toEqual([{ scope: "others" }]);
  });

  it("flagged and nothing given: updateUser with exactly { password }, the check never made", async () => {
    state.mustReset = true;
    const nw = NEW();
    expect(await updateMyPassword(nw)).toEqual({ ok: true, othersSignedOut: true });
    expect(state.updateArgs).toEqual([{ password: nw }]);
    expect(state.calls).not.toContain("check");
  });

  it("flagged and a current password given: still no check, and no current_password sent", async () => {
    state.mustReset = true;
    const nw = NEW();
    expect(await updateMyPassword(nw, CUR())).toEqual({ ok: true, othersSignedOut: true });
    expect(state.updateArgs).toEqual([{ password: nw }]);
    expect(state.calls).not.toContain("check");
  });

  it("a failed read of the flag (an error, no row, a throw): could-not-update, one report with the code only, nothing saved", async () => {
    const tries: (() => void)[] = [
      () => (state.flagReadError = { code: "PGRST301", message: "stand-in" }),
      () => (state.mustReset = null),
      () => (state.flagReadThrows = true),
    ];
    for (const set of tries) {
      state.flagReadError = null;
      state.mustReset = false;
      state.flagReadThrows = false;
      state.calls = [];
      reportError.mockClear();
      set();
      expect(await updateMyPassword(NEW(), CUR())).toEqual({ ok: false, error: dict("en").au_couldNotUpdate });
      expect(state.calls).toEqual(["read-flag"]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0][0]).toBe("set-password-read-flag");
      expect(Object.keys(reportError.mock.calls[0][2])).toEqual(["code"]);
    }
    expect(reportError.mock.calls[0][2]).toEqual({ code: null });
  });

  it("a row with no must_reset_password field, or with null, is NOT flagged: the current password is required (skeptic #100)", async () => {
    for (const row of [{}, { must_reset_password: null }, { must_reset_password: "true" }, { must_reset_password: 1 }]) {
      state.flagRow = row;
      state.calls = [];
      expect(await updateMyPassword(NEW())).toEqual({ ok: false, error: dict("en").au_currentPasswordNeeded });
      expect(state.calls).toEqual(["read-flag"]);
    }
    state.flagRow = { must_reset_password: null };
    state.calls = [];
    const [nw, cur] = [NEW(), CUR()];
    expect(await updateMyPassword(nw, cur)).toEqual({ ok: true, othersSignedOut: true });
    expect(state.checkArgs).toEqual([["sam.tillery@example.com", cur]]);
    expect(state.updateArgs).toEqual([{ password: nw, current_password: cur }]);
  });

  it("a current password made only of spaces is checked as typed: not trimmed, not refused as missing (skeptic #100)", async () => {
    const spaces = "        ";
    const nw = NEW();
    expect(await updateMyPassword(nw, spaces)).toEqual({ ok: true, othersSignedOut: true });
    expect(state.checkArgs).toEqual([["sam.tillery@example.com", spaces]]);
    expect(state.updateArgs).toEqual([{ password: nw, current_password: spaces }]);
    state.check = { result: "wrong", code: "invalid_credentials", status: 400 };
    expect(await updateMyPassword(nw, " ")).toEqual({ ok: false, error: dict("en").au_currentPasswordWrong });
    expect(state.checkArgs[1]).toEqual(["sam.tillery@example.com", " "]);
  });

  it("the server's current_password_invalid after a match: the wrong sentence in both languages", async () => {
    state.updateError = { code: "current_password_invalid", status: 400, message: SERVER_ENGLISH };
    for (const lang of ["en", "es"] as const) {
      state.language = lang;
      expect(await updateMyPassword(NEW(), CUR())).toEqual({ ok: false, error: dict(lang).au_currentPasswordWrong });
    }
    expect(reportError).not.toHaveBeenCalled();
  });

  it("current_password_required and reauthentication_needed keep the fresh-sign-in sentence", async () => {
    state.mustReset = true;
    for (const code of ["current_password_required", "reauthentication_needed"]) {
      state.updateError = { code, status: 400 };
      expect((await updateMyPassword(NEW())).error).toBe(dict("en").au_signInFreshToChange.replace("{door}", dict("en").au_signInWithCode));
    }
  });
});
