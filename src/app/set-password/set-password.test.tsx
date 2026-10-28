import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SET A PASSWORD SPEAKS THE PERSON'S LANGUAGE (set-password/*, cn-v1138). A session exists here (the
 * one-time link, or the shell's must-reset bounce, made it), so the profile is the one source of
 * truth: the page asks callerLang once (shared with its title), mounts a LangProvider, the form
 * reads useLang(), and the action's refusals come back through callerLang. English reads what it
 * read before.
 */
const state = vi.hoisted(() => ({ user: { id: "larkspur" } as { id: string } | null, language: "es" as string | null, updateError: null as null | { message: string } }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
      updateUser: async () => ({ error: state.updateError }),
    },
    from: () => ({
      select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { language: state.language }, error: null }) }) }) }),
      update: () => ({ eq: () => ({ select: async () => ({ data: [{ id: "larkspur" }], error: null }) }) }),
    }),
  })),
}));

import SetPasswordPage, { generateMetadata } from "./page";
import { SetPasswordForm } from "./set-password-form";
import { updateMyPassword } from "./actions";
import { LangProvider } from "@/components/lang-provider";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

beforeEach(() => {
  state.user = { id: "larkspur" };
  state.language = "es";
  state.updateError = null;
});

describe("the page", () => {
  it("a Spanish-speaking person reads the Spanish heading, sentence, form and tab title; English reads what it read before", async () => {
    const es = renderToStaticMarkup(await SetPasswordPage());
    expect(text(es)).toContain("Elige tu contraseña");
    expect(text(es)).toContain("Elige tu contraseña. La usarás de ahora en adelante.");
    expect(text(es)).toContain("Contraseña nueva");
    expect(text(es)).toContain("Confirma la contraseña");
    expect(text(es)).toContain("Guardar Contraseña Y Continuar");
    expect(es).toContain('placeholder="Al menos 8 caracteres"');
    expect((await generateMetadata()).title).toBe("Crea tu contraseña");
    state.language = null;
    const en = renderToStaticMarkup(await SetPasswordPage());
    expect(text(en)).toContain("Choose your password");
    expect(text(en)).toContain("Choose your password. You'll use it from now on.");
    expect(text(en)).toContain("Save Password & Continue");
    expect((await generateMetadata()).title).toBe("Set your password");
  });

  it("nobody signed in: the login page, as before", async () => {
    state.user = null;
    await expect(SetPasswordPage()).rejects.toThrow("REDIRECT /login");
  });

  it("the form outside any provider is English", () => {
    const html = renderToStaticMarkup(createElement(SetPasswordForm));
    expect(text(html)).toContain("New password");
    expect(renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: createElement(SetPasswordForm) }))).toContain("Contraseña nueva");
  });
});

describe("the action's refusals", () => {
  it("come back in the caller's language: too short in Spanish for an es person, in English for an en one; nobody signed in is English (no profile to read)", async () => {
    expect(await updateMyPassword("short")).toEqual({ ok: false, error: "La contraseña debe tener al menos 8 caracteres." });
    state.language = "en";
    expect(await updateMyPassword("short")).toEqual({ ok: false, error: "Password must be at least 8 characters." });
    expect(await updateMyPassword("long enough 1")).toEqual({ ok: true });
    state.user = null;
    expect(await updateMyPassword("long enough 1")).toEqual({ ok: false, error: "Not signed in." });
  });
});
