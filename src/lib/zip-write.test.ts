import { describe, it, expect } from "vitest";
import * as zlib from "node:zlib";
import { buildZip, crc32 } from "./zip-write";
import { unzip, text } from "@/test/unzip";

const deflate = (b: Uint8Array) => new Uint8Array(zlib.deflateRawSync(b));

describe("CRC-32", () => {
  it("is the zip one: the standard check value, and node:zlib's own answer", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    const bytes = new Uint8Array(5000).map((_, i) => (i * 31 + 7) & 0xff);
    // zlib.crc32 arrived in Node 22.2; the check value above pins the table either way.
    const zcrc = (zlib as unknown as { crc32?: (b: Uint8Array) => number }).crc32;
    if (zcrc) expect(crc32(bytes)).toBe(zcrc(bytes));
  });
});

describe("the zip writer", () => {
  const files = [
    { name: "Summary.csv", data: "Received,1000\r\n".repeat(200) },
    { name: "Résumé ✓.csv", data: "a,b\r\n" },
    { name: "empty.txt", data: "" },
    { name: "bytes.bin", data: new Uint8Array([0, 1, 2, 255, 254]) },
  ];

  it("stored: every entry comes back byte for byte, with its CRC and a UTF-8 name", () => {
    const got = unzip(buildZip(files));
    expect(got.map((e) => e.name)).toEqual(files.map((f) => f.name));
    for (const [i, e] of got.entries()) {
      expect(e.method).toBe(0);
      expect(e.flags & 0x0800).toBe(0x0800);
      const want = typeof files[i].data === "string" ? new TextEncoder().encode(files[i].data as string) : (files[i].data as Uint8Array);
      expect([...e.data]).toEqual([...want]);
      expect(e.crc).toBe(crc32(want));
    }
  });

  it("deflated: a file that shrinks is deflated and inflates back through node:zlib; one that wouldn't is stored", () => {
    const got = unzip(buildZip(files, { deflate }));
    expect(got[0].method).toBe(8);
    expect(text(got[0].data)).toBe(files[0].data);
    expect(got[2].method).toBe(0); // empty: nothing to squeeze
    expect(got[3].method).toBe(0); // five random bytes grow when deflated
    expect([...got[3].data]).toEqual([0, 1, 2, 255, 254]);
  });

  it("the same files and the same time are the same bytes (the DOS time comes from UTC fields)", () => {
    const at = new Date("2026-09-27T18:30:10Z");
    const a = buildZip(files, { deflate, modified: at });
    const b = buildZip(files, { deflate, modified: at });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const v = new DataView(a.buffer);
    const time = v.getUint16(10, true);
    const date = v.getUint16(12, true);
    expect([(date >> 9) + 1980, (date >> 5) & 15, date & 31]).toEqual([2026, 9, 27]);
    expect([time >> 11, (time >> 5) & 63, (time & 31) * 2]).toEqual([18, 30, 10]);
  });

  it("refuses a name that would climb out of the folder, a blank one, or two the same", () => {
    expect(() => buildZip([{ name: "../x.csv", data: "" }])).toThrow(/plain name/);
    expect(() => buildZip([{ name: "", data: "" }])).toThrow(/plain name/);
    expect(() => buildZip([{ name: "a.csv", data: "" }, { name: "a.csv", data: "" }])).toThrow(/two files/);
  });

  it("an empty zip is still a zip (just the end record)", () => {
    const z = buildZip([]);
    expect(z.length).toBe(22);
    expect(unzip(z)).toEqual([]);
  });
});
