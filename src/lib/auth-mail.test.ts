import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE APP SENDS ITS OWN SIGN-IN EMAILS (lib/auth-mail, cn-v1199). Driven on stand-ins for the admin
 * client, the mailer and the limiter: the mint is only ever a "recovery" link (a magiclink or signup
 * mint CREATES an account), an address with no account is emailed nothing and a real one is, a
 * deactivated person is emailed nothing, and the code, the hash, the link and the address never reach
 * the error sink or the console. The emails' words, buttons, link and escaping are pinned in both
 * languages. Every token-shaped value is built at run time.
 */
const state = vi.hoisted(() => ({
  mint: null as null | { data: unknown; error: unknown },
  mintThrows: null as null | Error,
  profile: { data: { active: true, language: null } as unknown, error: null as unknown },
  calls: { generateLink: [] as unknown[], profileIds: [] as unknown[], sent: [] as Array<{ to: string; subject: string; html: string; bcc?: unknown; fromName?: unknown }>, limits: [] as unknown[][] },
  limited: [] as string[],
  // What the sink has FILED: written a macrotask after the call, so a report not awaited is not here yet.
  filed: [] as unknown[][],
  sendResult: { ok: true } as { ok: boolean; error?: string },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        generateLink: async (input: unknown) => {
          state.calls.generateLink.push(input);
          if (state.mintThrows) throw state.mintThrows;
          return state.mint;
        },
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, id: unknown) => ({
          maybeSingle: async () => {
            expect(table).toBe("profiles");
            state.calls.profileIds.push(id);
            return state.profile;
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async (input: { to: string; subject: string; html: string }) => {
    state.calls.sent.push(input);
    return state.sendResult;
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimited: vi.fn(async (...args: unknown[]) => {
    state.calls.limits.push(args);
    return state.limited.some((k) => String(args[0]).startsWith(k));
  }),
}));
vi.mock("@/lib/observe", () => ({
  reportErrorAwaited: vi.fn(async (...args: unknown[]) => {
    await new Promise((r) => setTimeout(r, 0));
    state.filed.push(args);
  }),
}));

import { AUTH_MAIL_LIMITS, SIGN_IN_NEXT, authMailRefused, mailOneTimeCode, mailboxKey, oneTimeLink, renderAuthEmail } from "./auth-mail";
import { reportErrorAwaited } from "@/lib/observe";
import { translator } from "@/lib/i18n";
import { titleCaseIn } from "../../tests/title-case-words";

const SITE = "https://app.example.com";
const EMAIL = "sam.tillery@example.com";
const USER = "u-sam";
let code = "";
let hash = "";

/** The link as it sits in an href: the ampersands escaped (lib/email's attr). */
const amp = (s: string) => s.replace(/&/g, "&amp;");
const realMint = () => ({ data: { user: { id: USER, email: EMAIL }, properties: { email_otp: code, hashed_token: hash, action_link: `${SITE}/#unused` } }, error: null });
const send = (kind: "signin" | "reset", requestLang: "en" | "es" = "en", email = EMAIL) => mailOneTimeCode({ kind, email, requestLang, translatorFor: translator });

let consoleCalls: unknown[][] = [];
beforeEach(() => {
  code = String(randomInt(100000, 1000000));
  hash = randomBytes(28).toString("hex");
  state.mint = realMint();
  state.mintThrows = null;
  state.profile = { data: { active: true, language: null }, error: null };
  state.calls = { generateLink: [], profileIds: [], sent: [], limits: [] };
  state.limited = [];
  state.filed = [];
  state.sendResult = { ok: true };
  vi.mocked(reportErrorAwaited).mockClear();
  vi.stubEnv("RESEND_API_KEY", `stand-in-${randomBytes(4).toString("hex")}`);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  consoleCalls = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Everything the sink and the console heard, as one string. */
const heard = () =>
  JSON.stringify([
    ...state.filed.map((c) => c.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : x))),
    ...consoleCalls,
  ]);

describe("the mint is a recovery link, only ever", () => {
  it("both emails mint with type recovery (a magiclink or signup mint would CREATE an account for an invited address)", async () => {
    await send("signin");
    await send("reset");
    expect(state.calls.generateLink).toEqual([{ type: "recovery", email: EMAIL }, { type: "recovery", email: EMAIL }]);
    // And no other type is written anywhere in the file's code.
    const src = readFileSync(join(process.cwd(), "src/lib/auth-mail.ts"), "utf8");
    const types = [...src.matchAll(/type:\s*"(\w+)"/g)].map((m) => m[1]);
    expect(types).toEqual(["recovery"]);
  });
});

describe("no account, no email; a real one is emailed", () => {
  it("an address with no account (404) is emailed nothing and nothing is filed; a real one gets one email, no bcc, no fromName", async () => {
    state.mint = { data: { user: null, properties: null }, error: { status: 404, code: "user_not_found", message: "User not found" } };
    await send("signin", "en", "dana.rook@example.com");
    expect(state.calls.sent).toEqual([]);
    expect(reportErrorAwaited).not.toHaveBeenCalled();
    state.mint = realMint();
    await send("signin");
    expect(state.calls.sent).toHaveLength(1);
    expect(state.calls.sent[0].to).toBe(EMAIL);
    expect(state.calls.sent[0].bcc).toBeUndefined();
    expect(state.calls.sent[0].fromName).toBeUndefined();
    expect(state.calls.profileIds).toEqual([USER]);
  });

  it("a deactivated person is emailed nothing", async () => {
    state.profile = { data: { active: false, language: "en" }, error: null };
    await send("signin");
    await send("reset");
    expect(state.calls.sent).toEqual([]);
  });

  it("no mailer set up: no mint, no email, and the sink hears only that", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    await send("signin");
    expect(state.calls.generateLink).toEqual([]);
    expect(state.calls.sent).toEqual([]);
    expect(heard()).toContain("mail not configured");
    expect(heard()).not.toContain(EMAIL);
  });
});

describe("the secrets never reach the sink or the console", () => {
  it("not the code, the hash, the link or the address: on a sent email, a refused mint, a failed profile read, a throw", async () => {
    await send("signin");
    const link = oneTimeLink(SITE, hash, "signin")!;
    expect(state.calls.sent[0].html).toContain(code);
    // A refused mint whose message names the address.
    state.mint = { data: null, error: { status: 500, code: "unexpected_failure", message: `failed for ${EMAIL} ${hash}` } };
    await send("signin");
    // A profile read that fails with the address in its message.
    state.mint = realMint();
    state.profile = { data: null, error: { code: "PGRST000", message: `boom ${EMAIL} ${code}` } };
    await send("reset");
    // A throw carrying the hash.
    state.mintThrows = new Error(`network down at ${link} for ${EMAIL}`);
    await send("signin");
    expect(state.filed.length).toBe(3);
    const all = heard();
    for (const secret of [code, hash, EMAIL, link, encodeURIComponent(hash)]) expect(all).not.toContain(secret);
    expect(all).toContain("code=unexpected_failure");
    expect(all).toContain("status=500");
  });

  it("every report is AWAITED (this runs past the answer): each failure is filed before mailOneTimeCode returns", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    await send("signin");
    expect(state.filed.length).toBe(1);
    vi.stubEnv("RESEND_API_KEY", `stand-in-${randomBytes(4).toString("hex")}`);
    state.mint = { data: null, error: { status: 500, code: "unexpected_failure" } };
    await send("signin");
    expect(state.filed.length).toBe(2);
    state.mint = realMint();
    state.profile = { data: null, error: { code: "PGRST000" } };
    await send("reset");
    expect(state.filed.length).toBe(3);
    state.profile = { data: { active: true, language: null }, error: null };
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    await send("reset");
    expect(state.filed.length).toBe(4);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
    state.mintThrows = new Error("network down");
    await send("signin");
    expect(state.filed.length).toBe(5);
  });

  it("a send that did not go is filed, bare: the place only, never the mailer's text, the address, the code, the hash or the link", async () => {
    state.sendResult = { ok: false, error: `Resend refused ${EMAIL} code ${code} hash ${hash}` };
    await send("signin");
    expect(state.calls.sent).toHaveLength(1);
    expect(state.filed.length).toBe(1);
    const all = heard();
    expect(all).toContain("auth-mail:signin send failed");
    for (const secret of [code, hash, EMAIL, "Resend refused", oneTimeLink(SITE, hash, "signin", "en")!]) expect(all).not.toContain(secret);
    state.filed = [];
    state.sendResult = { ok: true };
    await send("signin");
    expect(state.filed).toEqual([]);
  });

  it("a failed profile read sends nothing (the person may be deactivated)", async () => {
    state.profile = { data: null, error: { code: "PGRST000" } };
    await send("signin");
    await send("reset");
    expect(state.calls.sent).toEqual([]);
    expect(state.filed.length).toBe(2);
  });

  it("a sign-in code is sent whole at whatever length the auth host mints, 6 to 10 digits (the length is its setting, not the app's)", async () => {
    for (const digits of [6, 8, 10]) {
      code = String(randomInt(10 ** (digits - 1), 10 ** digits));
      state.mint = realMint();
      state.calls.sent = [];
      await send("signin");
      expect(state.calls.sent).toHaveLength(1);
      expect(state.calls.sent[0].html).toContain(`font-family:ui-monospace,Menlo,monospace">${code}</p>`);
    }
    expect(state.filed).toEqual([]);
  });

  it("a sign-in mint whose code could not be typed in the box (too short, too long, not digits) is not sent, and the code is not filed", async () => {
    for (const bad of [String(randomInt(10000, 100000)), String(randomInt(10 ** 10, 10 ** 11)), `${randomInt(100, 1000)}abc`]) {
      code = bad;
      state.mint = realMint();
      state.calls.sent = [];
      state.filed = [];
      await send("signin");
      expect(state.calls.sent).toEqual([]);
      expect(heard()).toContain("no usable token");
      expect(heard()).not.toContain(bad);
    }
  });

  it("the subject carries no digit, in either email or language", async () => {
    for (const lang of ["en", "es"] as const) {
      state.profile = { data: { active: true, language: lang }, error: null };
      await send("signin");
      await send("reset");
    }
    expect(state.calls.sent).toHaveLength(4);
    for (const m of state.calls.sent) expect(m.subject).not.toMatch(/\d/);
  });
});

describe("the words, the buttons, the link", () => {
  it("the sign-in email: the code large, one Sign In button to /auth/confirm, the foot; English and Spanish", async () => {
    await send("signin");
    const en = state.calls.sent[0];
    expect(en.subject).toBe("Your Contractor North sign-in code");
    expect(en.html).toContain(`font-family:ui-monospace,Menlo,monospace">${code}</p>`);
    expect(en.html).toContain("Type it on the sign-in screen, or tap the button. It works once, for a short time.");
    expect(en.html).toContain(">Sign In</a>");
    expect(en.html).toContain(`href="${amp(`${SITE}/auth/confirm?token_hash=${hash}&type=recovery&next=%2Fplanner&lang=en&for=signin`)}"`);
    expect(en.html).toContain("Didn't ask for this? Ignore it. Your account stays as it is.");
    expect(en.html).not.toMatch(/minute|hour/i);
    state.profile = { data: { active: true, language: "es" }, error: null };
    await send("signin", "en");
    const es = state.calls.sent[1];
    expect(es.subject).toBe("Tu código para entrar a Contractor North");
    expect(es.html).toContain("Escríbelo en la pantalla de inicio o toca el botón. Sirve una vez y por poco tiempo.");
    expect(es.html).toContain(">Iniciar Sesión</a>");
    expect(es.html).toContain(`${amp("next=%2Fplanner&lang=es&for=signin")}"`);
    expect(es.html).toContain("¿No lo pediste? Ignora este correo. Tu cuenta sigue igual.");
  });

  it("the reset email: one Set My Password button to Set A Password, and NO code; English and Spanish", async () => {
    await send("reset");
    const en = state.calls.sent[0];
    expect(en.subject).toBe("Set a new Contractor North password");
    expect(en.html).toContain("Tap the button to choose a new password. It works once, for a short time.");
    expect(en.html).toContain(">Set My Password</a>");
    expect(en.html).toContain(`href="${amp(`${SITE}/auth/confirm?token_hash=${hash}&type=recovery&next=%2Fset-password&lang=en`)}"`);
    expect(en.html).not.toContain(code);
    expect(en.html).not.toContain("monospace");
    expect(en.html).not.toContain("for=signin");
    await send("reset", "es");
    const es = state.calls.sent[1];
    expect(es.subject).toBe("Crea una nueva contraseña de Contractor North");
    expect(es.html).toContain(">Crear Mi Contraseña</a>");
    expect(es.html).toContain(`${amp("next=%2Fset-password&lang=es")}"`);
    expect(es.html).toContain("¿No lo pediste? Ignora este correo. Tu cuenta sigue igual.");
    expect(es.html).not.toContain(code);
  });

  it("the language: the profile's when it names one, else the phone's", async () => {
    state.profile = { data: { active: true, language: "en" }, error: null };
    await send("signin", "es");
    expect(state.calls.sent[0].subject).toBe("Your Contractor North sign-in code");
    state.profile = { data: { active: true, language: null }, error: null };
    await send("signin", "es");
    expect(state.calls.sent[1].subject).toBe("Tu código para entrar a Contractor North");
    state.profile = { data: null, error: null };
    await send("reset", "es");
    expect(state.calls.sent[2].subject).toBe("Crea una nueva contraseña de Contractor North");
  });

  it("the link names the email's language, English too: an English profile on a Spanish phone gets lang=en", async () => {
    state.profile = { data: { active: true, language: "en" }, error: null };
    await send("signin", "es");
    await send("reset", "es");
    expect(state.calls.sent[0].html).toContain(`${amp("next=%2Fplanner&lang=en&for=signin")}"`);
    expect(state.calls.sent[1].html).toContain(`${amp("next=%2Fset-password&lang=en")}"`);
    expect(new URL(oneTimeLink(SITE, hash, "reset", "en")!).searchParams.get("lang")).toBe("en");
    expect(new URL(oneTimeLink(SITE, hash, "signin", "es")!).searchParams.getAll("lang")).toEqual(["es"]);
  });

  it("every button is Title Case in both languages", () => {
    for (const lang of ["en", "es"] as const) {
      const t = translator(lang);
      for (const kind of ["signin", "reset"] as const) {
        const { html } = renderAuthEmail(t, { kind, code: "000000", link: `${SITE}/x` });
        const label = html.match(/<a [^>]*>([^<]+)<\/a>/)![1];
        expect(titleCaseIn(label, lang), `${lang}:${kind} "${label}"`).toBe(true);
      }
    }
  });

  it("the link: no base or no hash is no link; a trailing slash is dropped; the sign-in link lands on My Day", () => {
    expect(SIGN_IN_NEXT).toBe("/planner");
    expect(oneTimeLink(undefined, hash, "signin")).toBeNull();
    expect(oneTimeLink(SITE, "", "reset")).toBeNull();
    const u = new URL(oneTimeLink(`${SITE}/`, hash, "signin", "es")!);
    expect(`${u.origin}${u.pathname}`).toBe(`${SITE}/auth/confirm`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ token_hash: hash, type: "recovery", next: "/planner", lang: "es", for: "signin" });
    expect(Object.fromEntries(new URL(oneTimeLink(SITE, hash, "reset")!).searchParams)).toEqual({ token_hash: hash, type: "recovery", next: "/set-password" });
  });

  it("every value put into the HTML is escaped", () => {
    const t = (k: string) => `<i>${k}</i> & "q"`;
    const { html } = renderAuthEmail(t, { kind: "signin", code: "<b>1</b>", link: 'https://x.test/?a="onmouseover="alert(1)' });
    expect(html).not.toMatch(/<i>|<b>/);
    expect(html).toContain("&lt;b&gt;1&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;au_mail_foot&lt;/i&gt; &amp;");
    expect(html).not.toContain('"onmouseover="');
  });
});

describe("the limits, checked before the mint and the same for every address", () => {
  it("per caller 20 an hour (a crew on one shop network shares one address) and per mailbox 3 in 15 minutes, both fail-closed; the mailbox key holds no address", async () => {
    expect(AUTH_MAIL_LIMITS).toEqual({ perCaller: { limit: 20, windowSeconds: 3600 }, perMailbox: { limit: 3, windowSeconds: 900 } });
    expect(await authMailRefused("203.0.113.9", " Sam.Tillery@Example.com ")).toBe(false);
    expect(state.calls.limits).toEqual([
      ["auth-mail-ip:203.0.113.9", 20, 3600, { failClosed: true }],
      [mailboxKey(EMAIL), 3, 900, { failClosed: true }],
    ]);
    expect(mailboxKey(EMAIL)).toMatch(/^auth-mail-to:[0-9a-f]{64}$/);
    expect(mailboxKey(EMAIL)).not.toContain("sam");
    state.limited = ["auth-mail-to:"];
    expect(await authMailRefused("203.0.113.9", EMAIL)).toBe(true);
    state.limited = ["auth-mail-ip:"];
    expect(await authMailRefused("203.0.113.9", EMAIL)).toBe(true);
  });
});
