import type { Lang } from "@/lib/locale";

/**
 * THE AGENDA'S PURE LIBRARIES SPEAK THE READER'S LANGUAGE WITHOUT CARRYING THE DICTIONARY (the
 * agenda-in-Spanish wave). lib/schedule/*, lib/come-back-days, lib/schedule-options and the rest are
 * read by the schedule's client components AND by server actions, and some ride bundles that must not
 * ship every catalog (lib/catalog-free-libs.test.ts). So, the way lib/job-status jobStatusLabel does
 * it, a library keeps its English inline — the default, byte for byte what it always said — and takes
 * the caller's `lang` plus the caller's translator (`words`, lib/i18n translator(lang)) for the
 * Spanish, which lives in lib/words/agenda (ag_). No translator handed in, English: never a raw key.
 */
export type Words = (key: string) => string;

/** {name} slots filled, the way lib/i18n fillText does it (kept here so this file imports no catalog). */
export function fillSlots(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** The catalog's words for a Spanish reader whose caller handed its translator; otherwise `en`. */
export function say(lang: Lang | string | null | undefined, words: Words | undefined, key: string, en: string, vars?: Record<string, string | number>): string {
  if (lang !== "es" || !words) return en;
  return fillSlots(words(key), vars);
}

/** A Spanish clock's half of the day, one spelling everywhere: "a. m." / "p. m." (Intl's es-US gives
 *  "a.m." in one ICU and "a. m." in another; server and browser must print the same thing). */
export function esMeridiem(s: string): string {
  return s.replace(/\s*([ap])\.?\s?m\.?(?=$|[\s–-])/gi, (_m, x: string) => ` ${x.toLowerCase()}. m.`);
}

/** "10:00 AM" / "10:00 a. m." from an hour (0–23) and a minute. */
export function clock12(h: number, m: number, lang?: Lang | string | null): string {
  const base = `${h % 12 || 12}:${String(m).padStart(2, "0")}`;
  return lang === "es" ? `${base} ${h < 12 ? "a. m." : "p. m."}` : `${base} ${h < 12 ? "AM" : "PM"}`;
}
