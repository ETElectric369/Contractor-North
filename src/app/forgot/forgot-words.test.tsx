import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * FORGOT PASSWORD IS ONE PAGE, IN THE PHONE'S LANGUAGE (forgot/page.tsx, cn-v1200). Until cn-v1199 the
 * emailed reset link only finished in the browser that asked for it, so in the phone app this page hid
 * its form, said the link could not finish in the phone's browser, and pointed at a password door in
 * Settings that a person does not have. The link is now the app's own and finishes in any browser
 * (lib/auth-mail + /auth/confirm), so those sentences were untrue. The rules held here: the phone app
 * and a browser get the SAME form; none of the old claims is on the page; the tile is the app icon the
 * login page draws, not a bolt; the words are the au_ catalog's, in the language of the same header the
 * login page and the action read; every clickable is Title Case in both languages.
 */

const state = vi.hoisted(() => ({ acceptLanguage: "en-US,en;q=0.9", userAgent: "Mozilla/5.0" }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "accept-language": state.acceptLanguage, "user-agent": state.userAgent })),
}));
// The page only hands this action to its form; the action itself is held in login-words.test.tsx.
vi.mock("@/app/login/actions", () => ({ requestPasswordReset: vi.fn() }));

import ForgotPage, { generateMetadata } from "./page";
import { dict } from "@/lib/i18n";
import { NO_INDEX } from "@/lib/no-index";
import { titleCaseIn } from "../../../tests/title-case-words";

const render = async (params: Record<string, string> = {}) => renderToStaticMarkup(await ForgotPage({ searchParams: Promise.resolve(params) }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const SHELL = "Mozilla/5.0 CNShell/1 (iOS)";
/** What the phone-app branch used to say: a code length, a door in Settings, a link that cannot finish. */
const OLD_CLAIMS = /6-digit|6 dígitos|Settings|Ajustes|Safari|can't finish|can&#x27;t finish/;

beforeEach(() => {
  state.acceptLanguage = "en-US,en;q=0.9";
  state.userAgent = "Mozilla/5.0";
});

describe("the page", () => {
  it("an en-US browser: the heading, the one sentence, the form, the code door and the way back", async () => {
    const html = await render();
    const t = text(html);
    expect(t).toContain("Reset your password");
    expect(t).toContain("Enter your email and we'll send you a link to set a new password.");
    expect(t).toContain("Email");
    expect(html).toContain('placeholder="you@company.com"');
    expect(t).toContain("Send Reset Link");
    expect(t).toContain("Didn't get it, or the link won't open?");
    expect(t).toContain("Sign In with a Code");
    expect(t).toContain("Back to Sign In");
    expect(html).toMatch(/<form[^>]*>[\s\S]*<input[^>]*name="email"[\s\S]*<\/form>/);
    expect(html).toContain('href="/login?mode=code"');
    expect(html).toContain('href="/login"');
    expect((await generateMetadata()).title).toBe("Reset your password");
    expect((await generateMetadata()).robots).toBe(NO_INDEX);
  });

  it("an es-MX phone reads all of it in Spanish, with no English left", async () => {
    state.acceptLanguage = "es-MX,es;q=0.9";
    const html = await render();
    const t = text(html);
    expect(t).toContain("Restablece tu contraseña");
    expect(t).toContain("Escribe tu correo y te enviamos un enlace para crear una nueva contraseña.");
    expect(t).toContain("Correo");
    expect(html).toContain('placeholder="tu@empresa.com"');
    expect(t).toContain("Enviar Enlace");
    expect(t).toContain("¿No te llegó o el enlace no abre?");
    expect(t).toContain("Iniciar Sesión con un Código");
    expect(t).toContain("Volver a Iniciar Sesión");
    expect(t).not.toMatch(/Reset your|Send Reset|Back to Sign|Didn't get it|Enter your email/);
    expect((await generateMetadata()).title).toBe("Restablece tu contraseña");
  });

  it("the phone app gets the same page as a browser: the form is there, and none of the old claims", async () => {
    for (const acceptLanguage of ["en-US,en;q=0.9", "es-MX,es;q=0.9"]) {
      state.acceptLanguage = acceptLanguage;
      state.userAgent = "Mozilla/5.0";
      const web = await render();
      state.userAgent = SHELL;
      const shell = await render();
      expect(shell).toBe(web);
      expect(shell).toMatch(/<input[^>]*name="email"/);
      expect(shell).toMatch(/<button[^>]*type="submit"/);
      expect(shell).not.toMatch(OLD_CLAIMS);
    }
  });

  it("the tile is the app icon the login page draws, not a bolt", async () => {
    const html = await render();
    expect(html).toMatch(/<img[^>]*src="\/icon-192\.png"[^>]*alt="Contractor North"/);
    expect(html).not.toMatch(/lucide-zap|<svg/);
  });

  it("what the action answered is shown as it came, an error or a message", async () => {
    expect(text(await render({ error: "Too many emails asked for. Try again in an hour." }))).toContain("Too many emails asked for. Try again in an hour.");
    expect(text(await render({ message: "Si ese correo tiene cuenta, ya va en camino un enlace para restablecerla." }))).toContain("Si ese correo tiene cuenta, ya va en camino un enlace para restablecerla.");
  });
});

describe("the words", () => {
  it("every clickable on the page is Title Case in both languages; the sentences are not door labels", () => {
    for (const key of ["au_sendResetLink", "au_signInWithACode", "au_backToSignIn"]) {
      for (const lang of ["en", "es"] as const) {
        expect(titleCaseIn(dict(lang)[key], lang), `${lang}:${key} "${dict(lang)[key]}"`).toBe(true);
      }
    }
  });

  it("no sentence on the page names a length for the code or a door that is not there", () => {
    for (const lang of ["en", "es"] as const) {
      for (const key of ["au_resetHeading", "au_resetSub", "au_sendResetLink", "au_resetNoLink", "au_signInWithACode", "au_backToSignIn"]) {
        expect(dict(lang)[key], `${lang}:${key}`).toBeTruthy();
        expect(dict(lang)[key]).not.toMatch(OLD_CLAIMS);
      }
    }
  });
});
