import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SIGN-IN SPEAKS THE PHONE'S LANGUAGE (login/page.tsx + login/actions.ts, cn-v1138). Nobody is signed
 * in on this door, so the words are the Accept-Language header's first tag (lib/request-lang): an
 * es-MX phone reads the Spanish headline, labels and Title Case doors, and the errors the actions
 * send back come in the same language, from the same header read, so page and error agree. An
 * en-US phone reads exactly what it read before. The deactivation sentence is the one in
 * lib/deactivation-gate, pinned equal to the catalog's English.
 */
const state = vi.hoisted(() => ({ acceptLanguage: "en-US,en;q=0.9", userAgent: "Mozilla/5.0", signInError: null as null | { message: string } }));

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
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signInWithPassword: async () => ({ error: state.signInError }),
      signInWithOtp: async () => ({ error: null }),
      verifyOtp: async () => ({ error: null }),
      resetPasswordForEmail: async () => ({ error: null }),
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
});

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
    expect(t).toContain("Iniciar Sesión Con Un Código — Sin Contraseña");
    expect(t).toContain("¿Necesitas una cuenta?");
    expect(t).toContain("Registrarme");
    expect(html).toContain('placeholder="tu@empresa.com"');
    expect(t).not.toMatch(/Sign in|Welcome back|Forgot Password/);
    // The code door, both halves.
    expect(text(await render({ mode: "code" }))).toContain("Envíame Un Código Por Correo");
    const sent = text(await render({ mode: "code", sent: "1", email: "larkspur@example.test" }));
    expect(sent).toContain("Código de 6 dígitos");
    expect(sent).toContain("Enviado a larkspur@example.test: escribe el código o toca el enlace del correo. Revisa el spam si no lo ves.");
    expect(sent).toContain("Verificar E Iniciar Sesión");
    expect(sent).toContain("Reenviar Código");
    expect(sent).toContain("Mejor Usar Una Contraseña");
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
    expect(t).toContain("Sign In With A Code Instead — No Password");
    expect(t).toContain("Need an account?");
    expect(text(await render({ mode: "code", sent: "1", email: "a@b.test" }))).toContain("Sent to a@b.test — enter the code, or just tap the sign-in link in the email. Check spam if it's not there.");
    expect((await generateMetadata()).title).toBe("Team login");
    // An error the action sent back is shown as it came.
    expect(text(await render({ error: "Esta cuenta fue desactivada. Habla con tu oficina." }))).toContain("Esta cuenta fue desactivada. Habla con tu oficina.");
  });
});

describe("the actions' errors come back in the same language as the page", () => {
  it("es-MX: a banned seat, an empty email, a short code, a reset with no email", async () => {
    state.acceptLanguage = "es-MX,es;q=0.9";
    state.signInError = { message: "User is banned" };
    expect(await redirectOf(login(form({ email: "a@b.test", password: "x" })))).toBe("/login?error=Esta cuenta fue desactivada. Habla con tu oficina.");
    expect(await redirectOf(sendLoginCode(form({ email: "" })))).toBe("/login?mode=code&error=Escribe tu correo.");
    expect(await redirectOf(verifyLoginCode(form({ email: "a@b.test", code: "12" })))).toBe("/login?mode=code&email=a@b.test&sent=1&error=Escribe el código de 6 dígitos de tu correo.");
    expect(await redirectOf(requestPasswordReset(form({ email: "" })))).toBe("/forgot?error=Escribe tu correo.");
    expect(await redirectOf(requestPasswordReset(form({ email: "a@b.test" })))).toBe("/forgot?message=Si ese correo tiene cuenta, ya va en camino un enlace para restablecerla.");
  });

  it("en-US: the same doors say what they said before; GoTrue's own sentence passes through untouched", async () => {
    state.signInError = { message: "User is banned" };
    expect(await redirectOf(login(form({ email: "a@b.test", password: "x" })))).toBe(`/login?error=${DEACTIVATED_MESSAGE}`);
    state.signInError = { message: "Invalid login credentials" };
    expect(await redirectOf(login(form({ email: "a@b.test", password: "x" })))).toBe("/login?error=Invalid login credentials");
    expect(await redirectOf(sendLoginCode(form({ email: "" })))).toBe("/login?mode=code&error=Enter your email.");
    expect(await redirectOf(verifyLoginCode(form({ email: "a@b.test", code: "12" })))).toBe("/login?mode=code&email=a@b.test&sent=1&error=Enter the 6-digit code from your email.");
    expect(await redirectOf(requestPasswordReset(form({ email: "a@b.test" })))).toBe("/forgot?message=If that email has an account, a reset link is on its way.");
  });

  it("the deactivation sentence is lib/deactivation-gate's, in the catalog, and every door label is Title Case in both languages", () => {
    expect(dict("en").au_deactivated).toBe(DEACTIVATED_MESSAGE);
    expect(dict("es").au_deactivated).not.toBe(DEACTIVATED_MESSAGE);
    for (const key of ["au_signIn", "au_signUp", "au_createAccount", "au_verifySignIn", "au_resendCode", "au_usePassword", "au_emailMeCode", "au_forgotPassword", "au_signInWithCode", "au_setMyPassword", "au_savePasswordContinue"]) {
      for (const lang of ["en", "es"] as const) {
        const words = dict(lang)[key].split(/\s+/).filter((w) => /\p{L}/u.test(w));
        expect(words.every((w) => /^[^\p{L}]*\p{Lu}/u.test(w)), `${lang}:${key} "${dict(lang)[key]}"`).toBe(true);
      }
    }
  });
});
