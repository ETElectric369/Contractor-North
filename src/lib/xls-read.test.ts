import { describe, expect, it } from "vitest";
import { isDateFormat, readXls, serialToYmd } from "./xls-read";

/**
 * THE OLD EXCEL FORMAT, READ WITH NO LIBRARY (bank download, 2026-09-27). The files here are BUILT
 * in the test, byte by byte, as Excel 97-2003 writes them (a compound file holding a BIFF8
 * "Workbook" stream), from a MADE-UP statement. No real bank file is in this repo.
 */

// ── A tiny BIFF8 writer ────────────────────────────────────────────────────────────────────────

const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const f64 = (n: number) => [...new Uint8Array(new Float64Array([n]).buffer)];
const rec = (id: number, data: number[]) => [...le16(id), ...le16(data.length), ...data];
const latin = (s: string) => [...s].map((c) => c.charCodeAt(0) & 0xff);
const utf16 = (s: string) => [...s].flatMap((c) => le16(c.charCodeAt(0)));
/** XLUnicodeString: cch(2), flags(1), chars (8-bit when every char fits). */
const ustr = (s: string) => {
  const wide = [...s].some((c) => c.charCodeAt(0) > 0xff);
  return [...le16(s.length), wide ? 1 : 0, ...(wide ? utf16(s) : latin(s))];
};

type Cell = { s: string } | { n: number; xf?: number } | { rk: number } | { f: string } | { label: string };

const XF_GENERAL = 17;
const XF_DATE = 16;
const XF_BUILTIN_DATE = 18;

function biff(rows: Cell[][], opts: { splitAt?: number; wideTail?: boolean; filepass?: boolean; mulrkRow?: number[] } = {}): Uint8Array {
  // The shared strings, in first-seen order.
  const shared: string[] = [];
  for (const r of rows) for (const c of r) if ("s" in c && !shared.includes(c.s)) shared.push(c.s);

  const globals: number[] = [];
  globals.push(...rec(0x0809, [...le16(0x0600), ...le16(0x0005), ...le16(0), ...le16(0), ...le32(0), ...le32(0)]));
  if (opts.filepass) globals.push(...rec(0x002f, [0, 0, 1, 0]));
  globals.push(...rec(0x0022, le16(0)));
  globals.push(...rec(0x041e, [...le16(164), ...ustr("mm/dd/yyyy")]));
  for (let i = 0; i < 19; i++) {
    const fmt = i === XF_DATE ? 164 : i === XF_BUILTIN_DATE ? 14 : 0;
    globals.push(...rec(0x00e0, [...le16(0), ...le16(fmt), ...new Array(16).fill(0)]));
  }
  const boundsheetAt = globals.length;
  globals.push(...rec(0x0085, [...le32(0), 0, 0, 5, 0, ...latin("Sheet")]));

  // SST, optionally split inside one string's characters into a CONTINUE.
  const body: number[] = [...le32(shared.length), ...le32(shared.length)];
  let splitPos = -1;
  let tail: number[] = [];
  shared.forEach((s, i) => {
    if (opts.splitAt === i) {
      const half = Math.floor(s.length / 2);
      body.push(...le16(s.length), 0, ...latin(s.slice(0, half)));
      splitPos = body.length;
      // The continuation opens with its own flag byte: 1 = two bytes per character.
      tail = opts.wideTail ? [1, ...utf16(s.slice(half))] : [0, ...latin(s.slice(half))];
    } else if (splitPos >= 0) tail.push(...ustr(s));
    else body.push(...ustr(s));
  });
  globals.push(...rec(0x00fc, body));
  if (splitPos >= 0) globals.push(...rec(0x003c, tail));
  globals.push(...rec(0x000a, []));

  const sheet: number[] = [];
  sheet.push(...rec(0x0809, [...le16(0x0600), ...le16(0x0010), ...le16(0), ...le16(0), ...le32(0), ...le32(0)]));
  rows.forEach((r, ri) => {
    if (opts.mulrkRow && ri === opts.mulrkRow[0]) {
      // Two RK numbers side by side in one MULRK: columns 4 and 5.
      const [, a, b] = opts.mulrkRow;
      sheet.push(...rec(0x00bd, [...le16(ri), ...le16(4), ...le16(XF_GENERAL), ...le32(((a * 100) << 2) | 3), ...le16(XF_GENERAL), ...le32(((b * 100) << 2) | 3), ...le16(5)]));
    }
    r.forEach((c, ci) => {
      const head = [...le16(ri), ...le16(ci)];
      if ("s" in c) sheet.push(...rec(0x00fd, [...head, ...le16(XF_GENERAL), ...le32(shared.indexOf(c.s))]));
      else if ("label" in c) sheet.push(...rec(0x0204, [...head, ...le16(XF_GENERAL), ...ustr(c.label)]));
      else if ("n" in c) sheet.push(...rec(0x0203, [...head, ...le16(c.xf ?? XF_GENERAL), ...f64(c.n)]));
      else if ("rk" in c) sheet.push(...rec(0x027e, [...head, ...le16(XF_GENERAL), ...le32(((Math.round(c.rk * 100) << 2) | 3) >>> 0)]));
      else if ("f" in c) {
        // A formula whose cached value is a string: 0xFFFF in the result's top bytes, then STRING.
        sheet.push(...rec(0x0006, [...head, ...le16(XF_GENERAL), 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...le16(0), ...le32(0), ...le16(0)]));
        sheet.push(...rec(0x0207, ustr(c.f)));
      }
    });
  });
  sheet.push(...rec(0x000a, []));

  const w = [...globals, ...sheet];
  // The sheet's offset in the stream, patched into BOUNDSHEET.
  const at = le32(globals.length);
  for (let i = 0; i < 4; i++) w[boundsheetAt + 4 + i] = at[i];
  return compound(new Uint8Array(w));
}

const END = 0xfffffffe;
const FREE = 0xffffffff;

/** A version-3 compound file (512-byte sectors) holding one stream named "Workbook". */
function compound(stream: Uint8Array): Uint8Array {
  const SS = 512;
  const sectors: Uint8Array[] = [];
  const fat: number[] = [];
  const alloc = (data: Uint8Array) => {
    const start = sectors.length;
    const n = Math.max(1, Math.ceil(data.length / SS));
    for (let i = 0; i < n; i++) {
      const s = new Uint8Array(SS);
      s.set(data.subarray(i * SS, (i + 1) * SS));
      sectors.push(s);
      fat[start + i] = i === n - 1 ? END : start + i + 1;
    }
    return start;
  };
  let rootStart = END;
  let rootSize = 0;
  let miniFatStart = END;
  let miniFatCount = 0;
  let streamStart: number;
  if (stream.length >= 4096) streamStart = alloc(stream);
  else {
    const minis = Math.ceil(stream.length / 64);
    const mini = new Uint8Array(minis * 64);
    mini.set(stream);
    rootStart = alloc(mini);
    rootSize = mini.length;
    const mf = new Uint8Array(SS).fill(0xff);
    const dv = new DataView(mf.buffer);
    for (let i = 0; i < minis; i++) dv.setUint32(i * 4, i === minis - 1 ? END : i + 1, true);
    miniFatStart = alloc(mf);
    miniFatCount = 1;
    streamStart = 0;
  }
  const dir = new Uint8Array(SS);
  const dv = new DataView(dir.buffer);
  const entry = (i: number, name: string, type: number, start: number, size: number, child: number) => {
    const o = i * 128;
    [...name].forEach((c, k) => dv.setUint16(o + k * 2, c.charCodeAt(0), true));
    dv.setUint16(o + 0x40, (name.length + 1) * 2, true);
    dir[o + 0x42] = type;
    dir[o + 0x43] = 1;
    dv.setUint32(o + 0x44, FREE, true);
    dv.setUint32(o + 0x48, FREE, true);
    dv.setUint32(o + 0x4c, child, true);
    dv.setUint32(o + 0x74, start, true);
    dv.setUint32(o + 0x78, size, true);
  };
  entry(0, "Root Entry", 5, rootStart, rootSize, 1);
  entry(1, "Workbook", 2, streamStart, stream.length, FREE);
  const dirStart = alloc(dir);
  const fatAt = sectors.length;
  sectors.push(new Uint8Array(SS));
  fat[fatAt] = 0xfffffffd;
  const fatSector = sectors[fatAt];
  const fdv = new DataView(fatSector.buffer);
  for (let i = 0; i < SS / 4; i++) fdv.setUint32(i * 4, fat[i] ?? FREE, true);

  const head = new Uint8Array(SS);
  const h = new DataView(head.buffer);
  head.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  h.setUint16(0x18, 0x3e, true);
  h.setUint16(0x1a, 3, true);
  h.setUint16(0x1c, 0xfffe, true);
  h.setUint16(0x1e, 9, true);
  h.setUint16(0x20, 6, true);
  h.setUint32(0x2c, 1, true);
  h.setUint32(0x30, dirStart, true);
  h.setUint32(0x38, 4096, true);
  h.setUint32(0x3c, miniFatStart, true);
  h.setUint32(0x40, miniFatCount, true);
  h.setUint32(0x44, END, true);
  h.setUint32(0x48, 0, true);
  for (let i = 0; i < 109; i++) h.setUint32(0x4c + i * 4, i === 0 ? fatAt : FREE, true);
  const out = new Uint8Array(SS * (1 + sectors.length));
  out.set(head);
  sectors.forEach((s, i) => out.set(s, SS * (i + 1)));
  return out;
}

// A made-up checking download: Excel's date cells are numbers (46267 = 2026-09-02).
const HEADER: Cell[] = ["Account Number", "Post Date", "Check", "Description", "Debit", "Credit", "Status", "Balance"].map((s) => ({ s }));
const STATEMENT: Cell[][] = [
  HEADER,
  [{ s: "XXXXX1234" }, { n: 46267, xf: XF_DATE }, { s: "" }, { s: "1111-SHELL 123 ANYTOWN ST" }, { n: 88.45 }, { s: "" }, { s: "Posted" }, { n: 5000 }],
  [{ s: "XXXXX1234" }, { n: 46269, xf: XF_BUILTIN_DATE }, { rk: 1043 }, { s: "CHECK" }, { rk: 640 }, { s: "" }, { s: "Posted" }, { rk: 4405 }],
  [{ s: "XXXXX1234" }, { n: 46268, xf: XF_DATE }, { s: "" }, { label: "DEPOSIT" }, { s: "" }, { n: 1275 }, { f: "Posted" }, { n: 5755 }],
];

describe("readXls: the old Excel format", () => {
  it("reads a small workbook (in the mini stream): shared strings, dates as days, RK, labels, formula text", () => {
    const res = readXls(biff(STATEMENT), "AccountHistory.xls");
    expect(res).toEqual({
      ok: true,
      sheetName: "Sheet",
      rows: [
        ["Account Number", "Post Date", "Check", "Description", "Debit", "Credit", "Status", "Balance"],
        ["XXXXX1234", "2026-09-02", "", "1111-SHELL 123 ANYTOWN ST", "88.45", "", "Posted", "5000"],
        ["XXXXX1234", "2026-09-04", "1043", "CHECK", "640", "", "Posted", "4405"],
        ["XXXXX1234", "2026-09-03", "", "DEPOSIT", "", "1275", "Posted", "5755"],
      ],
    });
  });

  it("reads a big workbook (its own sectors), a shared string split across a CONTINUE, and a MULRK", () => {
    const rows: Cell[][] = [HEADER];
    for (let i = 0; i < 150; i++) {
      rows.push([{ s: "XXXXX1234" }, { n: 46267 + (i % 20), xf: XF_DATE }, { s: "" }, { s: `MERCHANT NUMBER ${i} ANYTOWN` }, { n: 10 + i }, { s: "" }, { s: "Posted" }, { n: 1000 }]);
    }
    const res = readXls(biff(rows, { splitAt: 20 }), "big.xls");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toHaveLength(151);
    expect(res.rows[150][3]).toBe("MERCHANT NUMBER 149 ANYTOWN");
    // Every shared string after the split still lands in its own cell.
    expect(res.rows.slice(1).map((r) => r[3])).toEqual(rows.slice(1).map((r) => (r[3] as { s: string }).s));

    const wide = readXls(biff(STATEMENT, { splitAt: 3, wideTail: true }), "wide.xls");
    expect(wide.ok && wide.rows[0][3]).toBe("Description");
    const mul = readXls(biff([HEADER, [{ s: "XXXXX1234" }, { n: 46267, xf: XF_DATE }, { s: "" }, { s: "FEE" }]], { mulrkRow: [1, 12, 0] }), "m.xls");
    expect(mul.ok && mul.rows[1].slice(4, 6)).toEqual(["12", "0"]);
  });

  it("refuses by name, and says what to do: a password, a file that isn't one, a broken one", () => {
    expect(readXls(biff(STATEMENT, { filepass: true }), "Locked.xls")).toEqual({
      ok: false,
      error: "Locked.xls is password-protected. Open it in Excel, take the password off (or save a copy as CSV), and drop it again.",
    });
    expect(readXls(new TextEncoder().encode("Date,Amount\n"), "fake.xls")).toMatchObject({ ok: false, error: expect.stringMatching(/^fake\.xls isn't an Excel \.xls inside/) });
    const broken = biff(STATEMENT).slice(0, 700);
    expect(readXls(broken, "cut.xls")).toMatchObject({ ok: false, error: expect.stringMatching(/^cut\.xls/) });
  });

  it("knows a date format when it sees one", () => {
    expect(isDateFormat("mm/dd/yyyy")).toBe(true);
    expect(isDateFormat("[$-409]d-mmm-yy;@")).toBe(true);
    expect(isDateFormat('#,##0.00_);[Red](#,##0.00)')).toBe(false);
    expect(isDateFormat('0.00 "days"')).toBe(false);
    expect(serialToYmd(46267)).toBe("2026-09-02");
    expect(serialToYmd(44805, true)).toBe("2026-09-02");
  });
});
