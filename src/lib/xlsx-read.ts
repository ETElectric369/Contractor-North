/**
 * AN EXCEL FILE'S FIRST SHEET, AS ROWS OF TEXT, WITH NOTHING ADDED TO THE APP (vendor import,
 * Phase 1, 2026-09-25).
 *
 * Andrew (Vivian Builders) keeps his vendor list in Excel, and dropped it on the Vendors tab as
 * an .xlsx. An .xlsx is a zip of XML parts. This reads exactly the parts a list needs and nothing
 * more: the zip's central directory, the workbook (to find the FIRST sheet by its relationship,
 * never by assuming it is called sheet1.xml), the shared strings, and that one sheet's cells.
 *
 * ZERO DEPENDENCIES. The one thing a browser can't do in plain code is inflate, so the caller
 * passes it in: DecompressionStream('deflate-raw') in the browser (iOS 16.4 and later), zlib's
 * inflateRawSync in tests. The XML is read with small, anchored patterns rather than DOMParser,
 * so the same code runs in the browser and under Node tests; Excel writes these parts by machine
 * and the shapes read here are the ones the OOXML spec fixes.
 *
 * EVERY REFUSAL NAMES THE FILE AND SAYS WHAT TO DO (nothing silent, no dead ends):
 *   · the old .xls format and password-protected workbooks (both are OLE compound files inside);
 *   · files over 2 MB and sheets over 1,000 rows (a vendor list, not a database);
 *   · a device whose browser can't inflate (older WebKit): "Save it as CSV".
 */

/** Inflate raw DEFLATE data (no zlib header). May be sync (zlib) or async (DecompressionStream). */
export type InflateRaw = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export type XlsxResult =
  | { ok: true; rows: string[][]; sheetName: string | null }
  | { ok: false; error: string };

export const XLSX_MAX_BYTES = 2 * 1024 * 1024;
export const XLSX_MAX_ROWS = 1000;
/** What any one XML part may inflate to. A 2 MB zip that claims 200 MB is a zip bomb, not a list. */
const PART_MAX_BYTES = 40 * 1024 * 1024;

/** Thrown by an InflateRaw that can't run on this device, so the reader can say so by name. */
export class InflateUnavailable extends Error {}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

type ZipEntry = { name: string; method: number; flags: number; compSize: number; size: number; localOffset: number };

/** The zip's table of contents, read from its end (the central directory is authoritative; the
 *  local headers can carry zeroed sizes when the writer streamed). Null when this isn't a zip. */
function centralDirectory(b: Uint8Array): ZipEntry[] | null {
  const floor = Math.max(0, b.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = b.length - 22; i >= floor; i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = u16(b, eocd + 10);
  const offset = u32(b, eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) return null; // ZIP64: never a 2 MB vendor list
  const out: ZipEntry[] = [];
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) return null;
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const compSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const localOffset = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, flags, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(b: Uint8Array, e: ZipEntry, inflate: InflateRaw): Promise<string> {
  if (e.flags & 1) throw new XlsxRefusal("encrypted");
  if (e.size > PART_MAX_BYTES) throw new XlsxRefusal("too-big");
  const lo = e.localOffset;
  if (u32(b, lo) !== 0x04034b50) throw new XlsxRefusal("broken");
  const start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
  const data = b.subarray(start, start + e.compSize);
  let raw: Uint8Array;
  if (e.method === 0) raw = data;
  else if (e.method === 8) raw = await inflate(data);
  else throw new XlsxRefusal("broken");
  if (raw.length > PART_MAX_BYTES) throw new XlsxRefusal("too-big");
  return new TextDecoder().decode(raw);
}

class XlsxRefusal extends Error {
  constructor(public why: "encrypted" | "too-big" | "broken") {
    super(why);
  }
}

/** XML text → plain text: the five named entities, numeric references, and OOXML's own _xHHHH_
 *  escape (Excel writes a carriage return inside a cell as _x000D_). */
export function xmlText(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g, (_, ent: string) => {
      if (ent === "amp") return "&";
      if (ent === "lt") return "<";
      if (ent === "gt") return ">";
      if (ent === "quot") return '"';
      if (ent === "apos") return "'";
      const code = ent.startsWith("#x") ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    });
}

/** The value of attribute `name` on one tag's text, prefix-blind (r:id, x:r). */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s(?:[\\w.-]+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? xmlText(m[2] ?? m[3] ?? "") : null;
}

/** An opening tag that is NOT self-closing (its attributes can't end in "/"), and a self-closing
 *  one, prefix-blind. Kept apart so `<t xml:space="preserve"/>` can never open a run that swallows
 *  the next cell. (No lookbehind: older Safari refuses to parse a module that has one.) */
const OPEN = (tag: string) => `<(?:\\w+:)?${tag}(?:\\s[^>]*[^/>])?>`;
const SELF = (tag: string) => `<(?:\\w+:)?${tag}(?:\\s[^>]*)?\\/>`;
const CLOSE = (tag: string) => `<\\/(?:\\w+:)?${tag}>`;
/** `<tag ...>inner</tag>` (inner in group 1) or `<tag .../>` (no group 1). */
const ELEMENT = (tag: string, flags = "g") => new RegExp(`${OPEN(tag)}([\\s\\S]*?)${CLOSE(tag)}|${SELF(tag)}`, flags);

/** Every <t> run inside a string item, in order, leaving out phonetic guides (<rPh>), which are
 *  reading aids for Japanese text and not part of what the cell says. */
function runsOf(xml: string): string {
  const withoutPhonetic = xml.replace(ELEMENT("rPh"), "");
  let out = "";
  const re = ELEMENT("t");
  for (let m = re.exec(withoutPhonetic); m; m = re.exec(withoutPhonetic)) out += xmlText(m[1] ?? "");
  return out;
}

export function sharedStringsOf(xml: string): string[] {
  const out: string[] = [];
  const re = ELEMENT("si");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(runsOf(m[1] ?? ""));
  return out;
}

/** "B12" → 1 (zero-based column). */
function columnOf(ref: string | null): number | null {
  const m = /^([A-Za-z]{1,3})\d*$/.exec(String(ref ?? ""));
  if (!m) return null;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** One worksheet's cells, as rows of text. Row and column positions come from each cell's own
 *  reference when it has one, so a skipped column stays a gap and never shifts a phone number into
 *  the email column. Fully blank rows are dropped (as parseCSV drops them). */
export function sheetRowsOf(xml: string, shared: string[], maxRows = XLSX_MAX_ROWS): string[][] | { tooMany: true } {
  const data = ELEMENT("sheetData", "").exec(xml)?.[1] ?? "";
  const rows: string[][] = [];
  // The attributes are captured too (group 1 of the open tag, group 3 of the self-closing one).
  const withAttrs = (tag: string) =>
    new RegExp(`<(?:\\w+:)?${tag}(\\s[^>]*[^/>])?>([\\s\\S]*?)${CLOSE(tag)}|<(?:\\w+:)?${tag}(\\s[^>]*)?\\/>`, "g");
  const rowRe = withAttrs("row");
  const cellRe = withAttrs("c");
  let seen = 0;
  for (let rm = rowRe.exec(data); rm; rm = rowRe.exec(data)) {
    const inner = rm[2] ?? "";
    const cells: string[] = [];
    let next = 0;
    cellRe.lastIndex = 0;
    for (let cm = cellRe.exec(inner); cm; cm = cellRe.exec(inner)) {
      const tag = cm[1] ?? cm[3] ?? "";
      const body = cm[2] ?? "";
      const col = columnOf(attr(tag, "r")) ?? next;
      next = col + 1;
      const type = attr(tag, "t");
      const v = ELEMENT("v", "").exec(body)?.[1];
      let text = "";
      if (type === "s") text = shared[Number(v)] ?? "";
      else if (type === "inlineStr") text = runsOf(ELEMENT("is", "").exec(body)?.[1] ?? "");
      else if (type === "b") text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else if (type === "e") text = "";
      else text = xmlText(v ?? "");
      if (col > 16383) continue;
      while (cells.length < col) cells.push("");
      cells[col] = text;
    }
    if (!cells.some((c) => c.trim() !== "")) continue;
    seen++;
    if (seen > maxRows) return { tooMany: true };
    rows.push(cells);
  }
  return rows;
}

/** Resolve a relationship Target against the part that owns it: "worksheets/sheet1.xml" from
 *  xl/workbook.xml is xl/worksheets/sheet1.xml; "/xl/worksheets/sheet1.xml" is absolute. */
function resolvePart(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
  const parts = (dir + target).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

function relsOf(xml: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  const re = /<(?:\w+:)?Relationship\b([^>]*)\/?>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const id = attr(m[1], "Id");
    const target = attr(m[1], "Target");
    if (id && target) out.set(id, { target, type: attr(m[1], "Type") ?? "" });
  }
  return out;
}

/** The compound-file (OLE) signature. An .xls is one, and so is a password-protected .xlsx. */
function isCompoundFile(b: Uint8Array): boolean {
  return b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1;
}

/**
 * Read the first sheet of an .xlsx. Never throws: every way it can't is a sentence naming the file.
 * `name` is the file's name as the person sees it, used in those sentences.
 */
export async function readXlsx(bytes: Uint8Array | ArrayBuffer, inflateRaw: InflateRaw, name = "That file"): Promise<XlsxResult> {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > XLSX_MAX_BYTES) {
    return { ok: false, error: `${name} is over 2 MB. A vendor list is usually far smaller: save just the list as its own .xlsx or CSV and drop that.` };
  }
  if (isCompoundFile(b)) {
    return /\.xls$/i.test(name)
      ? { ok: false, error: `${name} is the old Excel format. Save it as .xlsx or CSV and drop it again.` }
      : { ok: false, error: `${name} is password-protected. Open it in Excel, take the password off (or save a copy as CSV), and drop it again.` };
  }
  const entries = centralDirectory(b);
  if (!entries) return { ok: false, error: `${name} isn't an Excel .xlsx inside, whatever its name says. Save it as .xlsx or CSV and try again.` };
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = async (part: string): Promise<string | null> => {
    const e = byName.get(part);
    return e ? readEntry(b, e, inflateRaw) : null;
  };

  try {
    // The workbook part, found the way Excel finds it: through the package's own relationships.
    const rootRels = relsOf((await read("_rels/.rels")) ?? "");
    const officeDoc = [...rootRels.values()].find((r) => /\/officeDocument$/.test(r.type));
    const workbookPath = officeDoc ? resolvePart("", officeDoc.target) : "xl/workbook.xml";
    const workbook = await read(workbookPath);
    if (workbook === null) return { ok: false, error: `${name} has no workbook inside. Save it again from Excel as .xlsx or CSV.` };

    const firstSheet = /<(?:\w+:)?sheet\b([^>]*)\/?>/.exec(workbook);
    if (!firstSheet) return { ok: false, error: `${name} has no sheets in it.` };
    const relId = attr(firstSheet[1], "id");
    const sheetName = attr(firstSheet[1], "name");
    const relsPath = resolvePart(workbookPath, `_rels/${workbookPath.split("/").pop()}.rels`);
    const wbRels = relsOf((await read(relsPath)) ?? "");
    const target = relId ? wbRels.get(relId)?.target : undefined;
    if (!target) return { ok: false, error: `${name}'s first sheet couldn't be found inside it. Save it again from Excel as .xlsx or CSV.` };
    const sheetXml = await read(resolvePart(workbookPath, target));
    if (sheetXml === null) return { ok: false, error: `${name}'s first sheet is missing from the file. Save it again from Excel as .xlsx or CSV.` };

    const sstRel = [...wbRels.values()].find((r) => /\/sharedStrings$/.test(r.type));
    const sstXml = await read(sstRel ? resolvePart(workbookPath, sstRel.target) : "xl/sharedStrings.xml");
    const shared = sstXml ? sharedStringsOf(sstXml) : [];

    const rows = sheetRowsOf(sheetXml, shared);
    if ("tooMany" in rows) {
      return { ok: false, error: `${name} has more than ${XLSX_MAX_ROWS.toLocaleString("en-US")} rows. Save just the vendor list as its own file and drop that.` };
    }
    return { ok: true, rows, sheetName };
  } catch (e) {
    if (e instanceof InflateUnavailable) return { ok: false, error: `This device can't open .xlsx. Save ${name} as CSV and drop that.` };
    if (e instanceof XlsxRefusal) {
      if (e.why === "encrypted") return { ok: false, error: `${name} is password-protected. Take the password off in Excel (or save a copy as CSV) and drop it again.` };
      if (e.why === "too-big") return { ok: false, error: `${name} is too large inside to be a vendor list. Save just the list as its own .xlsx or CSV.` };
    }
    return { ok: false, error: `${name} wouldn't open as an Excel file. Save it again from Excel as .xlsx or CSV and drop it again.` };
  }
}

/** Can this browser inflate raw DEFLATE? DecompressionStream('deflate-raw') arrived in iOS 16.4. */
export function canInflateRawHere(): boolean {
  if (typeof DecompressionStream === "undefined") return false;
  try {
    new DecompressionStream("deflate-raw" as CompressionFormat);
    return true;
  } catch {
    return false;
  }
}

/** The browser's inflate, for readXlsx. Throws InflateUnavailable on a device that has none. */
export async function inflateRawInBrowser(bytes: Uint8Array): Promise<Uint8Array> {
  if (!canInflateRawHere()) throw new InflateUnavailable("deflate-raw");
  const copy = new Uint8Array(bytes); // a plain ArrayBuffer-backed copy for the Blob
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
