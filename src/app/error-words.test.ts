import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dict } from "@/lib/i18n";
import { ROOT_ERROR_KEYS, rootErrorWords } from "./error-words";

/**
 * THE ROOT ERROR BOUNDARY'S WORDS ARE THE SHELL CATALOG'S, COPIED BY HAND AND PINNED (cn-v1138).
 * src/app/error.tsx rides every customer page's bundle, so it reads a local seven-word map instead
 * of lib/i18n (which carries every catalog). This test keeps the copy honest: each word equals the
 * catalog's entry in both languages, and neither file imports the dictionary.
 */
describe("the root error boundary's words", () => {
  it.each(["en", "es"] as const)("%s: every local word equals the shell catalog's entry", (lang) => {
    const d = dict(lang) as Record<string, string>;
    const w = rootErrorWords(lang) as unknown as Record<string, string>;
    for (const [field, key] of Object.entries(ROOT_ERROR_KEYS)) expect(w[field], `${lang} ${field} ← ${key}`).toBe(d[key]);
    expect(Object.keys(w).sort()).toEqual(Object.keys(ROOT_ERROR_KEYS).sort());
  });

  it("neither the boundary nor its words import lib/i18n or lib/words", () => {
    for (const f of ["src/app/error.tsx", "src/app/error-words.ts"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/from\s+["'](@\/lib\/i18n|@\/lib\/words|\.\/i18n)/);
    }
    expect(readFileSync("src/app/error.tsx", "utf8")).toContain('from "./error-words"');
  });
});
