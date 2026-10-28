import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SETTINGS › YOU IN THE PERSON'S LANGUAGE (cn-v1138): how Nort talks to you, Nort speaks first,
 * Face ID and the photo. English is what it was, byte for byte — except the two register doors,
 * which read "Talk how I talk" / "Keep it clean" and are Title Case now (Erik's law). Every door is
 * Title Case in both languages.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./nort-tone-actions", () => ({ saveNortTone: vi.fn(), saveNortGreeting: vi.fn() }));
vi.mock("./passkey-actions", () => ({ startPasskeyRegistration: vi.fn(), finishPasskeyRegistration: vi.fn(), removePasskey: vi.fn() }));
vi.mock("./actions", () => ({ setAvatarUrl: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/image-prep", () => ({ prepareImageForUpload: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn() }));

import { NortTone } from "./nort-tone";
import { NortGreeting } from "./nort-greeting";
import { PasskeyManager } from "./passkey-manager";
import { AvatarUpload } from "./avatar-upload";
import { LangProvider } from "@/components/lang-provider";
import type { Lang } from "@/lib/i18n";

const r = (lang: Lang, el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LangProvider, { lang, children: el }));
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();
/** The visible words of every button, in order. */
const buttons = (html: string) =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => words(m[1])).filter(Boolean);
const titleCase = (s: string) => s.split(/[\s/]+/).every((w) => /^[\p{Lu}\p{N}]/u.test(w));

describe("How Nort talks to you", () => {
  const tone = createElement(NortTone, { humor: 50, register: "match", notes: "" });

  it("English: the dial, the two register doors (Title Case now), the standing orders and the limits", () => {
    const html = r("en", tone);
    expect(words(html)).toContain("Humour — Like a person you'd work with");
    expect(buttons(html)).toEqual(["Talk How I Talk", "Keep It Clean", "Save"]);
    expect(html).toContain('aria-label="How funny Nort is"');
    expect(words(html)).toContain("Standing orders — things you’ve told Nort to always do");
    expect(words(html)).toContain("None of this reaches your customers.");
    expect(html).toContain("how Nort talks to <em>you</em> and your crew");
  });

  it("Spanish: the same screen in the tech's words, the doors Title Case", () => {
    const html = r("es", tone);
    expect(words(html)).toContain("Humor — Like a person you'd work with"); // the dial's own words are Nort's (lib/nort/tone)
    expect(buttons(html)).toEqual(["Habla Como Yo Hablo", "Sin Groserías", "Guardar"]);
    for (const b of buttons(html)) expect(titleCase(b), b).toBe(true);
    expect(html).toContain('aria-label="Qué tan gracioso es Nort"');
    expect(words(html)).toContain("Órdenes permanentes: lo que le has dicho a Nort que haga siempre");
    expect(words(html)).toContain("Nada de esto llega a tus clientes.");
    expect(html).toContain("cómo Nort te habla a <em>ti</em> y a tu cuadrilla");
    expect(html).toContain("placeholder=\"Respuestas cortas.");
    for (const en of ["Talk How I Talk", "Keep It Clean", "Standing orders", "your customers"]) expect(words(html)).not.toContain(en);
  });
});

describe("Nort speaks first", () => {
  const greeting = createElement(NortGreeting, { greets: true, name: "" });
  it("English as before; Spanish in the tech's words", () => {
    const en = r("en", greeting);
    expect(words(en)).toContain("Nort speaks first When you tap Talk To Nort, he says hello the moment the mic is live");
    expect(words(en)).toContain("Nort greets you as");
    expect(en).toContain('placeholder="Your first name"');
    const es = r("es", greeting);
    expect(words(es)).toContain("Nort habla primero Cuando tocas Hablar Con Nort, él saluda en cuanto el micrófono está listo");
    expect(words(es)).toContain("Nort te saluda como");
    expect(es).toContain('placeholder="Tu nombre"');
    expect(buttons(es)).toEqual(["Guardar"]);
    expect(words(es)).not.toContain("speaks first");
  });
});

describe("Sign-in & security", () => {
  const one = [{ id: "p1", label: null, created_at: "2026-10-01T12:00:00Z", last_used_at: null }];
  it("English as before; Spanish in the tech's words, the doors Title Case", () => {
    expect(buttons(r("en", createElement(PasskeyManager, { passkeys: [] })))).toEqual(["Set Up Face ID / Passkey"]);
    const en = r("en", createElement(PasskeyManager, { passkeys: one }));
    expect(words(en)).toContain("Enroll Face ID / Touch ID (a passkey).");
    // The emphasis survives the catalog (cn-v1138, fillNodes): the phrase is a bold span in both languages.
    expect(en).toContain('any <span class="font-medium">money action the assistant takes</span> requires a tap');
    expect(words(en)).toContain("Passkey · added");
    expect(en).toContain('aria-label="Remove passkey"');
    expect(buttons(en)).toEqual(["Add Another Passkey"]);
    expect(buttons(r("es", createElement(PasskeyManager, { passkeys: [] })))).toEqual(["Configurar Face ID / Llave De Acceso"]);
    const es = r("es", createElement(PasskeyManager, { passkeys: one }));
    expect(words(es)).toContain("Registra Face ID / Touch ID (una llave de acceso).");
    expect(es).toContain('cualquier <span class="font-medium">acción con dinero que haga el asistente</span> necesita un toque');
    expect(words(es)).toContain("Llave de acceso · agregada");
    expect(es).toContain('aria-label="Quitar llave de acceso"');
    expect(buttons(es)).toEqual(["Agregar Otra Llave De Acceso"]);
    for (const b of buttons(es)) expect(titleCase(b), b).toBe(true);
  });
});

describe("Your photo", () => {
  it("English as before; Spanish in the tech's words, the doors Title Case", () => {
    const none = { userId: "u1", orgId: "o1", name: "Pat Larkspur", current: null };
    expect(buttons(r("en", createElement(AvatarUpload, none)))).toEqual(["PL", "Add Photo"]);
    expect(r("en", createElement(AvatarUpload, none))).toContain('title="Change photo"');
    const withOne = r("en", createElement(AvatarUpload, { ...none, current: "https://example.test/a.jpg" }));
    expect(buttons(withOne)).toEqual(["Change Photo", "Remove"]);
    const es = r("es", createElement(AvatarUpload, { ...none, current: "https://example.test/a.jpg" }));
    expect(buttons(es)).toEqual(["Cambiar Foto", "Quitar"]);
    expect(es).toContain('title="Cambiar foto"');
    expect(buttons(r("es", createElement(AvatarUpload, none)))).toEqual(["PL", "Agregar Foto"]);
    for (const b of buttons(es)) expect(titleCase(b), b).toBe(true);
  });
});
