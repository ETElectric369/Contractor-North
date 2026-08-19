/**
 * A FILENAME AN HTTP HEADER CAN ACTUALLY CARRY.
 *
 * Erik, 8/18: "i tried to create an invoice today for badger lane and it failed." The invoice was
 * fine and the PDF rendered and stored fine — the RESPONSE died:
 *
 *   Cannot convert argument to a ByteString because the character at index 34
 *   has a value of 8212 which is greater than 255.
 *
 * 8212 is the em-dash in `Invoice INV-060 — 10410 Badger Lane.pdf`. Header values are
 * ByteStrings: every code point must fit in a byte, so ONE typographic character in a job name
 * threw at the moment of sending and the whole preview 500'd. The old sanitizer stripped quotes
 * and newlines (header injection) and never considered characters that simply cannot be sent —
 * and because a job name is free text, this fires on the ordinary case: any invoice attached to
 * a job. It only looked rare because the invoices tested before it had no job.
 *
 * Both halves are needed, and that is the point of RFC 5987:
 *   · `filename="…"` — ASCII only, the fallback every client understands.
 *   · `filename*=UTF-8''…` — percent-encoded, what modern browsers actually use, so the customer
 *     still gets "Invoice INV-060 — 10410 Badger Lane.pdf" with its real punctuation.
 */

/** ASCII-only, header-safe, never empty — the quoted fallback. */
export function asciiFilename(name: string): string {
  const ascii = String(name ?? "")
    // Typographic punctuation a person's document title genuinely contains, mapped rather than
    // dropped so the fallback still reads like the name they expect.
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, "")
    .replace(/[\u2026]/g, "...")
    .replace(/[^\x20-\x7E]/g, "") // anything else non-ASCII simply cannot ride in the header
    .replace(/[\r\n"\\]/g, "") // header-injection primitives (unchanged from before)
    .replace(/\s+/g, " ")
    .trim();
  return ascii || "document.pdf";
}

/** The full Content-Disposition value: ASCII fallback + RFC 5987 UTF-8. */
export function contentDisposition(filename: string, kind: "inline" | "attachment" = "inline"): string {
  const clean = String(filename ?? "").replace(/[\r\n]/g, " ").trim();
  return `${kind}; filename="${asciiFilename(clean)}"; filename*=UTF-8''${encodeURIComponent(clean || "document.pdf")}`;
}
