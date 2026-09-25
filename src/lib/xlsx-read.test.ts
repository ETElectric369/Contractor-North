import { describe, expect, it } from "vitest";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { InflateTooBig, InflateUnavailable, readXlsx, sharedStringsOf, sheetRowsOf, xmlText } from "./xlsx-read";

/**
 * The zero-dependency .xlsx reader behind Import A List (vendor import, Phase 1).
 *
 * Every workbook here is BUILT in the test from made-up names: a real customer's vendor file never
 * goes in this repo (it is public). The zip is written the way Excel writes it (deflated parts,
 * a central directory at the end), with switches for the shapes Excel and other writers vary:
 * stored parts, a first sheet that isn't called sheet1.xml, inline strings, gaps between columns.
 */

type Part = { name: string; text: string; stored?: boolean; /** A size the zip CLAIMS, whatever the part really is. */ declaredSize?: number };

/** A minimal, valid zip (CRCs left 0: the reader trusts the central directory, never the CRC). */
function zip(parts: Part[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const name = Buffer.from(p.name, "utf8");
    const raw = Buffer.from(p.text, "utf8");
    const data = p.stored ? raw : deflateRawSync(raw);
    const method = p.stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(p.declaredSize ?? raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(p.declaredSize ?? raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, cdBuf, end]));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A workbook shaped like Excel's: shared strings, one column, a heading in row 1. */
function workbook(
  names: string[],
  opts: { sheetPath?: string; relId?: string; stored?: boolean; extraSheetFirstInZip?: boolean; secondSheetRows?: string[] } = {},
): Uint8Array {
  const sheetPath = opts.sheetPath ?? "worksheets/sheet1.xml";
  const relId = opts.relId ?? "rId1";
  const strings = ["Vendor Name", ...names];
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><dimension ref="A1:A${strings.length}"/><sheetData>${strings
    .map((_, i) => `<row r="${i + 1}" spans="1:1"><c r="A${i + 1}" t="s"><v>${i}</v></c></row>`)
    .join("")}</sheetData></worksheet>`;
  const other = `<?xml version="1.0"?><worksheet ${NS}><sheetData>${(opts.secondSheetRows ?? ["Not This Sheet"])
    .map((t, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${esc(t)}</t></is></c></row>`)
    .join("")}</sheetData></worksheet>`;
  const parts: Part[] = [
    {
      name: "[Content_Types].xml",
      text: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: "_rels/.rels",
      text: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: "xl/workbook.xml",
      text: `<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="Vendors" sheetId="1" r:id="${relId}"/><sheet name="Old" sheetId="2" r:id="rId9"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1_old.xml"/><Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${sheetPath}"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    },
    {
      name: "xl/sharedStrings.xml",
      text: `<?xml version="1.0"?><sst ${NS} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
      stored: opts.stored,
    },
    { name: `xl/${sheetPath}`, text: sheetXml, stored: opts.stored },
    { name: "xl/worksheets/sheet1_old.xml", text: other },
  ];
  if (opts.extraSheetFirstInZip) parts.unshift({ name: "xl/worksheets/sheet0.xml", text: other });
  return zip(parts);
}

const MADE_UP = ["Acme, Inc.", "Granite Peak Plumbing", "Lakeside Windows", "Pine & Oak Door Co", "Maria Delgado", "Zephyr Labs, Inc."];
/** zlib's inflate, capped the way readXlsx asks: it stops past maxBytes instead of inflating it all. */
const inflate = (b: Uint8Array, maxBytes: number) => {
  try {
    return new Uint8Array(inflateRawSync(b, { maxOutputLength: maxBytes + 1 }));
  } catch (e) {
    if (e instanceof RangeError) throw new InflateTooBig("too-big");
    throw e;
  }
};

describe("readXlsx: the first sheet, as rows of text", () => {
  it("reads a deflated workbook: the heading and every made-up name, commas and ampersands intact", async () => {
    const res = await readXlsx(workbook(MADE_UP), inflate, "Vendors.xlsx");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toEqual([["Vendor Name"], ...MADE_UP.map((n) => [n])]);
    expect(res.sheetName).toBe("Vendors");
  });

  it("finds the FIRST sheet through the workbook's relationships, not by the name sheet1.xml", async () => {
    const res = await readXlsx(workbook(["Acme, Inc."], { sheetPath: "worksheets/list.xml", relId: "rId7", extraSheetFirstInZip: true }), inflate, "x.xlsx");
    expect(res.ok && res.rows).toEqual([["Vendor Name"], ["Acme, Inc."]]);
  });

  it("reads stored (uncompressed) parts too", async () => {
    const res = await readXlsx(workbook(["Acme, Inc."], { stored: true }), inflate, "x.xlsx");
    expect(res.ok && res.rows).toEqual([["Vendor Name"], ["Acme, Inc."]]);
  });

  it("accepts an ArrayBuffer as well as bytes", async () => {
    const b = workbook(["Acme, Inc."]);
    const res = await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, inflate, "x.xlsx");
    expect(res.ok).toBe(true);
  });
});

describe("the cells: shared, inline, numbers, gaps", () => {
  it("keeps a skipped column as a gap, so a phone never slides into the email column", () => {
    const xml = `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>5305550100</v></c></row><row r="2"><c r="B2" t="inlineStr"><is><t xml:space="preserve"> Acme </t></is></c></row><row r="3"><c r="A3" s="1"/></row></sheetData></worksheet>`;
    expect(sheetRowsOf(xml, ["Granite Peak Plumbing"])).toEqual([
      ["Granite Peak Plumbing", "", "5305550100"],
      ["", " Acme "],
    ]);
  });

  it("joins rich-text runs, leaves out phonetic guides, and a self-closing <t/> never swallows the next cell", () => {
    const sst = `<sst ${NS}><si><r><t>Pine </t></r><r><rPr><b/></rPr><t>&amp; Oak</t></r><rPh sb="0" eb="1"><t>IGNORE</t></rPh></si><si><t/></si><si><t xml:space="preserve"/></si><si><t>Lakeside Windows</t></si></sst>`;
    expect(sharedStringsOf(sst)).toEqual(["Pine & Oak", "", "", "Lakeside Windows"]);
  });

  it("decodes entities and Excel's _xHHHH_ escapes", () => {
    expect(xmlText("A &amp; B &#233; &#x41; _x000D_")).toBe("A & B é A \r");
  });

  it("booleans read as TRUE/FALSE, errors as blank, and a cell with no reference follows the one before", () => {
    const xml = `<worksheet ${NS}><sheetData><row><c t="b"><v>1</v></c><c t="e"><v>#N/A</v></c><c><v>42</v></c></row></sheetData></worksheet>`;
    expect(sheetRowsOf(xml, [])).toEqual([["TRUE", "", "42"]]);
  });
});

describe("every refusal names the file and says what to do", () => {
  const CFB = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

  it("the old .xls format", async () => {
    expect(await readXlsx(CFB, inflate, "Vendors.xls")).toEqual({ ok: false, error: "Vendors.xls is the old Excel format. Save it as .xlsx or CSV and drop it again." });
  });

  it("a password-protected .xlsx (an OLE file inside, whatever its name)", async () => {
    const res = await readXlsx(CFB, inflate, "Vendors.xlsx");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/^Vendors\.xlsx is password-protected\./);
  });

  it("over 2 MB", async () => {
    const res = await readXlsx(new Uint8Array(2 * 1024 * 1024 + 1), inflate, "Big.xlsx");
    expect(!res.ok && res.error).toMatch(/^Big\.xlsx is over 2 MB\./);
  });

  it("over 1,000 rows", async () => {
    const names = Array.from({ length: 1000 }, (_, i) => `Made Up Vendor ${i + 1}`);
    const res = await readXlsx(workbook(names), inflate, "Long.xlsx");
    expect(!res.ok && res.error).toMatch(/^Long\.xlsx has more than 1,000 rows\./);
  });

  it("not a zip at all", async () => {
    const res = await readXlsx(new TextEncoder().encode("Vendor Name\nAcme"), inflate, "Renamed.xlsx");
    expect(!res.ok && res.error).toMatch(/^Renamed\.xlsx isn't an Excel \.xlsx inside/);
  });

  it("a device that can't inflate (older WebKit): Save it as CSV", async () => {
    const res = await readXlsx(workbook(["Acme, Inc."]), () => {
      throw new InflateUnavailable("deflate-raw");
    }, "Vendors.xlsx");
    expect(res).toEqual({ ok: false, error: "This device can't open .xlsx. Save Vendors.xlsx as CSV and drop that." });
  });

  it("never throws: a broken part is a sentence", async () => {
    const res = await readXlsx(workbook(["Acme, Inc."]), () => {
      throw new Error("invalid stored block lengths");
    }, "Broken.xlsx");
    expect(!res.ok && res.error).toMatch(/^Broken\.xlsx wouldn't open as an Excel file\./);
  });
});

describe("a zip bomb is stopped while it inflates, not after", () => {
  it("a part that CLAIMS 100 bytes but inflates past 40 MB is refused by name, and the inflate is capped", async () => {
    const good = workbook(["Acme, Inc."]);
    expect((await readXlsx(good, inflate, "ok.xlsx")).ok).toBe(true);
    const bomb = zip([
      { name: "_rels/.rels", text: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", text: "<".padEnd(41 * 1024 * 1024, " "), declaredSize: 100 },
    ]);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    let biggest = 0;
    const watched = (b: Uint8Array, max: number) => {
      const out = inflate(b, max);
      biggest = Math.max(biggest, out.length);
      return out;
    };
    const res = await readXlsx(bomb, watched, "Vendors.xlsx");
    expect(res).toEqual({ ok: false, error: "Vendors.xlsx is too large inside to be a vendor list. Save just the list as its own .xlsx or CSV." });
    expect(biggest).toBeLessThanOrEqual(40 * 1024 * 1024);
  });
});
