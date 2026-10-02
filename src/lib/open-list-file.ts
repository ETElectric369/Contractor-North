import { parseCSV } from "@/lib/csv";
import { tableFromText } from "@/lib/supplier-open-list";
import { canInflateRawHere, inflateRawInBrowser, readXlsx } from "@/lib/xlsx-read";
import { isCompoundFile, readXls } from "@/lib/xls-read";
import { looksLikeOfx, readOfx } from "@/lib/ofx-read";
import { readPdf } from "@/lib/pdf-text";
import { tableReadsAsList } from "@/lib/pdf-table";

/**
 * A LIST FILE, READ IN THE BROWSER (2026-09-26; bank downloads 2026-09-27). Snap Or Note and
 * Organize take a supplier's open-list download or a bank's account download exactly where they
 * take any other paper; this turns the file into rows of cells, and the server decides what the
 * rows are (a bank download: bank-download.ts; a supplier's list: supplier-open-list.ts). Reading
 * costs nothing and sends no file anywhere: .xlsx through the zero-dependency reader the vendor
 * import already uses, the old .xls through its own (xls-read.ts), a bank's OFX/QFX/QBO through
 * ofx-read.ts, CSV and text tables as text.
 */

/** Files this door reads as a list rather than as a picture or a PDF. */
export const LIST_ACCEPT =
  ".csv,.tsv,.txt,.xlsx,.xls,.ofx,.qfx,.qbo,text/csv,text/tab-separated-values,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/x-ofx,application/vnd.intu.qfx";

/**
 * THE STATEMENT DOOR'S FILES: every download above, AND the PDF his supplier emails him. It is BUILT
 * FROM LIST_ACCEPT rather than spelled out again, so a file type added to one door is not missing from
 * the other.
 *
 * AND IT IS A SECOND CONSTANT, NOT ".pdf" ADDED TO LIST_ACCEPT: `isListFile` feeds `oneList`, which
 * calls `readListFile`, and that reader cannot read a PDF. Adding ".pdf" there would send every PDF
 * into a reader that can only refuse it.
 */
export const STATEMENT_ACCEPT = `application/pdf,.pdf,${LIST_ACCEPT}`;

export function isListFile(file: { name?: string; type?: string }): boolean {
  const name = String(file?.name ?? "").toLowerCase();
  const type = String(file?.type ?? "").toLowerCase();
  return (
    /\.(csv|tsv|txt|xlsx|xls|ofx|qfx|qbo)$/.test(name) ||
    type === "text/csv" ||
    type === "text/tab-separated-values" ||
    type === "text/plain" ||
    type.includes("spreadsheetml") ||
    type === "application/vnd.ms-excel" ||
    type.includes("ofx") ||
    type.includes("qfx")
  );
}

const LIST_MAX = 5 * 1024 * 1024;

/** The day a file was saved, on this device's calendar: the list speaks for that day. */
export function savedOn(lastModified: number | null | undefined): string | null {
  if (!lastModified || !Number.isFinite(lastModified)) return null;
  const d = new Date(lastModified);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type ListFileRead = { ok: true; table: string[][]; listDate: string | null } | { ok: false; error: string };

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * AN HTML TABLE SAVED AS ".xls". Some banks' "Excel" download is a web page with a table in it;
 * Excel opens it, so people think it is a spreadsheet. Rows by <tr>, cells by <td>/<th>, tags
 * stripped. Null when there is no table.
 */
export function tableFromHtml(html: string): string[][] | null {
  const src = String(html ?? "");
  if (!/<table\b/i.test(src)) return null;
  const rows: string[][] = [];
  for (const tr of src.split(/<tr\b[^>]*>/i).slice(1)) {
    const body = tr.split(/<\/tr>/i)[0];
    const cells = body
      .split(/<t[dh]\b[^>]*>/i)
      .slice(1)
      .map((c) =>
        c
          .split(/<\/t[dh]>/i)[0]
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]*>/g, "")
          .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) =>
            e.startsWith("#x") ? String.fromCharCode(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCharCode(Number(e.slice(1))) : (ENTITY[e.toLowerCase()] ?? m),
          )
          .replace(/\s+/g, " ")
          .trim(),
      );
    if (cells.some((c) => c !== "")) rows.push(cells);
  }
  return rows.length ? rows : null;
}

export async function readListFile(file: File): Promise<ListFileRead> {
  const name = file.name || "That file";
  const lower = name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (file.size > LIST_MAX) return { ok: false, error: `${name} is over 5 MB. Save just the list (or a shorter date range) as its own file and drop that.` };
  const listDate = savedOn(file.lastModified);
  const bytes = new Uint8Array(await file.arrayBuffer());

  // THE OLD EXCEL FORMAT, by what is in the file (a compound file), whatever it is called.
  if (isCompoundFile(bytes) && !/\.xlsx$/.test(lower)) {
    const res = readXls(bytes, name);
    return res.ok ? { ok: true, table: res.rows, listDate } : { ok: false, error: res.error };
  }
  if (/\.xlsx$/.test(lower) || type.includes("spreadsheetml") || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    if (!canInflateRawHere()) return { ok: false, error: `This device can't open .xlsx. Save ${name} as CSV and drop that.` };
    const res = await readXlsx(bytes, inflateRawInBrowser, name);
    // The reader's refusals were written for a vendor list; the way forward is the same.
    return res.ok ? { ok: true, table: res.rows, listDate } : { ok: false, error: res.error.replace(/vendor list/g, "list") };
  }
  const text = new TextDecoder().decode(bytes);
  if (looksLikeOfx(text)) {
    const res = readOfx(text, name);
    return res.ok ? { ok: true, table: res.rows, listDate } : { ok: false, error: res.error };
  }
  // A web page saved as .xls (some banks' "Excel" download).
  const html = /^\s*</.test(text) ? tableFromHtml(text) : null;
  if (html) return { ok: true, table: html, listDate };
  if (/\.xls$/.test(lower) && /[\x00-\x08]/.test(text.slice(0, 512))) {
    return { ok: false, error: `${name} wouldn't open as an Excel file. Download it again as CSV and drop that.` };
  }
  const table = tableFromText(text, parseCSV);
  if (!table.length) return { ok: false, error: `${name} has no rows in it.` };
  return { ok: true, table, listDate };
}

/** A PDF by what is in it, with the name as the cheap first look. The bytes decide (isPdfBytes). */
function namedPdf(file: { name?: string; type?: string }): boolean {
  return /\.pdf$/i.test(String(file?.name ?? "")) || String(file?.type ?? "").toLowerCase() === "application/pdf";
}

/** A statement PDF is pages, not a line of CSV: the same 15 MB cap Snap Or Note gives a paper. */
const STATEMENT_MAX = 15 * 1024 * 1024;

export type StatementFileRead = { ok: true; table: string[][]; listDate: string | null; pdf: { pages: number; rows: number } | null } | { ok: false; error: string };

/**
 * ONE STATEMENT, WHATEVER IT ARRIVED AS (2026-10-02). Erik: "i want to upload my bank statement and
 * supplier statement, every item will either match or need a category." A download goes through
 * `readListFile` as it always has; a PDF goes through the browser's pdfjs reader and pdf-table.ts,
 * and only a table one of the existing readers RECOGNISES comes back — `tableReadsAsList` asks
 * bank-download.ts and supplier-open-list.ts, and invents no test of its own.
 *
 * A PDF THAT IS ONE PAPER IS NOT A DEAD END: the refusal names the door that does take it. This
 * door's job is a statement, and the + button's job is a paper.
 */
export async function readStatementFile(file: File): Promise<StatementFileRead> {
  const name = file.name || "That file";
  if (!namedPdf(file)) {
    const read = await readListFile(file);
    return read.ok ? { ok: true, table: read.table, listDate: read.listDate, pdf: null } : read;
  }
  if (file.size > STATEMENT_MAX) return { ok: false, error: `${name} is over 15 MB. Save just the statement pages as their own PDF and drop that.` };
  const bytes = await file.arrayBuffer();
  const got = await readPdf(bytes, name);
  if (!got.ok) return { ok: false, error: got.error };
  if (!tableReadsAsList(got.table)) {
    return {
      ok: false,
      error: `${name} has pages this can read, but nothing on them reads as a statement: a supplier's list needs a column of paper numbers and a column of amounts, and a bank's needs a date, a description and an amount on every line. If it is ONE paper — an invoice, a bill, a receipt — add it with the + button at the top and it will be read as a paper.`,
    };
  }
  return { ok: true, table: got.table, listDate: savedOn(file.lastModified), pdf: { pages: got.pages, rows: got.table.length } };
}
