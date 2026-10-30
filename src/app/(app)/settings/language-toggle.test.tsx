import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dict } from "@/lib/i18n";

/**
 * SETTINGS › YOU'S LANGUAGE DOOR SAYS WHAT SPANISH COVERS (cn-v1138; the new truth since cn-v1139):
 * under the English / Español pair, sh_spanishCovers in the language picked — the crew's side and
 * the office's map; the office pages' contents stay English. The same catalog line the account
 * menu's switcher reads (components/language-switcher.test.tsx), so the two doors say one thing.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ setLanguage: vi.fn() }));

import { LanguageToggle } from "./language-toggle";

const words = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
const buttons = (html: string) =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => words(m[1])).filter(Boolean);
const render = (current: string) => renderToStaticMarkup(createElement(LanguageToggle, { current }));

describe("LanguageToggle", () => {
  it("English: both languages as doors, and the catalog's honesty line under them, the office's map included", () => {
    const html = render("en");
    expect(buttons(html)).toEqual(["English", "Español"]);
    expect(words(html)).toContain(dict("en").sh_spanishCovers);
    expect(words(html)).toContain("the office's map today — the dock, the + menu, search, the account menu, the Settings sections and each page's title. The office pages' contents stay in English for now.");
    expect(words(html)).not.toContain("Office screens stay in English");
  });

  it("Spanish: the same doors, the line in Spanish", () => {
    const html = render("es");
    expect(buttons(html)).toEqual(["English", "Español"]);
    expect(words(html)).toContain(dict("es").sh_spanishCovers);
    expect(words(html)).toContain("el mapa de la oficina: la barra, el menú +, la búsqueda, el menú de la cuenta, las secciones de Ajustes y el título de cada página. Los contenidos de las páginas de oficina siguen en inglés por ahora.");
    expect(words(html)).not.toContain("Spanish covers");
  });

  it("an empty language reads as English", () => {
    expect(words(render(""))).toContain(dict("en").sh_spanishCovers);
  });
});
