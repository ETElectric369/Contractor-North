/**
 * THE TEXT INSIDE A PDF, READ IN THE BROWSER (dropbox plan, Phase 0).
 *
 * The CED importer reads TEXT and does arithmetic on it; it never hands an invoice total to a
 * language model. There is no server-side PDF text extractor in this app, and the one that exists
 * lives in the browser (print/pdf-preview/viewer.tsx loads pdfjs-dist the same way). So the card
 * that used to say "select all and paste" now reads the PDF itself, here, and posts the text.
 *
 * Checked against six of Erik's real CED PDFs (two invoices, two credit memos, two service
 * charges) on 2026-09-24: this join feeds parseCedDocuments cleanly, every one reconciled.
 *
 * A scanned PDF has no text layer; that is said in words ("had no text in it"), never treated as an
 * empty invoice.
 */

export type PdfTextItem = { str?: unknown; hasEOL?: unknown };

/**
 * pdfjs hands back text as runs. A run that ends a line says hasEOL; runs on one line are joined
 * with a space unless the run already ends in one. Spaces are then squeezed per line so column
 * padding cannot split a number the parser reads ("1 234.56" stays two tokens, never three).
 */
export function joinPdfTextItems(items: readonly PdfTextItem[] | null | undefined): string {
  let out = "";
  for (const it of items ?? []) {
    const s = typeof it?.str === "string" ? it.str : "";
    out += s;
    if (it?.hasEOL === true) out += "\n";
    else if (s && !/\s$/.test(s)) out += " ";
  }
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A PDF by its CONTENT: the "%PDF-" signature within the first kilobyte (the spec allows junk
 * ahead of it, and some scanners write a byte-order mark). Never by the file name: he renames
 * files, and a text file called "invoice.pdf" is text.
 */
export function isPdfBytes(bytes: Uint8Array | ArrayBuffer | null | undefined): boolean {
  if (!bytes) return false;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = Math.min(view.length, 1024) - 5;
  for (let i = 0; i <= n; i++) {
    if (view[i] === 0x25 && view[i + 1] === 0x50 && view[i + 2] === 0x44 && view[i + 3] === 0x46 && view[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

/** The same test on text that was read out of a file (the paste door's `{ name, text }`). */
export function isPdfText(text: string | null | undefined): boolean {
  return String(text ?? "").slice(0, 1024).includes("%PDF-");
}

export type PdfTextResult = { ok: true; text: string; pages: number } | { ok: false; error: string };

/** Browser only. Reads every page's text; a PDF with none says so. Never throws. */
export async function readPdfText(data: ArrayBuffer, name = "That PDF"): Promise<PdfTextResult> {
  if (!isPdfBytes(data)) return { ok: false, error: `${name} isn't a PDF inside, whatever its name says.` };
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    // A copy, because pdfjs transfers (detaches) the buffer it is given and the caller may still
    // need the bytes to upload.
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(joinPdfTextItems(content.items as PdfTextItem[]));
    }
    const text = pages.join("\n\n").trim();
    if (!text) return { ok: false, error: `${name} had no text in it. It is probably a scan; drop it on Drop Paperwork and it will be read as a picture.` };
    return { ok: true, text, pages: pdf.numPages };
  } catch (e) {
    return { ok: false, error: `${name} wouldn't open as a PDF (${(e as Error)?.message ?? "unknown error"}).` };
  }
}
