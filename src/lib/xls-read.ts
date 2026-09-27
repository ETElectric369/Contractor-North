/**
 * THE OLD EXCEL FORMAT (.xls), FIRST SHEET, AS ROWS OF TEXT, WITH NOTHING ADDED TO THE APP (bank
 * download, 2026-09-27).
 *
 * Banks still hand out "Download to Excel" as the 1997-2003 format: a compound file (the OLE box
 * Word and Excel used before zip) holding a "Workbook" stream of BIFF8 records. xlsx-read.ts
 * refuses it by name; this reads it, so a bank's own download goes in as it came.
 *
 * ZERO DEPENDENCIES, SAME SHAPE AS readXlsx: rows of text, blank rows dropped, a skipped column kept
 * as a gap. It reads exactly what a list needs: the compound file's FAT and directory, the workbook
 * globals (shared strings, number formats, which sheet is first) and that one sheet's cells. A
 * number whose format is a date comes out as YYYY-MM-DD (a bank's Post Date column is a date cell),
 * every other number as its plain digits.
 *
 * EVERY REFUSAL NAMES THE FILE AND SAYS WHAT TO DO (nothing silent, no dead ends): a
 * password-protected workbook, a file that isn't a compound file inside, a sheet over the row cap.
 * Pure: bytes in, rows out; the same code runs in the browser and in the tests.
 */

export type XlsResult = { ok: true; rows: string[][]; sheetName: string | null } | { ok: false; error: string };

export const XLS_MAX_BYTES = 5 * 1024 * 1024;
export const XLS_MAX_ROWS = 5000;

const u16 = (b: Uint8Array, o: number) => (o + 1 < b.length ? b[o] | (b[o + 1] << 8) : 0);
const u32 = (b: Uint8Array, o: number) => (o + 3 < b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0);
const i32 = (b: Uint8Array, o: number) => u32(b, o) | 0;
const f64 = (b: Uint8Array, o: number) => (o + 7 < b.length ? new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true) : NaN);

const END_OF_CHAIN = 0xfffffffe;
const FREE_SECT = 0xffffffff;

class XlsRefusal extends Error {
  constructor(public why: "encrypted" | "broken" | "too-many" | "no-workbook") {
    super(why);
  }
}

/** The compound-file (OLE) signature. */
export function isCompoundFile(b: Uint8Array): boolean {
  return b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1;
}

// ── THE COMPOUND FILE ──────────────────────────────────────────────────────────────────────────

/** One named stream out of a compound file, or null when it has none by that name. */
export function compoundStream(b: Uint8Array, names: readonly string[]): Uint8Array | null {
  if (!isCompoundFile(b) || b.length < 512) throw new XlsRefusal("broken");
  const sectorShift = u16(b, 0x1e);
  const miniShift = u16(b, 0x20);
  if (sectorShift !== 9 && sectorShift !== 12) throw new XlsRefusal("broken");
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << (miniShift || 6);
  const dirStart = u32(b, 0x30);
  const miniCutoff = u32(b, 0x38) || 4096;
  const miniFatStart = u32(b, 0x3c);
  const difStart = u32(b, 0x44);
  const difCount = u32(b, 0x48);
  const sectorCount = Math.floor((b.length - sectorSize) / sectorSize) + 1;
  const offsetOf = (n: number) => (n + 1) * sectorSize;
  const sector = (n: number) => {
    if (n >= sectorCount + 1) throw new XlsRefusal("broken");
    const o = offsetOf(n);
    return b.subarray(o, Math.min(b.length, o + sectorSize));
  };

  // The FAT's own sectors: 109 in the header, the rest down the DIFAT chain.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(b, 0x4c + i * 4);
    if (s !== FREE_SECT && s !== END_OF_CHAIN) fatSectors.push(s);
  }
  let dif = difStart;
  for (let n = 0; n < difCount && dif !== END_OF_CHAIN && dif !== FREE_SECT; n++) {
    const s = sector(dif);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) {
      const v = u32(s, i * 4);
      if (v !== FREE_SECT && v !== END_OF_CHAIN) fatSectors.push(v);
    }
    dif = u32(s, per * 4);
  }
  const fat: number[] = [];
  for (const fs of fatSectors) {
    const s = sector(fs);
    for (let i = 0; i + 3 < s.length; i += 4) fat.push(u32(s, i));
  }
  // A CHAIN WITH A LOOP IN IT is a broken file, never a hang: every sector is visited at most once.
  const chain = (start: number, table: number[]) => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s !== END_OF_CHAIN && s !== FREE_SECT; s = table[s] ?? END_OF_CHAIN) {
      if (seen.has(s) || out.length > table.length) throw new XlsRefusal("broken");
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  const readChain = (start: number) => {
    const parts = chain(start, fat).map(sector);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  const dir = readChain(dirStart);
  type Entry = { name: string; type: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = Math.min(64, u16(dir, o + 0x40));
    let name = "";
    for (let i = 0; i + 1 < nameLen - 1; i += 2) name += String.fromCharCode(u16(dir, o + i));
    entries.push({ name, type: dir[o + 0x42], start: u32(dir, o + 0x74), size: u32(dir, o + 0x78) });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw new XlsRefusal("broken");
  const want = entries.find((e) => e.type === 2 && names.some((n) => n.toLowerCase() === e.name.toLowerCase()));
  if (!want) return null;
  if (want.size < miniCutoff) {
    // A SMALL STREAM LIVES IN THE MINI STREAM, which is the root entry's own chain, cut into 64-byte
    // mini sectors that the mini FAT chains together.
    const miniStream = readChain(root.start);
    const miniFatBytes = miniFatStart === END_OF_CHAIN ? new Uint8Array() : readChain(miniFatStart);
    const miniFat: number[] = [];
    for (let i = 0; i + 3 < miniFatBytes.length; i += 4) miniFat.push(u32(miniFatBytes, i));
    const out = new Uint8Array(want.size);
    let at = 0;
    for (const m of chain(want.start, miniFat)) {
      const o = m * miniSize;
      const piece = miniStream.subarray(o, o + miniSize);
      out.set(piece.subarray(0, Math.min(piece.length, want.size - at)), at);
      at += piece.length;
      if (at >= want.size) break;
    }
    return out;
  }
  return readChain(want.start).subarray(0, want.size);
}

// ── BIFF RECORDS ───────────────────────────────────────────────────────────────────────────────

type Rec = { id: number; data: Uint8Array; at: number };

function* records(w: Uint8Array, from = 0): Generator<Rec> {
  let p = from;
  while (p + 4 <= w.length) {
    const id = u16(w, p);
    const len = u16(w, p + 2);
    const data = w.subarray(p + 4, p + 4 + len);
    yield { id, data, at: p };
    p += 4 + len;
  }
}

const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RSTRING: 0x00d6,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BOOLERR: 0x0205,
  XF: 0x00e0,
  FORMAT: 0x041e,
  FILEPASS: 0x002f,
  DATEMODE: 0x0022,
} as const;

/** A string read across record boundaries: each CONTINUE starts its characters with a fresh
 *  "high byte" flag, so a string that splits mid-way can change width at the split. */
class Stream {
  pos = 0;
  seg = 0;
  constructor(private segs: Uint8Array[]) {}
  private cur() {
    while (this.seg < this.segs.length && this.pos >= this.segs[this.seg].length) {
      this.seg++;
      this.pos = 0;
    }
    return this.segs[this.seg];
  }
  done() {
    return !this.cur();
  }
  byte(): number {
    const s = this.cur();
    if (!s) throw new XlsRefusal("broken");
    return s[this.pos++];
  }
  u16() {
    return this.byte() | (this.byte() << 8);
  }
  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number) {
    for (let i = 0; i < n; i++) this.byte();
  }
  /** Characters, `high` = two bytes each. At a segment boundary the next segment begins with its
   *  own flag byte for the rest of the characters. */
  chars(count: number, high: boolean): string {
    let out = "";
    let wide = high;
    for (let i = 0; i < count; i++) {
      // At the end of a segment (even before the first character: Excel never splits a string's
      // header, but it may end a record right after it), the next one opens with its own flag.
      if (this.seg < this.segs.length && this.pos >= this.segs[this.seg].length) {
        this.seg++;
        this.pos = 0;
        if (this.seg >= this.segs.length) throw new XlsRefusal("broken");
        wide = (this.byte() & 1) === 1;
      }
      out += String.fromCharCode(wide ? this.u16() : this.byte());
    }
    return out;
  }
  /** XLUnicodeRichExtendedString (the SST's own). */
  richString(): string {
    const cch = this.u16();
    const flags = this.byte();
    const high = (flags & 1) === 1;
    const rich = (flags & 8) === 8;
    const ext = (flags & 4) === 4;
    const runs = rich ? this.u16() : 0;
    const extLen = ext ? this.u32() : 0;
    const s = this.chars(cch, high);
    this.skip(runs * 4 + extLen);
    return s;
  }
}

/** XLUnicodeString inside one record (LABEL, FORMAT, STRING): cch(2) flags(1) chars. BIFF5 has no
 *  flag byte and 8-bit characters. */
function unicodeString(d: Uint8Array, o: number, biff8: boolean): string {
  const cch = u16(d, o);
  if (!biff8) {
    let s = "";
    for (let i = 0; i < cch && o + 2 + i < d.length; i++) s += String.fromCharCode(d[o + 2 + i]);
    return s;
  }
  const flags = d[o + 2] ?? 0;
  const high = (flags & 1) === 1;
  let p = o + 3;
  if (flags & 8) p += 2;
  if (flags & 4) p += 4;
  let s = "";
  for (let i = 0; i < cch; i++) {
    if (high) {
      if (p + 1 >= d.length) break;
      s += String.fromCharCode(u16(d, p));
      p += 2;
    } else {
      if (p >= d.length) break;
      s += String.fromCharCode(d[p]);
      p += 1;
    }
  }
  return s;
}

function rkValue(rk: number): number {
  let n: number;
  if (rk & 2) n = rk >> 2;
  else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, rk & 0xfffffffc, true);
    buf.setUint32(0, 0, true);
    n = buf.getFloat64(0, true);
  }
  return rk & 1 ? n / 100 : n;
}

/** Excel's built-in date and time format ids. */
const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** A custom number format that shows a date: d, m or y outside quotes, brackets and escapes. */
export function isDateFormat(code: string): boolean {
  const bare = String(code ?? "")
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .replace(/_./g, "")
    .replace(/\*./g, "");
  return /[dy]/i.test(bare) || /m/i.test(bare.replace(/[hs][^;]*m/gi, ""));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A date serial as YYYY-MM-DD, in the workbook's own date system (1900, or 1904 on old Macs). */
export function serialToYmd(serial: number, is1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const epoch = is1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const t = new Date(epoch + Math.floor(serial) * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** A number as a person reads it, without floating-point noise (0.1 + 0.2 stays 0.3). */
const plainNumber = (n: number) => (Number.isFinite(n) ? String(Number(n.toPrecision(15))) : "");

/**
 * Read the first sheet of an .xls. Never throws: every way it can't is a sentence naming the file.
 */
export function readXls(bytes: Uint8Array | ArrayBuffer, name = "That file"): XlsResult {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > XLS_MAX_BYTES) return { ok: false, error: `${name} is over 5 MB. Download a shorter date range and drop that.` };
  if (!isCompoundFile(b)) {
    return { ok: false, error: `${name} isn't an Excel .xls inside, whatever its name says. Download it again as CSV or Excel and drop that.` };
  }
  try {
    const w = compoundStream(b, ["Workbook", "Book"]);
    if (!w) throw new XlsRefusal("no-workbook");

    // ── The workbook globals ──
    let biff8 = true;
    let is1904 = false;
    const formats = new Map<number, string>();
    const xfFormat: number[] = [];
    const sheets: { name: string; pos: number; type: number }[] = [];
    let shared: string[] = [];
    // The globals, up to their EOF, as a list, so the shared strings can take the CONTINUE
    // records that follow them.
    const globals: Rec[] = [];
    for (const r of records(w)) {
      globals.push(r);
      if (r.id === R.EOF) break;
    }
    if (globals[0]?.id !== R.BOF) throw new XlsRefusal("broken");
    biff8 = u16(globals[0].data, 0) === 0x0600;
    for (let i = 1; i < globals.length; i++) {
      const { id, data } = globals[i];
      if (id === R.EOF) break;
      if (id === R.FILEPASS) throw new XlsRefusal("encrypted");
      if (id === R.DATEMODE) is1904 = u16(data, 0) === 1;
      else if (id === R.FORMAT) {
        const ifmt = u16(data, 0);
        formats.set(ifmt, biff8 ? unicodeString(data, 2, true) : String.fromCharCode(...data.subarray(3, 3 + (data[2] ?? 0))));
      } else if (id === R.XF) xfFormat.push(u16(data, 2));
      else if (id === R.BOUNDSHEET) {
        const pos = u32(data, 0);
        const type = data[5] ?? 0;
        const cch = data[6] ?? 0;
        let sheetName = "";
        if (biff8) {
          const high = ((data[7] ?? 0) & 1) === 1;
          for (let c = 0; c < cch; c++) sheetName += String.fromCharCode(high ? u16(data, 8 + c * 2) : (data[8 + c] ?? 0));
        } else for (let c = 0; c < cch; c++) sheetName += String.fromCharCode(data[7 + c] ?? 0);
        sheets.push({ name: sheetName, pos, type });
      } else if (id === R.SST) {
        // The shared strings, with every CONTINUE after them as one stream.
        const segs = [data.subarray(8)];
        const total = u32(data, 4);
        while (globals[i + 1]?.id === R.CONTINUE) segs.push(globals[++i].data);
        const s = new Stream(segs);
        const out: string[] = [];
        for (let n = 0; n < total && !s.done(); n++) out.push(s.richString());
        shared = out;
      }
    }
    const sheet = sheets.find((s) => s.type === 0) ?? sheets[0];
    if (!sheet || sheet.pos >= w.length) return { ok: false, error: `${name} has no sheets in it.` };

    const isDateXf = (ixfe: number) => {
      const f = xfFormat[ixfe];
      if (f === undefined) return false;
      if (BUILTIN_DATES.has(f)) return true;
      const code = formats.get(f);
      return code ? isDateFormat(code) : false;
    };
    const numberText = (n: number, ixfe: number) => (isDateXf(ixfe) ? (serialToYmd(n, is1904) ?? plainNumber(n)) : plainNumber(n));

    // ── The first sheet's cells ──
    const grid = new Map<number, string[]>();
    let maxRow = -1;
    const put = (row: number, col: number, text: string) => {
      if (col > 255 || row > 65535) return;
      let r = grid.get(row);
      if (!r) {
        if (grid.size >= XLS_MAX_ROWS) throw new XlsRefusal("too-many");
        r = [];
        grid.set(row, r);
      }
      while (r.length < col) r.push("");
      r[col] = text;
      if (row > maxRow) maxRow = row;
    };
    let pendingFormula: { row: number; col: number } | null = null;
    let started = false;
    for (const { id, data } of records(w, sheet.pos)) {
      if (!started) {
        if (id !== R.BOF) throw new XlsRefusal("broken");
        started = true;
        continue;
      }
      if (id === R.EOF) break;
      const row = u16(data, 0);
      const col = u16(data, 2);
      const ixfe = u16(data, 4);
      if (id === R.LABELSST) put(row, col, shared[u32(data, 6)] ?? "");
      else if (id === R.LABEL || id === R.RSTRING) put(row, col, unicodeString(data, 6, biff8));
      else if (id === R.NUMBER) put(row, col, numberText(f64(data, 6), ixfe));
      else if (id === R.RK) put(row, col, numberText(rkValue(i32(data, 6)), ixfe));
      else if (id === R.MULRK) {
        const last = u16(data, data.length - 2);
        for (let c = col, o = 4; c <= last && o + 6 <= data.length - 2; c++, o += 6) put(row, c, numberText(rkValue(i32(data, o + 2)), u16(data, o)));
      } else if (id === R.FORMULA) {
        if (u16(data, 12) === 0xffff) {
          const kind = data[6];
          if (kind === 0) pendingFormula = { row, col };
          else if (kind === 1) put(row, col, data[8] ? "TRUE" : "FALSE");
          else put(row, col, "");
        } else put(row, col, numberText(f64(data, 6), ixfe));
      } else if (id === R.STRING && pendingFormula) {
        put(pendingFormula.row, pendingFormula.col, unicodeString(data, 0, biff8));
        pendingFormula = null;
      } else if (id === R.BOOLERR) put(row, col, data[7] ? "" : data[6] ? "TRUE" : "FALSE");
    }
    const rows: string[][] = [];
    for (let r = 0; r <= maxRow; r++) {
      const cells = grid.get(r);
      if (!cells || !cells.some((c) => String(c ?? "").trim() !== "")) continue;
      rows.push(cells.map((c) => c ?? ""));
    }
    return { ok: true, rows, sheetName: sheet.name || null };
  } catch (e) {
    if (e instanceof XlsRefusal) {
      if (e.why === "encrypted") return { ok: false, error: `${name} is password-protected. Open it in Excel, take the password off (or save a copy as CSV), and drop it again.` };
      if (e.why === "too-many") return { ok: false, error: `${name} has more than ${XLS_MAX_ROWS.toLocaleString("en-US")} rows. Download a shorter date range and drop that.` };
      if (e.why === "no-workbook") return { ok: false, error: `${name} has no Excel workbook inside. Download it again as CSV or Excel and drop that.` };
    }
    return { ok: false, error: `${name} wouldn't open as an Excel file. Download it again as CSV and drop that.` };
  }
}
