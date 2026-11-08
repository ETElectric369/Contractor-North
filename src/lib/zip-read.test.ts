import { describe, it, expect, vi, afterEach } from "vitest";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { buildZip } from "./zip-write";
import {
  InflateTooBig,
  ZIP_MAX_FILES,
  ZipRefusal,
  canInflateRawHere,
  inflateRawInBrowser,
  isZipFile,
  mimeOfName,
  openZip,
  ownBytes,
  readZipEntry,
  zipBasename,
  zipDirectory,
  zipEntryFate,
  type ZipEntry,
} from "./zip-read";
import { withDeclaredSize, withEncryptedEntry, withZipComment } from "@/test/zip-fixtures";

/**
 * The zero-dependency zip reader behind the zip door (cn-v1152) and, through xlsx-read.ts, the vendor
 * import. Every zip here is BUILT in the test with zip-write.ts and patched for the shapes it never
 * writes; the names are stand-ins. Node 22 has DecompressionStream, so the browser's own inflate is
 * exercised here beside zlib's.
 */

const deflate = (b: Uint8Array) => new Uint8Array(deflateRawSync(b));
/** zlib's inflate, capped the way the reader asks: it stops past maxBytes instead of inflating it all. */
const zlibInflate = (b: Uint8Array, maxBytes: number) => {
  try {
    return new Uint8Array(inflateRawSync(b, { maxOutputLength: maxBytes + 1 }));
  } catch (e) {
    if (e instanceof RangeError) throw new InflateTooBig("too-big");
    throw e;
  }
};
const text = (u: Uint8Array) => new TextDecoder().decode(u);
/** A PDF by its first bytes, long enough that deflate shrinks it (a tiny one is stored as it is). */
const PDF = (tag: string) => `%PDF-1.7\n${tag}\n${"stream ".repeat(40)}`;
const CAP = 15 * 1024 * 1024;
const entriesOf = (zip: Uint8Array): ZipEntry[] => {
  const dir = zipDirectory(zip);
  if (!dir.ok) throw new Error(dir.why);
  return dir.entries;
};
const whyOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ZipRefusal ? e.why : (e as Error).constructor.name;
  }
};

afterEach(() => vi.unstubAllGlobals());

describe("the walk: the directory, then each entry", () => {
  const files = [
    { name: "inv-001.pdf", data: PDF("one") },
    { name: "tiny.csv", data: "a,b\n" },
    { name: "bytes.bin", data: new Uint8Array([0, 1, 2, 255, 254]) },
  ];

  it("stored and deflated entries read back byte for byte, through zlib and through the browser's DecompressionStream", async () => {
    const zip = buildZip(files, { deflate });
    const entries = entriesOf(zip);
    expect(entries.map((e) => [e.name, e.method])).toEqual([
      ["inv-001.pdf", 8],
      ["tiny.csv", 0],
      ["bytes.bin", 0],
    ]);
    expect(canInflateRawHere()).toBe(true);
    for (const inflate of [zlibInflate, inflateRawInBrowser]) {
      expect(text(await readZipEntry(zip, entries[0], inflate, CAP))).toBe(PDF("one"));
      expect(text(await readZipEntry(zip, entries[1], inflate, CAP))).toBe("a,b\n");
      expect([...(await readZipEntry(zip, entries[2], inflate, CAP))]).toEqual([0, 1, 2, 255, 254]);
    }
  });

  it("a trailing zip comment is walked past", async () => {
    const zip = withZipComment(buildZip(files, { deflate }), "made on a stand-in's desk, 2026");
    const entries = entriesOf(zip);
    expect(entries.map((e) => e.name)).toEqual(["inv-001.pdf", "tiny.csv", "bytes.bin"]);
    expect(text(await readZipEntry(zip, entries[0], zlibInflate, CAP))).toBe(PDF("one"));
  });

  it("a name is UTF-8 (flag bit 11), and the saved time is the zip's own stamp on this device's clock", () => {
    const zip = buildZip([{ name: "bills/Résumé ✓.pdf", data: PDF("x") }], { modified: new Date(Date.UTC(2026, 8, 27, 18, 30, 10)) });
    const [e] = entriesOf(zip);
    expect(e.name).toBe("bills/Résumé ✓.pdf");
    expect(e.flags & 0x0800).toBe(0x0800);
    expect(e.modified).toBe(new Date(2026, 8, 27, 18, 30, 10).getTime());
  });

  it("not a zip, a zip cut short, a broken directory and ZIP64 are each refused by why", () => {
    expect(zipDirectory(new TextEncoder().encode("%PDF-1.7 not a zip at all, whatever its name"))).toEqual({ ok: false, why: "not-a-zip" });
    const zip = buildZip(files, { deflate });
    expect(zipDirectory(zip.subarray(0, zip.length - 5))).toEqual({ ok: false, why: "not-a-zip" });
    const wrongOffset = new Uint8Array(zip);
    new DataView(wrongOffset.buffer).setUint32(zip.length - 22 + 16, 7, true);
    expect(zipDirectory(wrongOffset)).toEqual({ ok: false, why: "broken" });
    const zip64 = new Uint8Array(zip);
    new DataView(zip64.buffer).setUint32(zip.length - 22 + 16, 0xffffffff, true);
    expect(zipDirectory(zip64)).toEqual({ ok: false, why: "zip64" });
  });

  it("an encrypted entry, one past the cap, one whose bytes are missing and a lying part are each refused where they are", async () => {
    const zip = buildZip(files, { deflate });
    const locked = withEncryptedEntry(zip, "inv-001.pdf");
    expect(entriesOf(locked)[0].flags & 1).toBe(1);
    expect(await whyOf(readZipEntry(locked, entriesOf(locked)[0], zlibInflate, CAP))).toBe("encrypted");
    // The declared size is checked before a byte inflates.
    expect(await whyOf(readZipEntry(zip, entriesOf(zip)[1], zlibInflate, 3))).toBe("too-big");
    // A directory that promises more bytes than the file has (a download that stopped early).
    const cut = entriesOf(zip).map((e) => ({ ...e, compSize: 0x7ffffff }));
    expect(await whyOf(readZipEntry(zip, cut[1], zlibInflate, CAP))).toBe("broken");
    // A part that CLAIMS 100 bytes and inflates past the cap is stopped mid-inflate, by either inflate.
    const bomb = withDeclaredSize(buildZip([{ name: "big.csv", data: " ".repeat(2 * 1024 * 1024) }], { deflate }), "big.csv", 100);
    expect(bomb.length).toBeLessThan(10 * 1024);
    for (const inflate of [zlibInflate, inflateRawInBrowser]) {
      expect(await whyOf(readZipEntry(bomb, entriesOf(bomb)[0], inflate, 64 * 1024))).toBe("too-big");
    }
  });
});

describe("the door's half: a zip becomes the files inside it", () => {
  const stamp = new Date(Date.UTC(2026, 10, 7, 9, 15, 0));
  const bag = () =>
    buildZip(
      [
        { name: "bills/", data: "" },
        { name: "__MACOSX/._inv-001.pdf", data: "junk" },
        { name: "bills/.DS_Store", data: "junk" },
        { name: "bills/inv-001.pdf", data: PDF("one") },
        { name: "bills/more.zip", data: "PK" },
        { name: "bills/statement.csv", data: "a,b\n" },
        { name: "bills/notes.docx", data: "PK" },
      ],
      { deflate, modified: stamp },
    );

  it("folders, __MACOSX and dot-files are skipped without a word; a zip inside is reported; the rest are Files with their basename, their type and their day", async () => {
    const opened = await openZip(bag(), inflateRawInBrowser, { maxFile: CAP });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.skipped).toBe(3);
    expect(opened.left).toBe(0);
    expect(opened.items.map((i) => (i.kind === "file" ? [i.name, i.file.type] : [i.name, i.why]))).toEqual([
      ["inv-001.pdf", "application/pdf"],
      ["more.zip", "nested"],
      ["statement.csv", "text/csv"],
      ["notes.docx", "application/octet-stream"],
    ]);
    const first = opened.items[0];
    if (first.kind !== "file") throw new Error("expected a file");
    expect(text(new Uint8Array(await first.file.arrayBuffer()))).toBe(PDF("one"));
    expect(first.file.name).toBe("inv-001.pdf");
    expect(first.file.lastModified).toBe(new Date(2026, 10, 7, 9, 15, 0).getTime());
    // A stored entry (too small to shrink) reads back whole too: its File got bytes of its own, not a view into the zip.
    const stored = opened.items[2];
    if (stored.kind !== "file") throw new Error("expected a file");
    expect(text(new Uint8Array(await stored.file.arrayBuffer()))).toBe("a,b\n");
  });

  it("the bytes a File is built from: a view into a bigger buffer gets its own copy, a buffer already its own is handed over as it is (skeptic #56b: no second copy of 200 MB on a phone)", async () => {
    const zip = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = zip.subarray(2, 5);
    const copy = ownBytes(view);
    expect([...copy]).toEqual([3, 4, 5]);
    expect(copy.buffer).not.toBe(zip.buffer);
    expect(copy.buffer.byteLength).toBe(3);
    const own = new Uint8Array([7, 8, 9]);
    expect(ownBytes(own)).toBe(own);
    // What the browser's inflate hands over is already its own, so a deflated entry is never copied on the way to its File.
    const inflated = await inflateRawInBrowser(deflate(new TextEncoder().encode(PDF("x"))), CAP);
    expect(ownBytes(inflated)).toBe(inflated);
  });

  it("an encrypted entry is reported by name and the rest still open", async () => {
    const opened = await openZip(withEncryptedEntry(bag(), "bills/inv-001.pdf"), zlibInflate, { maxFile: CAP });
    expect(opened.ok && opened.items.map((i) => [i.name, i.kind === "file" ? "file" : i.why])).toEqual([
      ["inv-001.pdf", "encrypted"],
      ["more.zip", "nested"],
      ["statement.csv", "file"],
      ["notes.docx", "file"],
    ]);
  });

  it("past the cap on files, the first ones are opened and the rest are counted, never dropped quietly", async () => {
    const many = buildZip(Array.from({ length: ZIP_MAX_FILES + 3 }, (_, i) => ({ name: `inv-${String(i + 1).padStart(3, "0")}.csv`, data: "a,b\n" })));
    const opened = await openZip(many, zlibInflate, { maxFile: CAP });
    expect(opened.ok && [opened.items.length, opened.left]).toEqual([ZIP_MAX_FILES, 3]);
    expect(opened.ok && opened.items[0].name).toBe("inv-001.csv");
    const two = await openZip(many, zlibInflate, { maxFile: CAP, maxFiles: 2 });
    expect(two.ok && [two.items.length, two.left]).toEqual([2, ZIP_MAX_FILES + 1]);
  });

  it("past what one zip may inflate to in all, the rest are counted too", async () => {
    const zip = buildZip([
      { name: "a.csv", data: "12345678" },
      { name: "b.csv", data: "12345678" },
      { name: "c.csv", data: "12345678" },
    ]);
    const opened = await openZip(zip, zlibInflate, { maxFile: CAP, maxInflated: 10 });
    expect(opened.ok && [opened.items.map((i) => i.name), opened.left]).toEqual([["a.csv"], 2]);
  });

  it("a file past the door's own cap is refused where it is, by its declared size, and the others still open", async () => {
    const opened = await openZip(bag(), zlibInflate, { maxFile: 20 });
    expect(opened.ok && opened.items.map((i) => [i.name, i.kind === "file" ? "file" : i.why])).toEqual([
      ["inv-001.pdf", "too-big"],
      ["more.zip", "nested"],
      ["statement.csv", "file"],
      ["notes.docx", "file"],
    ]);
  });

  it("a browser with no DecompressionStream: stored entries still open, a deflated one is refused as no-inflate", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    expect(canInflateRawHere()).toBe(false);
    const zip = buildZip([{ name: "stored.pdf", data: "%PDF-1.7 x" }, { name: "deflated.pdf", data: PDF("long") }], { deflate });
    expect(entriesOf(zip).map((e) => e.method)).toEqual([0, 8]);
    const opened = await openZip(zip, inflateRawInBrowser, { maxFile: CAP });
    expect(opened.ok && opened.items.map((i) => [i.name, i.kind === "file" ? "file" : i.why])).toEqual([
      ["stored.pdf", "file"],
      ["deflated.pdf", "no-inflate"],
    ]);
  });

  it("an empty zip is a zip with nothing in it; a non-zip and a broken one are refused by why", async () => {
    expect(await openZip(buildZip([]), zlibInflate, { maxFile: CAP })).toEqual({ ok: true, items: [], skipped: 0, left: 0 });
    expect(await openZip(new TextEncoder().encode("hello"), zlibInflate, { maxFile: CAP })).toEqual({ ok: false, why: "not-a-zip" });
    const zip = buildZip([{ name: "a.csv", data: "a" }]);
    const zip64 = new Uint8Array(zip);
    new DataView(zip64.buffer).setUint32(zip.length - 22 + 16, 0xffffffff, true);
    expect(await openZip(zip64, zlibInflate, { maxFile: CAP })).toEqual({ ok: false, why: "zip64" });
  });

  it("a damaged entry is its own refusal: the rest still come through", async () => {
    const zip = buildZip([{ name: "a.csv", data: "a,b\n" }, { name: "b.pdf", data: PDF("b") }], { deflate });
    // The deflated entry's bytes replaced by noise: the inflate fails, and that is one entry's story.
    const noisy = new Uint8Array(zip);
    const b = entriesOf(zip)[1];
    const start = b.localOffset + 30 + "b.pdf".length;
    for (let i = 0; i < b.compSize; i++) noisy[start + i] = 0xff;
    const opened = await openZip(noisy, zlibInflate, { maxFile: CAP });
    expect(opened.ok && opened.items.map((i) => [i.name, i.kind === "file" ? "file" : i.why])).toEqual([
      ["a.csv", "file"],
      ["b.pdf", "broken"],
    ]);
  });
});

describe("names and kinds", () => {
  it("a zip by its name, or by its type when the name claims no other kind", () => {
    expect(isZipFile({ name: "larkspur-bills.zip", type: "" })).toBe(true);
    expect(isZipFile({ name: "BILLS.ZIP", type: "application/octet-stream" })).toBe(true);
    expect(isZipFile({ name: "archive", type: "application/zip" })).toBe(true);
    expect(isZipFile({ name: "archive", type: "application/x-zip-compressed" })).toBe(true);
    // An .xlsx or a .docx IS a zip inside; a device that says so must not have its parts spilled out.
    expect(isZipFile({ name: "vendors.xlsx", type: "application/zip" })).toBe(false);
    expect(isZipFile({ name: "notes.docx", type: "application/zip" })).toBe(false);
    expect(isZipFile({ name: "bill.pdf", type: "application/pdf" })).toBe(false);
  });

  it("the type a browser would give the name; anything else is a plain octet-stream", () => {
    expect(["inv.pdf", "a.JPG", "b.jpeg", "c.png", "d.webp", "e.heic", "f.HEIF", "g.gif", "h.csv", "i.xlsx", "j.xls", "k.ofx", "l.qfx", "m.docx", "noext"].map(mimeOfName)).toEqual([
      "application/pdf",
      "image/jpeg",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "image/gif",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/x-ofx",
      "application/vnd.intu.qfx",
      "application/octet-stream",
      "application/octet-stream",
    ]);
  });

  it("the basename, through either slash, and each entry's fate from its name and flags alone", () => {
    expect(zipBasename("bills/2026/inv-001.pdf")).toBe("inv-001.pdf");
    expect(zipBasename("bills\\inv-001.pdf")).toBe("inv-001.pdf");
    const e = (name: string, flags = 0x0800): ZipEntry => ({ name, method: 0, flags, compSize: 0, size: 0, localOffset: 0, modified: null });
    expect(zipEntryFate(e("bills/"))).toBe("skip");
    expect(zipEntryFate(e("__MACOSX/._inv.pdf"))).toBe("skip");
    expect(zipEntryFate(e("bills/__MACOSX/._inv.pdf"))).toBe("skip");
    expect(zipEntryFate(e("bills/.DS_Store"))).toBe("skip");
    expect(zipEntryFate(e(""))).toBe("skip");
    expect(zipEntryFate(e("bills/more.ZIP"))).toBe("nested");
    expect(zipEntryFate(e("bills/inv.pdf", 0x0801))).toBe("encrypted");
    expect(zipEntryFate(e("bills/inv.pdf"))).toBe("file");
    expect(zipEntryFate(e("bills\\inv.pdf"))).toBe("file");
  });
});
