import { describe, it, expect } from "vitest";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { buildXlsx, columnLetters, excelDay, xlsxSheetName, xmlEscape, type XlsxSheet } from "./xlsx-write";
import { readXlsx, xmlText } from "./xlsx-read";
import { unzip, text } from "@/test/unzip";

const deflate = (b: Uint8Array) => new Uint8Array(deflateRawSync(b));
const inflate = (b: Uint8Array, max: number) => new Uint8Array(inflateRawSync(b, { maxOutputLength: max + 1 }));

/** Every cell of a worksheet part: its reference, type, style and value (text decoded). */
function cellsOf(xml: string): Map<string, { t: string | null; s: string | null; v: string }> {
  const out = new Map<string, { t: string | null; s: string | null; v: string }>();
  const re = /<c r="([A-Z]+\d+)"((?:\s[a-z]+="[^"]*")*)>([\s\S]*?)<\/c>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs = m[2];
    const t = /\st="([^"]*)"/.exec(attrs)?.[1] ?? null;
    const s = /\ss="([^"]*)"/.exec(attrs)?.[1] ?? null;
    const body = m[3];
    const v = t === "inlineStr" ? xmlText(/<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? "") : (/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
    out.set(m[1], { t, s, v });
  }
  return out;
}

const sheets: XlsxSheet[] = [
  {
    name: "Summary",
    widths: [30, 14],
    rows: [
      { cells: ["ET Test Co — 2026 Q3"], bold: true },
      { cells: ["", "Jul 2026"], bold: true },
      { cells: ["Received", { money: 12503.975 }] },
      { cells: ["Net Profit (before income tax)", { money: -47.44 }], bold: true },
      { cells: ["Owner Hours", 338.64] },
      { cells: ["Paid On", { date: "2026-07-04" }] },
      { cells: ["Not a date", { date: "2026-02-30" }] },
      { cells: ["=HYPERLINK(\"http://x\")", "Tom & Jerry <b>\"quoted\"</b> it's", "bell\u0007here", NaN, null, "", "tab\tand\nline"] },
    ],
  },
  { name: "Costs: A/B [draft]?", rows: [{ cells: ["x"] }] },
  { name: "Costs: A/B [draft]?", rows: [] },
];

describe("the xlsx writer", () => {
  const bytes = buildXlsx(sheets, { deflate });
  const parts = new Map(unzip(bytes).map((e) => [e.name, text(e.data)]));

  it("writes the package parts Excel needs, one worksheet per tab, deflated", () => {
    expect([...parts.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
      "xl/worksheets/sheet3.xml",
    ]);
    expect(unzip(bytes).find((e) => e.name === "xl/worksheets/sheet1.xml")!.method).toBe(8);
    for (const i of [1, 2, 3]) expect(parts.get("[Content_Types].xml")).toContain(`/xl/worksheets/sheet${i}.xml`);
  });

  it("names the tabs by Excel's rules: no []:*?/\\, 31 characters at most, never two the same", () => {
    const names = [...parts.get("xl/workbook.xml")!.matchAll(/<sheet name="([^"]*)"/g)].map((m) => xmlText(m[1]));
    expect(names).toEqual(["Summary", "Costs A B draft", "Costs A B draft (2)"]);
    expect(xlsxSheetName("x".repeat(40))).toHaveLength(31);
    expect(xlsxSheetName("x".repeat(40), new Set(["x".repeat(31)]))).toBe(`${"x".repeat(27)} (2)`);
    expect(xlsxSheetName("  ''  ")).toBe("Sheet");
    expect(xlsxSheetName("summary", new Set(["Summary"]))).toBe("summary (2)");
  });

  it("money is a number with the money format, to the cent; a plain number is a plain number; a date is a real date", () => {
    const c = cellsOf(parts.get("xl/worksheets/sheet1.xml")!);
    expect(c.get("B3")).toEqual({ t: null, s: "2", v: "12503.98" });
    expect(c.get("B4")).toEqual({ t: null, s: "3", v: "-47.44" }); // bold row: money bold
    expect(c.get("B5")).toEqual({ t: null, s: null, v: "338.64" });
    expect(c.get("B6")).toEqual({ t: null, s: "4", v: String(excelDay("2026-07-04")) });
    expect(excelDay("2026-07-04")).toBe(46207);
    expect(excelDay("1900-03-01")).toBe(61);
    // A date that isn't one is said as the text it was, never a wrong day.
    expect(c.get("B7")).toEqual({ t: "inlineStr", s: null, v: "2026-02-30" });
    expect(parts.get("xl/styles.xml")).toContain('<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>');
    expect(parts.get("xl/styles.xml")).toMatch(/<cellXfs count="6">.*numFmtId="4"/);
  });

  it("text is inline text, escaped, with control characters XML can't carry removed; never a formula", () => {
    const xml = parts.get("xl/worksheets/sheet1.xml")!;
    expect(xml).not.toMatch(/<f[ >]/);
    const c = cellsOf(xml);
    expect(c.get("A8")).toEqual({ t: "inlineStr", s: null, v: '=HYPERLINK("http://x")' });
    expect(c.get("B8")!.v).toBe('Tom & Jerry <b>"quoted"</b> it\'s');
    expect(xml).toContain("Tom &amp; Jerry &lt;b&gt;&quot;quoted&quot;&lt;/b&gt; it&apos;s");
    expect(c.get("C8")!.v).toBe("bellhere");
    expect(c.has("D8")).toBe(false); // NaN: empty, never "NaN"
    expect(c.has("E8")).toBe(false);
    expect(c.has("F8")).toBe(false);
    expect(c.get("G8")!.v).toBe("tab\tand\nline");
    expect(xmlEscape("a\u0000b￾c\uD800d")).toBe("abcd");
  });

  it("the app's own reader opens it: the first tab, row by row, as a person would see the text", async () => {
    const r = await readXlsx(bytes, inflate, "ET Test Co 2026 Q3.xlsx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheetName).toBe("Summary");
    expect(r.rows[0]).toEqual(["ET Test Co — 2026 Q3"]);
    expect(r.rows[2]).toEqual(["Received", "12503.98"]);
    expect(r.rows[3]).toEqual(["Net Profit (before income tax)", "-47.44"]);
  });

  it("column widths and the dimension are written; column letters run past Z", () => {
    const xml = parts.get("xl/worksheets/sheet1.xml")!;
    expect(xml).toContain('<col min="1" max="1" width="30" customWidth="1"/>');
    expect(xml).toContain('<dimension ref="A1:G8"/>');
    expect([0, 25, 26, 51, 52, 701, 702].map(columnLetters)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("refuses a workbook with no tabs", () => {
    expect(() => buildXlsx([])).toThrow(/at least one sheet/);
  });
});
