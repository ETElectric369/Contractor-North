import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asLang, langFromWord, localeOf } from "./locale";
import * as i18n from "./i18n";

/**
 * THE LANGUAGE TYPE WITHOUT THE DICTIONARY (lib/locale, cn-v1138). lib/utils rides ~150 client
 * chunks, customer-facing pages among them, and used to import localeOf from lib/i18n, which
 * statically imports every catalog (~218 KB of a tech's words) — so every one of those chunks
 * carried the whole dictionary for a date format. lib/locale holds Lang, Locale, localeOf, asLang
 * and langFromWord with no catalog behind them; lib/i18n re-exports them so nothing else moves.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("lib/locale carries no dictionary", () => {
  it("imports nothing at all — not lib/words, not lib/i18n (source pin)", () => {
    const s = src("src/lib/locale.ts");
    expect(s).not.toContain("@/lib/words");
    expect(s).not.toContain("@/lib/i18n");
    expect(s).not.toMatch(/^\s*(import|export)\b.*\bfrom\b/m);
    expect(s).not.toMatch(/require\(/);
  });

  it("lib/utils imports localeOf from lib/locale, never from lib/i18n (source pin)", () => {
    const s = src("src/lib/utils.ts");
    expect(s).toContain('import { localeOf } from "@/lib/locale";');
    expect(s).not.toContain("@/lib/i18n");
  });

  it("the other word-free importers are on lib/locale too (source pins)", () => {
    for (const f of [
      "src/lib/lang-of.ts",
      "src/lib/notifications.ts",
      "src/lib/tts.ts",
      "src/lib/voice-stream.ts",
      "src/lib/request-lang.ts",
      "src/components/lang-provider.tsx",
      "src/lib/actions/types.ts",
      "src/lib/actions/context.ts",
      "src/app/api/tts/route.ts",
      "src/app/api/transcribe/lang.ts",
    ]) {
      expect(src(f), f).toContain('from "@/lib/locale"');
      expect(src(f), f).not.toContain('from "@/lib/i18n"');
    }
  });

  it("lib/i18n re-exports the same functions, so every existing import keeps compiling and answers the same", () => {
    expect(i18n.localeOf).toBe(localeOf);
    expect(i18n.asLang).toBe(asLang);
    expect(i18n.langFromWord).toBe(langFromWord);
  });
});

describe("the three readers", () => {
  it("localeOf: es-US for Spanish, en-US for anything else", () => {
    expect(localeOf("es")).toBe("es-US");
    expect(localeOf("en")).toBe("en-US");
    expect(localeOf(null)).toBe("en-US");
    expect(localeOf(undefined)).toBe("en-US");
    expect(localeOf("fr")).toBe("en-US");
  });

  it("asLang: 'es' is Spanish, anything else is English", () => {
    expect(asLang("es")).toBe("es");
    expect(asLang("en")).toBe("en");
    expect(asLang("ES")).toBe("en");
    expect(asLang(null)).toBe("en");
    expect(asLang(7)).toBe("en");
  });

  it("langFromWord: a roster's cell in any case, with spaces, is Spanish for es / español / espanol / spanish; a typo or a blank is English", () => {
    for (const w of ["es", " ES ", "Español", "espanol", "SPANISH", "spanish "]) expect(langFromWord(w), w).toBe("es");
    for (const w of ["", "en", "English", "klingon", null, undefined, 3]) expect(langFromWord(w), String(w)).toBe("en");
  });
});
