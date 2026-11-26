import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomInt } from "node:crypto";

/**
 * SIGN-IN SPEAKS THE PHONE'S LANGUAGE (login/page.tsx + login/actions.ts, cn-v1138). Nobody is signed
 * in on this door, so the words are the Accept-Language header's first tag (lib/request-lang): an
 * es-MX phone reads the Spanish headline, labels and Title Case doors, and the errors the actions
 * send back come in the same language, from the same header read, so page and error agree. An
 * en-US phone reads exactly what it read before. The deactivation sentence is the one in
 * lib/deactivation-gate, pinned equal to the catalog's English.
 */
const state = vi.hoisted(() => ({
  acceptLanguage: "en-US,en;q=0.9",
  userAgent: "Mozilla/5.0",
  signInError: null as null | { message: string },
  // cn-v1199: the app's own email. The work after() queues, the limiter's answer, the addresses that
  // have an account (any other gets the admin API's 404), what was minted and what was sent.
  afters: [] as Array<() => unknown>,
  limited: false,
  accounts: new Set<string>(),
  minted: [] as unknown[],
  sent: [] as Array<{ to: string; subject: string }>,
  authServerSends: [] as string[],
  verified: [] as unknown[],
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "accept-language": state.acceptLanguage, "user-agent": state.userAgent })),
  cookies: vi.fn(async () => ({ getAll: () => [], delete: () => {} })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((fn: () => unknown) => void state.afters.push(fn)),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimited: vi.fn(async () => state.limited),
  clientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        generateLink: async (input: { type: string; email: string }) => {
          state.minted.push(input);
          if (!state.accounts.has(input.email)) return { data: { user: null, properties: null }, error: { status: 404, code: "user_not_found", message: "User not found" } };
          return { data: { user: { id: "u1" }, properties: { email_otp: String(100000 + state.minted.length), hashed_token: `h${Date.now()}` } }, error: null };
        },
      },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { active: true, language: null }, error: null }) }) }) }),
  }),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async (input: { to: string; subject: string }) => {
    state.sent.push({ to: input.to, subject: input.subject });
    return { ok: true };
  }),
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signInWithPassword: async () => ({ error: state.signInError }),
      signInWithOtp: async () => {
        state.authServerSends.push("signInWithOtp");
        return { error: { message: "Signups not allowed for otp" } };
      },
      verifyOtp: async (input: unknown) => {
        state.verified.push(input);
        return { error: null };
      },
      resetPasswordForEmail: async () => {
        state.authServerSends.push("resetPasswordForEmail");
        return { error: null };
      },
      getUser: async () => ({ data: { user: null } }),
      getSession: async () => ({ data: { session: null } }),
      signOut: async () => ({ error: null }),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }), limit: async () => ({ data: [] }) }) }) }),
    rpc: async () => ({ data: true, error: null }),
  })),
}));

import LoginPage, { generateMetadata } from "./page";
import { login, sendLoginCode, verifyLoginCode, requestPasswordReset } from "./actions";
import { dict } from "@/lib/i18n";
import { DEACTIVATED_MESSAGE } from "@/lib/deactivation-gate";
import { titleCaseIn } from "../../../tests/title-case-words";

const render = async (params: Record<string, string> = {}) => renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const redirectOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return decodeURIComponent(String((e as Error).message).replace(/^REDIRECT /, ""));
  }
  throw new Error("no redirect");
};

beforeEach(() => {
  state.acceptLanguage = "en-US,en;q=0.9";
  state.userAgent = "Mozilla/5.0";
  state.signInError = null;
  state.afters = [];
  state.limited = false;
  state.verified = [];
  state.accounts = new Set(["sam.tillery@example.com"]);
  state.minted = [];
  state.sent = [];
  state.authServerSends = [];
  vi.stubEnv("RESEND_API_KEY", "stand-in");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.com");
});

/** Run what after() queued, as the host does once the answer has gone. */
const flushAfters = async () => {
  const queued = state.afters.splice(0);
  for (const fn of queued) await fn();
};

describe("the page", () => {
  it("an es-MX phone: the Spanish headline, labels, Title Case doors and footer; the brand stays", async () => {
    state.acceptLanguage = "es-MX,es;q=0.9,en;q=0.8";
    const html = await render();
    const t = text(html);
    expect(t).toContain("Inicia sesión");
    expect(t).toContain("Qué bueno verte de nuevo.");
    expect(t).toContain("Contractor North");
    expect(t).toContain("La plataforma todo en uno para contratistas");
    expect(t).toContain("Correo");
    expect(t).toContain("Contraseña");
    expect(t).toContain("¿Olvidaste Tu Contraseña?");
    expect(t).toContain("Iniciar Sesión");
    expect(t).toContain("Iniciar Sesión con un Código — Sin Contraseña");
    expect(t).toContain("¿Necesitas una cuenta?");
    expect(t).toContain("Registrarme");
    expect(html).toContain('placeholder="tu@empresa.com"');
    expect(t).not.toMatch(/Sign in|Welcome back|Forgot Password/);
    // The code door, both halves.
    expect(text(await render({ mode: "code" }))).toContain("Envíame un Código por Correo");
    const sent = text(await render({ mode: "code", sent: "1", email: "larkspur@example.test" }));
    // cn-v1199: the screen names no length (it is the auth host's setting) and claims no email was sent.
    expect(sent).toContain("Escribe el código de tu correo.");
    expect(sent).not.toMatch(/6 dígitos|te acabamos de enviar/);
    expect(sent).toContain("Si larkspur@example.test tiene cuenta, ya va en camino un código. Escríbelo aquí o toca el botón del correo. Revisa el spam si no lo ves.");
    expect(sent).not.toContain("Enviado a");
    expect(sent).toContain("Verificar e Iniciar Sesión");
    expect(sent).toContain("Reenviar Código");
    expect(sent).toContain("Mejor Usar una Contraseña");
    // Sign-up, and the shell's two notes.
    const signup = text(await render({ mode: "signup" }));
    expect(signup).toContain("Crea tu cuenta");
    expect(signup).toContain("Nombre completo");
    expect(signup).toContain("Crear Cuenta");
    expect(signup).toContain("¿Ya tienes cuenta?");
    state.userAgent = "Mozilla/5.0 CNShell/1 (iOS)";
    expect(text(await render({ mode: "signup" }))).toContain("Las cuentas se crean desde tu correo de invitación en Safari.");
    expect(text(await render())).toContain("¿Tienes un correo de invitación?");
    expect((await generateMetadata()).title).toBe("Acceso del equipo");
  });

  it("an en-US phone reads what it read before, byte for byte", async () => {
    const t = text(await render());
    expect(t).toContain("Sign in");
    expect(t).toContain("Welcome back.");
    expect(t).toContain("The all-in-one platform for contractors");
    expect(t).toContain("Forgot Password?");
    expect(t).toContain("Sign In with a Code Instead — No Password");
    expect(t).toContain("Need an account?");
    // cn-v1199: the code box says nothing was sent for sure: an address with no account is answered the same and emailed nothing.
    const sentEn = text(await render({ mode: "code", sent: "1", email: "a@b.test" }));
    expect(sentEn).toContain("If a@b.test has an account, a code is on its way. Enter it here, or tap the button in the email. Check spam if it's not there.");
    expect(sentEn).not.toContain("Sent to");
    expect(sentEn).toContain("Enter the code from your email.");
    expect(sentEn).not.toMatch(/6-digit|emailed you/);
    expect((await generateMetadata()).title).toBe("Team login");
    // An error the action sent back is shown as it came.
    expect(text(await render({ error: "Esta cuenta fue desactivada. Habla con tu oficina." }))).toContain("Esta cuenta fue desactivada. Habla con tu oficina.");
  });
});

describe("the typed code is sent whole, whatever its length (cn-v1199: how long a code is belongs to the auth host)", () => {
  it("six, eight and ten digits each reach the verify call as typed, a space dropped; five digits are refused before any call", async () => {
    for (const digits of [6, 8, 10]) {
      const code = String(randomInt(10 ** (digits - 1), 10 ** digits));
      state.verified = [];
      expect(await redirectOf(verifyLoginCode(form({ email: "Sam.Tillery@example.com", code: `${code.slice(0, 3)} ${code.slice(3)}` })))).toBe("/planner");
      expect(state.verified).toEqual([{ email: "sam.tillery@example.com", token: code, type: "email" }]);
    }
    state.verified = [];
    expect(await redirectOf(verifyLoginCode(form({ email: "a@b.test", code: "12345" })))).toBe("/login?mode=code&email=a@b.test&sent=1&error=Enter the whole code from your email.");
    expect(state.verified).toEqual([]);
  });

  it("after a refusal the screen still has the box for a code already in the inbox, and does not say another is on its way", async () => {
    const refused = await render({ mode: "code", sent: "1", email: "a@b.test", error: "Too many emails asked for. Try again in an hour." });
    expect(refused).toMatch(/<input[^>]*id="code"/);
    expect(text(refused)).toContain("Too many emails asked for. Try again in an hour.");
    expect(text(refused)).not.toContain("is on its way");
    expect(text(await render({ mode: "code", sent: "1", email: "a@b.test" }))).toContain("is on its way");
  });

  it("the box on the screen takes ten digits", async () => {
    const box = (await render({ mode: "code", sent: "1", email: "a@b.test" })).match(/<input[^>]*id="code"[^>]*>/)?.[0] ?? "";
    expect(box).toContain('maxLength="10"');
  });
});

describe("the actions' errors come back in the same language as the page", () => {
  it("es-MX: a banned seat, an empty email, a short code, a reset with no email", async () => {
    state.acceptLanguage = "es-MX,es;q=0.9";
    state.signInError = { message: "User is banned" };
    expect(await redirectOf(login(form({ email: "a@b.test", password: "x" })))).toBe("/login?error=Esta cuenta fue desactivada. Habla con tu oficina.");
    expect(await redirectOf(sendLoginCode(form({ email: "" })))).toBe("/login?mode=code&error=Escribe tu correo.");
    expect(await redirectOf(verifyLoginCode(form({ email: "a@b.test", code: "12" })))).toBe("/login?mode=code&email=a@b.test&sent=1&error=Escribe el código completo de tu correo.");
    expect(await redirectOf(requestPasswordReset(form({ email: "" })))).toBe("/forgot?error=Escribe tu correo.");
    expect(await redirectOf(requestPasswordReset(form({ email: "a@b.test" })))).toBe("/forgot?message=Si ese correo tiene cuenta, ya va en camino un enlace para restablecerla.");
  });

  it("en-US: the same doors say what they said before; GoTrue's own sentence passes through untouched", async () => {
    state.signInError = { message: "User is banned" };
    expect(await redirectOf(login(form({ email: "a@b.test", password: "x" })))).toBe(`/login?error=${DEACTIVATED_MESSAGE}`);
    state.signInError = { message: "Invalid login credentials" };
    expect(await redirectOf(login(form({ email: "a@b.test", password: "x" })))).toBe("/login?error=Invalid login credentials");
    expect(await redirectOf(sendLoginCode(form({ email: "" })))).toBe("/login?mode=code&error=Enter your email.");
    expect(await redirectOf(verifyLoginCode(form({ email: "a@b.test", code: "12" })))).toBe("/login?mode=code&email=a@b.test&sent=1&error=Enter the whole code from your email.");
    expect(await redirectOf(requestPasswordReset(form({ email: "a@b.test" })))).toBe("/forgot?message=If that email has an account, a reset link is on its way.");
  });

  it("the deactivation sentence is lib/deactivation-gate's, in the catalog, and every door label is Title Case in both languages", () => {
    expect(dict("en").au_deactivated).toBe(DEACTIVATED_MESSAGE);
    expect(dict("es").au_deactivated).not.toBe(DEACTIVATED_MESSAGE);
    for (const key of ["au_signIn", "au_signUp", "au_createAccount", "au_verifySignIn", "au_resendCode", "au_usePassword", "au_emailMeCode", "au_forgotPassword", "au_signInWithCode", "au_setMyPassword", "au_savePasswordContinue"]) {
      for (const lang of ["en", "es"] as const) {
        // Title Case by each language's rule: English every word, Spanish the significant words (cn-v1147).
        expect(titleCaseIn(dict(lang)[key], lang), `${lang}:${key} "${dict(lang)[key]}"`).toBe(true);
      }
    }
  });
});

describe("the app sends the email itself, and the door answers every address the same (cn-v1199)", () => {
  it("Email Me a Code: the same code box for an account and for none, no server sentence passed through, nothing asked of the auth server's mailer; only the account is emailed", async () => {
    const real = await redirectOf(sendLoginCode(form({ email: "Sam.Tillery@example.com" })));
    const none = await redirectOf(sendLoginCode(form({ email: "dana.rook@example.com" })));
    expect(real).toBe("/login?mode=code&email=sam.tillery@example.com&sent=1");
    expect(none).toBe("/login?mode=code&email=dana.rook@example.com&sent=1");
    expect(real.replace("sam.tillery", "X")).toBe(none.replace("dana.rook", "X"));
    // The mint and the send wait for after(): nothing was minted while the door answered.
    expect(state.minted).toEqual([]);
    await flushAfters();
    expect(state.minted).toEqual([{ type: "recovery", email: "sam.tillery@example.com" }, { type: "recovery", email: "dana.rook@example.com" }]);
    expect(state.sent).toEqual([{ to: "sam.tillery@example.com", subject: "Your Contractor North sign-in code" }]);
    expect(state.authServerSends).toEqual([]);
  });

  it("the reset: the same sentence for an account and for none; only the account is emailed, in the phone's language", async () => {
    state.acceptLanguage = "es-MX,es;q=0.9";
    const real = await redirectOf(requestPasswordReset(form({ email: "sam.tillery@example.com" })));
    const none = await redirectOf(requestPasswordReset(form({ email: "dana.rook@example.com" })));
    expect(real).toBe(none);
    expect(real).toBe("/forgot?message=Si ese correo tiene cuenta, ya va en camino un enlace para restablecerla.");
    await flushAfters();
    expect(state.sent).toEqual([{ to: "sam.tillery@example.com", subject: "Crea una nueva contraseña de Contractor North" }]);
    expect(state.authServerSends).toEqual([]);
  });

  it("too many asked: one sentence naming one thing to do, in both languages, and nothing minted or queued; the code door keeps its box", async () => {
    state.limited = true;
    expect(await redirectOf(sendLoginCode(form({ email: "sam.tillery@example.com" })))).toBe("/login?mode=code&email=sam.tillery@example.com&sent=1&error=Too many emails asked for. Try again in an hour.");
    expect(await redirectOf(requestPasswordReset(form({ email: "sam.tillery@example.com" })))).toBe("/forgot?error=Too many emails asked for. Try again in an hour.");
    state.acceptLanguage = "es-MX,es;q=0.9";
    expect(await redirectOf(sendLoginCode(form({ email: "sam.tillery@example.com" })))).toBe("/login?mode=code&email=sam.tillery@example.com&sent=1&error=Se pidieron demasiados correos. Vuelve a intentarlo en una hora.");
    expect(await redirectOf(requestPasswordReset(form({ email: "dana.rook@example.com" })))).toBe("/forgot?error=Se pidieron demasiados correos. Vuelve a intentarlo en una hora.");
    expect(state.afters).toEqual([]);
    await flushAfters();
    expect(state.minted).toEqual([]);
    expect(state.sent).toEqual([]);
  });
});
