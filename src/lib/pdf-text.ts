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
 *
 * A STATEMENT IS A TABLE, NOT LINES (2026-10-02). Joining runs into lines throws away which COLUMN a
 * figure sat in, and on a bank statement that is the difference between a withdrawal and a deposit.
 * So `readPdf` below also hands every run's x, y and width to pdf-table.ts, which builds the
 * string[][] a statement is read from. This file stays the only place that loads pdfjs.
 */

import { tableFromPositionedItems, type PositionedItem } from "@/lib/pdf-table";

export type PdfTextItem = { str?: unknown; hasEOL?: unknown };

/** The same run, with its place on the page: transform[4] is x, transform[5] is y. */
type PdfPositionedItem = PdfTextItem & { transform?: unknown; width?: unknown; height?: unknown };

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

/**
 * A PDF WITH NO TEXT LAYER IN IT, IN WORDS, IN ONE PLACE. His bank's statement is three scanned
 * pages with ZERO text runs on them: a text reader can do nothing with it, and the one thing that
 * must never happen is reporting it as "no rows" or an empty statement. Both readers below end here,
 * so there is one sentence for it and not two that drift apart.
 */
export function noTextSaid(name: string): string {
  return `${name} had no text in it. It is probably a scan; put it in through Snap Or Note and it will be read as a picture.`;
}

/**
 * EVERY PAGE, BOTH WAYS AT ONCE: the text runs joined into lines (what the CED importer reads) and
 * the same runs as a table, from where each one sits on the page (what a statement needs). One open,
 * one page loop: a statement PDF used to be parsed twice to get both.
 */
export type PdfReadResult = { ok: true; text: string; table: string[][]; pages: number } | { ok: false; error: string };

/**
 * Browser only. Never throws: every failure is a sentence a person can act on.
 *
 * `table: false` reads the text and nothing else. The vendor price-list importer asks for the text of
 * a two-hundred-page catalogue and has no use for a grid, so it does not pay for one; the statement
 * doors ask for both and get both out of ONE open of the file.
 */
export async function readPdf(data: ArrayBuffer, name = "That PDF", opts: { table?: boolean } = {}): Promise<PdfReadResult> {
  if (!isPdfBytes(data)) return { ok: false, error: `${name} isn't a PDF inside, whatever its name says.` };
  const wantTable = opts.table !== false;
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    // A copy, because pdfjs transfers (detaches) the buffer it is given and the caller may still
    // need the bytes to upload.
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    const pages: string[] = [];
    const marks: PositionedItem[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(joinPdfTextItems(content.items as PdfTextItem[]));
      if (!wantTable) continue;
      for (const it of content.items as PdfPositionedItem[]) {
        // A marked-content item has no str and no transform; only text runs have a place.
        const t = it?.transform;
        if (typeof it?.str !== "string" || !Array.isArray(t)) continue;
        marks.push({ str: it.str, x: Number(t[4]), y: Number(t[5]), width: Number(it.width), height: Number(it.height), page: n - 1 });
      }
    }
    const text = pages.join("\n\n").trim();
    if (!text) return { ok: false, error: noTextSaid(name) };
    return { ok: true, text, table: wantTable ? tableFromPositionedItems(marks) : [], pages: pdf.numPages };
  } catch (e) {
    return { ok: false, error: `${name} wouldn't open as a PDF (${(e as Error)?.message ?? "unknown error"}).` };
  }
}

/** Browser only. Reads every page's text; a PDF with none says so. Never throws. */
export async function readPdfText(data: ArrayBuffer, name = "That PDF"): Promise<PdfTextResult> {
  const got = await readPdf(data, name, { table: false });
  return got.ok ? { ok: true, text: got.text, pages: got.pages } : got;
}
