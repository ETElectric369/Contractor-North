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

/** The eleven catalogs (lib/words). */
export const CATALOG_FLOOR = 11;
/** The keys across every catalog at cn-v1138 (1,562 when the floor was set); raise it as keys land. */
export const KEYS_FLOOR = 1562;

const ROOT = process.cwd();
const keysOf = (c: WordCatalog) => Object.keys(c.en);

describe("the catalogs", () => {
  it("there are eleven, each with a prefix of its own, and together they hold at least the floor's keys", () => {
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
    expect(dict("en").sh_spanishCovers).toMatch(/^Spanish covers the crew's side today/);
    expect(dict("es").sh_spanishCovers).toMatch(/^El español cubre el lado de la cuadrilla por ahora/);
    expect(dict("en")).not.toHaveProperty("s_language");
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
