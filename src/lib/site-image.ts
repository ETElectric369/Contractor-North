/**
 * Supabase Storage image transforms (Pro plan) — the public-site image pipeline.
 *
 * Site photos are stored as full-camera originals (multi-MB); serving them raw is the single
 * biggest page-weight problem on the org sites (Tahoe Deck's homepage shipped ~50MB). Rewriting
 * a public object URL onto the render/image endpoint makes Supabase serve a resized, recompressed
 * (and WebP-negotiated) variant instead — verified ~174KB → ~34KB at width=640.
 *
 * Non-Supabase URLs (external CDNs, relative paths, data:) pass through untouched, so every call
 * site can wrap unconditionally. SVGs aren't sent through the transformer (it rasterizes/errors);
 * they pass through too.
 */
const OBJECT_PUBLIC = "/storage/v1/object/public/";
const RENDER_PUBLIC = "/storage/v1/render/image/public/";

function transformable(url: string): boolean {
  return url.includes(OBJECT_PUBLIC) && !/\.svg(\?|$)/i.test(url);
}

/** A width-bounded, recompressed variant of a Supabase-hosted image (or the URL unchanged).
 *  resize=contain is REQUIRED: with width alone the transformer keeps the original height and
 *  squashes the width (2500×1875 → 640×1875, verified live) — contain preserves aspect. */
export function sizedImage(url: string | null | undefined, width: number, quality = 75): string {
  const u = String(url ?? "");
  if (!transformable(u)) return u;
  const sep = u.includes("?") ? "&" : "?";
  return `${u.replace(OBJECT_PUBLIC, RENDER_PUBLIC)}${sep}width=${width}&quality=${quality}&resize=contain`;
}

/** srcSet across standard widths for responsive imgs; undefined when the URL can't be transformed
 *  (so the attribute is simply omitted and the plain src serves). */
export function imageSrcSet(url: string | null | undefined, widths: number[], quality = 75): string | undefined {
  const u = String(url ?? "");
  if (!transformable(u)) return undefined;
  return widths.map((w) => `${sizedImage(u, w, quality)} ${w}w`).join(", ");
}

/** Social-preview variant (og:image / twitter:image) — scrapers want ~1200px, not an 8MB original. */
export function socialImage(url: string | null | undefined): string | null {
  const u = String(url ?? "");
  return u ? sizedImage(u, 1200) : null;
}

/**
 * Rewrite <img> tags inside stored article HTML: Supabase-hosted srcs get the width-bounded
 * variant, and lazy/async hints are added when absent. Migrated Squarespace posts carry
 * full-camera inline images in body_html — this is where most of an article page's weight lives.
 * Runs AFTER sanitizeHtml on the read path (never on the stored value), so it only ever sees
 * clean markup and the DB keeps the original URLs.
 */
export function optimizeBodyImages(html: string): string {
  return String(html ?? "").replace(/<img\b[^>]*>/gi, (tag) => {
    let out = tag.replace(/\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i, (_m, _q, d, s) => {
      const src = d ?? s ?? "";
      return `src="${sizedImage(src, 1280)}"`;
    });
    if (!/\bloading\s*=/i.test(out)) out = out.replace(/^<img\b/i, '<img loading="lazy"');
    if (!/\bdecoding\s*=/i.test(out)) out = out.replace(/^<img\b/i, '<img decoding="async"');
    return out;
  });
}
