import { parseCSV } from "@/lib/csv";
import { tableFromText } from "@/lib/supplier-open-list";
import { canInflateRawHere, inflateRawInBrowser, readXlsx } from "@/lib/xlsx-read";

/**
 * A SUPPLIER'S LIST FILE, READ IN THE BROWSER (2026-09-26). Drop Paperwork and Organize take a
 * supplier's open-list download (Excel or CSV) exactly where they take any other paper; this turns
 * the file into rows of cells, and the server reads the rows (supplier-open-list.ts). Reading costs
 * nothing and sends no file anywhere: .xlsx through the zero-dependency reader the vendor import
 * already uses, CSV and text tables as text.
 */

/** Files this door reads as a list rather than as a picture or a PDF. */
export const LIST_ACCEPT = ".csv,.tsv,.txt,.xlsx,.xls,text/csv,text/tab-separated-values,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function isListFile(file: { name?: string; type?: string }): boolean {
  const name = String(file?.name ?? "").toLowerCase();
  const type = String(file?.type ?? "").toLowerCase();
  return (
    /\.(csv|tsv|txt|xlsx|xls)$/.test(name) ||
    type === "text/csv" ||
    type === "text/tab-separated-values" ||
    type === "text/plain" ||
    type.includes("spreadsheetml") ||
    type === "application/vnd.ms-excel"
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

export async function readListFile(file: File): Promise<ListFileRead> {
  const name = file.name || "That file";
  const lower = name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (file.size > LIST_MAX) return { ok: false, error: `${name} is over 5 MB. Save just the open list as its own file and drop that.` };
  const listDate = savedOn(file.lastModified);
  if (/\.xlsx?$/.test(lower) || type.includes("spreadsheetml") || type === "application/vnd.ms-excel") {
    if (/\.xlsx$/.test(lower) && !canInflateRawHere()) return { ok: false, error: `This device can't open .xlsx. Save ${name} as CSV and drop that.` };
    const res = await readXlsx(new Uint8Array(await file.arrayBuffer()), inflateRawInBrowser, name);
    // The reader's refusals were written for a vendor list; the way forward is the same.
    return res.ok ? { ok: true, table: res.rows, listDate } : { ok: false, error: res.error.replace(/vendor list/g, "list") };
  }
  const text = await file.text();
  const table = tableFromText(text, parseCSV);
  if (!table.length) return { ok: false, error: `${name} has no rows in it.` };
  return { ok: true, table, listDate };
}
