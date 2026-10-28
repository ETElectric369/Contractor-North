/**
 * THE LANGUAGE TYPE AND ITS THREE SMALL READERS, WITH NO DICTIONARY BEHIND THEM (cn-v1138).
 *
 * lib/i18n is the one dictionary: it statically imports every catalog (~218 KB of words) so that
 * translator() can answer any key. lib/utils only ever needed localeOf — the Intl tag for a
 * language — and utils rides ~150 client chunks, customer-facing pages among them, so for a while
 * every one of them carried the whole dictionary for a date format. This file is what those
 * importers need and nothing more: the Lang and Locale types, localeOf, asLang and langFromWord.
 * lib/i18n re-exports them, so every existing import of these names from the dictionary keeps
 * compiling; a module that needs no words imports from here (lib/locale.test.ts keeps this file
 * catalog-free and keeps lib/utils on it).
 */
export type Lang = "en" | "es";

/** The Intl locale a language renders dates and money in (lib/utils formatCurrency / formatDate). */
export type Locale = "en-US" | "es-US";

export function localeOf(lang: string | null | undefined): Locale {
  return lang === "es" ? "es-US" : "en-US";
}

/** A stored or typed value as a Lang: "es" is Spanish, anything else is English. */
export function asLang(x: unknown): Lang {
  return x === "es" ? "es" : "en";
}

/** A roster's language cell (crew import): "es", "español", "espanol" or "spanish", in any case,
 *  with spaces around, is Spanish; anything else (blank, "en", "english", a typo) is English. */
export function langFromWord(x: unknown): Lang {
  const w = String(x ?? "")
    .trim()
    .toLowerCase();
  return w === "es" || w === "español" || w === "espanol" || w === "spanish" ? "es" : "en";
}
