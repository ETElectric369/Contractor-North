/**
 * A DOWNLOAD'S NAME, BOTH WAYS (the accountant download, 2026-09-27).
 *
 * The server says it in Content-Disposition twice: an ASCII `filename` every client can read, and
 * RFC 5987's `filename*` carrying the real name in UTF-8, so "Électricité Nord 2026 Q3.xlsx" keeps
 * its accents where the client understands it. The page's button reads it back the same way:
 * `filename*` first, then `filename`.
 */

/** Content-Disposition: attachment, with both names. Quotes, backslashes and anything outside
 *  printable ASCII never reach the quoted `filename`. */
export function contentDisposition(name: string): string {
  const ascii =
    String(name ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/["\\]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "download";
  const star = encodeURIComponent(String(name ?? "")).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
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
