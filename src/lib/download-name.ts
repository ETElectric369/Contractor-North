/**
 * A DOWNLOAD'S NAME, BOTH WAYS (the accountant download, 2026-09-27).
 *
 * The server says it in Content-Disposition twice: an ASCII `filename` every client can read, and
 * RFC 5987's `filename*` carrying the real name in UTF-8, so "Électricité Nord 2026 Q3.xlsx" keeps
 * its accents where the client understands it. The page's button reads it back the same way:
 * `filename*` first, then `filename`.
 */

/** Half of a character: a surrogate with no partner. encodeURIComponent throws on one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Content-Disposition: attachment, with both names. Quotes, backslashes and anything outside
 *  printable ASCII never reach the quoted `filename`. Half a character (a name cut through an emoji)
 *  is dropped, never a throw: a name must never be why a download fails. */
export function contentDisposition(name: string): string {
  const whole = String(name ?? "").replace(LONE_SURROGATE, "");
  const ascii =
    whole
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/["\\]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "download";
  let star: string;
  try {
    star = encodeURIComponent(whole).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return `attachment; filename="${ascii}"`;
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/** The file's name from a Content-Disposition header, or null. */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  const h = String(header ?? "");
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(h)?.[1];
  if (star) {
    try {
      const decoded = decodeURIComponent(star.trim());
      if (decoded) return decoded;
    } catch {
      // A broken encoding falls through to the plain name.
    }
  }
  return /filename\s*=\s*"([^"]+)"/i.exec(h)?.[1] ?? null;
}
