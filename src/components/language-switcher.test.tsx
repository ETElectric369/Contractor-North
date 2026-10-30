import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dict } from "@/lib/i18n";

/**
 * THE ACCOUNT MENU'S LANGUAGE ROW SAYS WHAT SPANISH COVERS (cn-v1138; the new truth since
 * cn-v1139): under the EN/ES button, sh_spanishCovers in the language picked — the crew's side and
 * the office's map — the dock, the + menu, search, the account menu, the Settings sections and each page's title; the office pages' contents stay
 * English. The line is the catalog's, never a literal here, so the two toggles can't drift.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/settings/actions", () => ({ setLanguage: vi.fn() }));

import { LanguageSwitcher } from "./language-switcher";

const words = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
const render = (current?: string) => renderToStaticMarkup(createElement(LanguageSwitcher, { current }));

describe("LanguageSwitcher", () => {
  it("English: the button reads EN and the line under it is the catalog's honesty line, the office's map included", () => {
    const html = render("en");
    expect(words(html)).toContain("EN");
    expect(words(html)).toContain(dict("en").sh_spanishCovers);
    expect(words(html)).toContain("Spanish covers the crew's side and the office's map today — the dock, the + menu, search, the account menu, the Settings sections and each page's title. The office pages' contents stay in English for now.");
    expect(words(html)).not.toContain("Office screens stay in English");
    // The title invites the reader to the other language, in that language.
    expect(html).toContain('title="Cambiar a Español"');
  });

  it("Spanish: ES, and the same line in Spanish", () => {
    const html = render("es");
    expect(words(html)).toContain("ES");
    expect(words(html)).toContain(dict("es").sh_spanishCovers);
    expect(words(html)).toContain("El español cubre hoy el lado de la cuadrilla y el mapa de la oficina: la barra, el menú +, la búsqueda, el menú de la cuenta, las secciones de Ajustes y el título de cada página. Los contenidos de las páginas de oficina siguen en inglés por ahora.");
    expect(words(html)).not.toContain("Spanish covers");
    expect(html).toContain('title="Switch to English"');
  });

  it("no language on the profile reads as English", () => {
    expect(words(render(undefined))).toContain(dict("en").sh_spanishCovers);
  });
});
