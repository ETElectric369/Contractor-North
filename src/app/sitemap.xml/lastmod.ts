/**
 * Pure <lastmod> helpers for the per-host sitemap. Dates render as W3C YYYY-MM-DD (UTC) — day
 * precision is all crawlers act on, and it keeps the XML free of timezone noise. An entry with no
 * known timestamp simply omits <lastmod> (still valid sitemap XML), never emits a fake date.
 */

/** A row's updated_at → a sitemap date, or null when missing/unparseable. */
export function lastmodDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Newest timestamp of a set — the homepage/index entries, which change when ANY row does. */
export function newestLastmod(isos: (string | null | undefined)[]): string | null {
  let best: number | null = null;
  for (const iso of isos) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString().slice(0, 10);
}

/** One <url> element, <lastmod> included only when known. */
export function urlEntry(loc: string, lastmod?: string | null): string {
  return lastmod ? `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>` : `  <url><loc>${loc}</loc></url>`;
}
