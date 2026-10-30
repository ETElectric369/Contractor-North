import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict, mergeWords, translator } from "@/lib/i18n";
import type { WordCatalog } from "@/lib/words/types";

/**
 * EVERY WORD IN BOTH LANGUAGES (cn-v1138). The runtime lays Spanish over English so a missing key
 * never shows a person a raw key — which is exactly why the gap has to be refused HERE, before it
 * ships: a Spanish-speaking tech reading one English sentence on a Spanish screen is the leak the
 * wave exists to close. For every catalog: every key under its prefix, every English key in the
 * Spanish, a Spanish that differs from the English unless the key is declared the same in both (a
 * brand word, OK, a job number), no key in two catalogs, every named screen on disk. The floors
 * keep the scan honest.
 */

/** The thirteen catalogs (lib/words; nv_ the office's map since cn-v1139, us_ the usage meter since cn-v1140). */
export const CATALOG_FLOOR = 13;
/** The keys across every catalog at cn-v1140 (1,729 with the fixer's four — the shell's used-up line, the estimator's lighter line, the notice button, Ask The Owner — less the owner slot word; 1,726 with the plan card's words; 1,711 when the floor was set; 1,694 at cn-v1139; 1,562 at cn-v1138); raise it as keys land. */
export const KEYS_FLOOR = 1729;

/**
 * THE KEY FAMILIES THAT ARE CLICKABLES (Erik's law: Title Case in BOTH languages, every word
 * capitalized — "Lista De Precios", "Cuentas Y Órdenes"). A sentence under one of these prefixes
 * (a help row's line, ending in a period) keeps sentence case and is not judged. The page titles
 * (nv_page_) are judged in SPANISH only: their English is byte for byte what each page says today,
 * and four of them ("Tax report", "Activity audit", "Employee documents", "Employee handbook") are
 * not Title Case — the pages' own words, not the catalog's to change.
 */
const TITLE_CASE_FAMILIES = ["sh_dock_", "sh_help_", "nv_add_", "nv_set_", "nv_role_", "nv_sched_", "us_door_"];
const TITLE_CASE_ES_ONLY = ["nv_page_"];
/** Every word begins with a capital, a digit or a symbol; a {slot} is a hole, not a word; "/", "&", "+" and "·" pass. */
const titleCase = (s: string) =>
  s
    .replace(/\{\w+\}/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => /^[\p{Lu}\p{N}&\/+·(]/u.test(w));

const ROOT = process.cwd();
const keysOf = (c: WordCatalog) => Object.keys(c.en);

describe("the catalogs", () => {
  it("there are thirteen, each with a prefix of its own, and together they hold at least the floor's keys", () => {
    expect(CATALOGS.length).toBeGreaterThanOrEqual(CATALOG_FLOOR);
    const prefixes = CATALOGS.map((c) => c.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const p of prefixes) expect(p, p).toMatch(/^[a-z]{2}_$/);
    expect(CATALOGS.flatMap(keysOf).length).toBeGreaterThanOrEqual(KEYS_FLOOR);
  });

  it("every key starts with its catalog's prefix, in en and in es", () => {
    const strays: string[] = [];
    for (const c of CATALOGS) {
      for (const k of [...Object.keys(c.en), ...Object.keys(c.es)]) if (!k.startsWith(c.prefix)) strays.push(`${c.prefix} ${k}`);
    }
    expect(strays).toEqual([]);
  });

  it("every English key exists in Spanish, and no Spanish key is without its English", () => {
    const missing: string[] = [];
    for (const c of CATALOGS) {
      for (const k of Object.keys(c.en)) if (typeof c.es[k] !== "string" || !c.es[k].trim()) missing.push(`${k} has no Spanish`);
      for (const k of Object.keys(c.es)) if (typeof c.en[k] !== "string" || !c.en[k].trim()) missing.push(`${k} has no English`);
    }
    expect(missing).toEqual([]);
  });

  it("the Spanish differs from the English unless the key is declared the same in both, and every such key exists", () => {
    const same: string[] = [];
    const stale: string[] = [];
    for (const c of CATALOGS) {
      for (const k of Object.keys(c.en)) if (c.es[k] === c.en[k] && !c.sameInBoth.includes(k)) same.push(k);
      for (const k of c.sameInBoth) if (!(k in c.en)) stale.push(k);
    }
    expect(same, "these keys read the same in both languages; translate them or list them in sameInBoth").toEqual([]);
    expect(stale, "sameInBoth names a key that is not in the catalog").toEqual([]);
  });

  it("no key is defined in two catalogs", () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const c of CATALOGS) {
      for (const k of keysOf(c)) {
        if (seen.has(k)) twice.push(`${k} (${seen.get(k)} and ${c.prefix})`);
        seen.set(k, c.prefix);
      }
    }
    expect(twice).toEqual([]);
  });

  it("every screen a catalog names is on disk, under src, as a .ts or .tsx file", () => {
    for (const c of CATALOGS) {
      for (const f of c.files) {
        expect(f, f).toMatch(/^src\/.+\.tsx?$/);
        expect(existsSync(join(ROOT, f)), `${c.prefix} names ${f}, which is not there`).toBe(true);
      }
    }
  });

  it("the Time Clock's and the shell's words are in: the two that were in lib/i18n.ts before the catalogs", () => {
    expect(dict("en").tc_clockIn).toBe("Clock In");
    expect(dict("es").tc_clockIn).toBe("Marcar Entrada");
    expect(dict("en").sh_language).toBe("Language");
    expect(dict("es").sh_language).toBe("Idioma");
    // The honesty line (cn-v1139): the crew's side and the office's MAP, named door by door — the dock, the + menu,
    // search, the account menu, the Settings sections, each page's title — never "every menu" (a page's own ⋯ menu
    // and tab strip stay English with its contents); the office pages' contents stay English.
    expect(dict("en").sh_spanishCovers).toMatch(/^Spanish covers the crew's side and the office's map today/);
    expect(dict("en").sh_spanishCovers).toContain("the dock, the + menu, search, the account menu, the Settings sections and each page's title");
    expect(dict("en").sh_spanishCovers).not.toContain("every menu");
    expect(dict("en").sh_spanishCovers).toMatch(/The office pages' contents stay in English for now\.$/);
    expect(dict("es").sh_spanishCovers).toMatch(/^El español cubre hoy el lado de la cuadrilla y el mapa de la oficina/);
    expect(dict("es").sh_spanishCovers).toContain("la barra, el menú +, la búsqueda, el menú de la cuenta, las secciones de Ajustes y el título de cada página");
    expect(dict("es").sh_spanishCovers).not.toContain("cada menú");
    expect(dict("es").sh_spanishCovers).toMatch(/siguen en inglés por ahora\.$/);
    expect(dict("en")).not.toHaveProperty("s_language");
  });

  it("the office's map is in (cn-v1139): the nav catalog, the dock's office rows, the help rows", () => {
    expect(CATALOGS.some((c) => c.prefix === "nv_")).toBe(true);
    expect(dict("es")["sh_dock_ma-payroll"]).toBe("Nómina");
    expect(dict("es").sh_help_startHere).toBe("Empieza Aquí");
    expect(dict("en").nv_page_leads).toBe("Leads");
    expect(dict("es").nv_page_leads).toBe("Prospectos");
  });

  it("the usage meter is in (cn-v1140): Usage = Uso, the two doors Title Case, no dollar and no estimate as a unit anywhere in it", () => {
    const us = CATALOGS.find((c) => c.prefix === "us_")!;
    expect(us).toBeTruthy();
    expect(us.files).toEqual(["src/components/usage-ring.tsx", "src/lib/usage-words.ts", "src/app/(app)/settings/plan-card.tsx"]);
    expect(dict("en").us_usage).toBe("Usage");
    expect(dict("es").us_usage).toBe("Uso");
    expect(dict("en").us_door_addUsage).toBe("Add Usage");
    expect(dict("es").us_door_addUsage).toBe("Agregar Uso");
    expect(dict("en").us_door_upgrade).toBe("Upgrade");
    expect(dict("es").us_door_upgrade).toBe("Mejorar Plan");
    for (const lang of ["en", "es"] as const) {
      for (const [k, v] of Object.entries(us[lang])) {
        expect(v, `${lang}:${k}`).not.toMatch(/\$|\d+ (full )?(estimates|presupuestos)|token|crédito|credit/i);
      }
    }
  });

  it("every clickable or title key family is Title Case in both languages — every word, De / Y / Del included", () => {
    const offenders: string[] = [];
    let judged = 0;
    for (const c of CATALOGS) {
      for (const k of keysOf(c)) {
        const both = TITLE_CASE_FAMILIES.some((p) => k.startsWith(p));
        const esOnly = TITLE_CASE_ES_ONLY.some((p) => k.startsWith(p));
        if (!both && !esOnly) continue;
        for (const lang of both ? (["en", "es"] as const) : (["es"] as const)) {
          const text = c[lang][k];
          if (/[.]$/.test(text)) continue; // a sentence beside the door, not its words
          judged++;
          if (!titleCase(text)) offenders.push(`${lang}:${k} "${text}"`);
        }
      }
    }
    expect(judged).toBeGreaterThanOrEqual(200);
    expect(offenders).toEqual([]);
    // The rule itself: an article or a preposition is a word and starts with a capital.
    expect(titleCase("Lista De Precios")).toBe(true);
    expect(titleCase("Cuentas Y Órdenes")).toBe(true);
    expect(titleCase("Finish Setting Up · {n} Left")).toBe(true);
    expect(titleCase("Lista de Precios")).toBe(false);
    expect(titleCase("Cuentas y Órdenes")).toBe(false);
  });
});

describe("the runtime fallback", () => {
  it("dict(\"es\") holds every English key, so a key missing from a catalog's Spanish still reads in English", () => {
    const en = dict("en");
    const es = dict("es");
    for (const k of Object.keys(en)) expect(typeof es[k], k).toBe("string");
    // The rule itself, on a catalog of this test's own: the English shows through the gap.
    const merged = mergeWords([{ prefix: "zz_", files: [], sameInBoth: [], en: { zz_a: "Only English", zz_b: "Both" }, es: { zz_b: "Ambos" } }]);
    expect(merged.es).toEqual({ zz_a: "Only English", zz_b: "Ambos" });
    expect(merged.en).toEqual({ zz_a: "Only English", zz_b: "Both" });
    // A key no catalog holds comes back as itself (the translator never answers undefined).
    expect(translator("es")("zz_nothing")).toBe("zz_nothing");
    expect(translator("en")("zz_nothing")).toBe("zz_nothing");
    // Anything that is not "es" is English.
    expect(dict(null)).toBe(dict("en"));
    expect(dict("fr")).toBe(dict("en"));
  });
});
