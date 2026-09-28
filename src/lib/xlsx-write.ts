import { buildZip, type DeflateRaw } from "@/lib/zip-write";

/**
 * AN EXCEL WORKBOOK, WITH NOTHING ADDED TO THE APP (the accountant download, 2026-09-27).
 *
 * The writing half of xlsx-read.ts: an .xlsx is a zip of XML parts, and a workbook of plain tabs
 * needs only six kinds of them (the content types, two relationship lists, the workbook, the styles
 * and one part per sheet). Written by hand, like the reader, because package.json has no spreadsheet
 * library and the parts a list of money needs are fixed by the OOXML spec.
 *
 * WHAT EACH CELL IS, SO A SPREADSHEET NEVER GUESSES:
 *   · text is an INLINE STRING (t="inlineStr"): Excel shows it as typed and never runs it. No cell
 *     is ever written with a formula (<f>), so "=HYPERLINK(...)" off a supplier's receipt is text.
 *     XML's five special characters are escaped and control characters XML can't carry are removed.
 *   · a number is a number cell; { money } is a number with the money format (#,##0.00), rounded
 *     to the cent; anything not finite is left empty rather than written as NaN.
 *   · { date: "YYYY-MM-DD" } is a real date (Excel's day count) shown as yyyy-mm-dd.
 *   · a bold row (a title, a header, a total) is bold.
 *   · an indented row (a line under its heading on a profit and loss, 2026-09-28) has its first
 *     cell's text indented one step, the way an accountant lays out a statement. Nothing else is
 *     styled.
 *
 * Sheet names follow Excel's own rules (xlsxSheetName): 31 characters at most, none of []:*?/\,
 * not blank, and never two the same.
 */

export type XlsxValue = string | number | null | undefined | { money: number } | { date: string };
export type XlsxRow = { cells: XlsxValue[]; bold?: boolean; indent?: boolean };
export type XlsxSheet = { name: string; rows: XlsxRow[]; widths?: number[] };

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** Characters XML 1.0 can't carry (every C0 control but tab, line feed and return; the two
 *  non-characters; and a surrogate half on its own). */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text as XML text: control characters removed, the five specials escaped. */
export function xmlEscape(s: string): string {
  return String(s)
    .replace(NOT_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Excel's rules for a tab's name, and never one already `taken` (compared ignoring case). */
export function xlsxSheetName(raw: string, taken: Set<string> = new Set()): string {
  let name = String(raw ?? "")
    .replace(NOT_XML, "")
    .replace(/[\u0000-\u001F]/g, " ")
    .replace(/[[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "")
    .trim();
  if (!name) name = "Sheet";
  name = name.slice(0, 31).trim();
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const tail = ` (${n})`;
    const candidate = `${name.slice(0, 31 - tail.length).trim()}${tail}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnLetters(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Excel's serial day for a "YYYY-MM-DD" (day 1 is 1900-01-01, counted from 1899-12-30 so every
 *  date after February 1900 is right), or null when it isn't a real date. */
export function excelDay(ymd: string): number | null {
  const m = YMD.exec(String(ymd ?? ""));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() + 1 !== Number(m[2]) || back.getUTCDate() !== Number(m[3])) return null;
  return Math.round((t - Date.UTC(1899, 11, 30)) / 86_400_000);
}

// Styles (cellXfs): 0 plain, 1 bold, 2 money, 3 money bold, 4 date, 5 date bold, 6 text indented,
// 7 text indented bold.
const STYLE = { plain: 0, bold: 1, money: 2, moneyBold: 3, date: 4, dateBold: 5, indent: 6, indentBold: 7 } as const;

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="${MAIN_NS}">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="8">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment indent="1"/></xf>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment indent="1"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** A number as its XML value: JavaScript's shortest round-trip form, which Excel reads back to the
 *  same double. */
const numText = (n: number) => String(n);

/** `indent`: the first cell of an indented row. Only its text is indented; a number never is. */
function cellXml(ref: string, v: XlsxValue, bold: boolean, indent = false): string {
  if (v == null) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return `<c r="${ref}"${bold ? ` s="${STYLE.bold}"` : ""}><v>${numText(v)}</v></c>`;
  }
  if (typeof v === "object" && "money" in v) {
    const n = Number(v.money);
    if (!Number.isFinite(n)) return "";
    const cents = Math.round(n * 100) / 100;
    return `<c r="${ref}" s="${bold ? STYLE.moneyBold : STYLE.money}"><v>${numText(Object.is(cents, -0) ? 0 : cents)}</v></c>`;
  }
  if (typeof v === "object" && "date" in v) {
    const serial = excelDay(v.date);
    // Not a real date: said as the text it was, never a wrong day.
    if (serial == null) return textCell(ref, String(v.date ?? ""), bold, indent);
    return `<c r="${ref}" s="${bold ? STYLE.dateBold : STYLE.date}"><v>${serial}</v></c>`;
  }
  return textCell(ref, String(v), bold, indent);
}

function textCell(ref: string, s: string, bold: boolean, indent = false): string {
  if (s === "") return "";
  const style = indent ? (bold ? STYLE.indentBold : STYLE.indent) : bold ? STYLE.bold : null;
  return `<c r="${ref}" t="inlineStr"${style != null ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const width = Math.max(1, ...sheet.rows.map((r) => r.cells.length));
  const cols = (sheet.widths ?? [])
    .map((w, i) => (Number.isFinite(w) && w > 0 ? `<col min="${i + 1}" max="${i + 1}" width="${Math.min(w, 255)}" customWidth="1"/>` : ""))
    .join("");
  const rows = sheet.rows
    .map((r, i) => {
      const n = i + 1;
      const cells = r.cells.map((v, c) => cellXml(`${columnLetters(c)}${n}`, v, !!r.bold, !!r.indent && c === 0)).join("");
      return `<row r="${n}">${cells}</row>`;
    })
    .join("");
  const dim = sheet.rows.length ? `A1:${columnLetters(width - 1)}${sheet.rows.length}` : "A1";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<dimension ref="${dim}"/>` +
    `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${rows}</sheetData>` +
    `</worksheet>`
  );
}

/** The workbook's parts, by path (what buildXlsx zips). Exposed for tests. */
export function xlsxParts(sheets: XlsxSheet[]): { name: string; data: string }[] {
  if (!sheets.length) throw new Error("a workbook needs at least one sheet");
  const taken = new Set<string>();
  const names = sheets.map((s) => {
    const n = xlsxSheetName(s.name, taken);
    taken.add(n);
    return n;
  });
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `</Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<bookViews><workbookView activeTab="0"/></bookViews>` +
    `<sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
    `</workbook>`;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;
  return [
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
}

/** The .xlsx file's bytes. */
export function buildXlsx(sheets: XlsxSheet[], opts: { deflate?: DeflateRaw; modified?: Date } = {}): Uint8Array {
  return buildZip(xlsxParts(sheets), opts);
}
