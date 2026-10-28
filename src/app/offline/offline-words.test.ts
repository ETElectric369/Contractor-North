import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE OFFLINE PAGE IN THE PHONE'S LANGUAGE (cn-v1138, builder T2). The PWA's cached fallback has no
 * session and no server, so it cannot read profiles.language: it follows navigator.language, paints
 * English first (the cached HTML and the hydrated page agree) and switches on the phone's own answer.
 * The document title stays the vendor's name.
 */
import { OfflineWords, phoneLang } from "./offline-words";
import { dict } from "@/lib/i18n";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const en = dict("en");
const es = dict("es");

describe("phoneLang: the phone's language, Spanish or English", () => {
  it("any Spanish locale is Spanish; anything else, or nothing, is English", () => {
    for (const l of ["es", "es-MX", "es-US", "ES-419", "es-ES"]) expect(phoneLang(l)).toBe("es");
    for (const l of ["en", "en-US", "fr-CA", "", null, undefined, "pt-BR"]) expect(phoneLang(l)).toBe("en");
  });
});

describe("OfflineWords", () => {
  it("paints English first (no effect runs on the server), with the Title Case door", () => {
    const html = renderToStaticMarkup(createElement(OfflineWords));
    expect(html).toContain("<h1 class=\"text-xl font-bold text-slate-900\">You&#x27;re offline</h1>");
    expect(html).toContain(en.cs_offlineBody.replace(/'/g, "&#x27;"));
    expect(html).toMatch(/<a href="\/planner"[^>]*>Try Again<\/a>/);
  });
  it("the Spanish words exist for the same keys, and the door is Title Case there too", () => {
    expect(es.cs_youreOffline).toBe("Estás sin conexión");
    expect(es.cs_tryAgain).toBe("Intentar De Nuevo");
    expect(es.cs_offlineBody).not.toBe(en.cs_offlineBody);
  });
  it("the page mounts the words and keeps the vendor's title", () => {
    const page = read("src/app/offline/page.tsx");
    expect(page).toContain('import { OfflineWords } from "./offline-words";');
    expect(page).toContain("<OfflineWords />");
    expect(page).toContain('export const metadata = { title: "Offline · Contractor North", robots: NO_INDEX };');
    expect(page).not.toContain("You&apos;re offline");
    const words = read("src/app/offline/offline-words.tsx");
    expect(words).toContain("setLang(phoneLang(navigator.language));");
    expect(words).toContain('useState<Lang>("en")');
  });
});
