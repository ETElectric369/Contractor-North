/**
 * ONE CATALOG PER SIDE OF THE APP (cn-v1138). Every word a Spanish-speaking tech reads lives in a
 * catalog: English beside Spanish, under one prefix, with the screens it covers named so the leak
 * test (tests/tech-words-in-the-catalog.test.ts) can read those screens and refuse a literal that
 * is not in here. lib/i18n.ts merges every catalog into the one dictionary the app reads.
 *
 *   prefix      every key in this catalog starts with it ("tc_", "md_", …); no key lives in two.
 *   files       repo-relative paths of the screens whose words this catalog holds; the leak test
 *               scans them. Empty until a screen is moved over.
 *   sameInBoth  keys whose Spanish may equal the English on purpose: a brand word (North, Nort),
 *               "OK", a job number. Every other key must differ (tests/words-parity.test.ts).
 *   en / es     the words. A key in en must be in es; the runtime still falls back to English for
 *               a missing one so a person never sees a raw key.
 */
export type WordCatalog = {
  prefix: string;
  files: readonly string[];
  sameInBoth: readonly string[];
  en: Record<string, string>;
  es: Record<string, string>;
};
