import { describe, it, expect } from "vitest";
import { exifOrientation, jpegHeader, orientationTransform, withProbeTag, PROBE_APP1 } from "./image-prep";

/**
 * Erik, 2026-09-16: "we need to add an auto-rotate to right side up for bills and such because if i
 * want to look at it i have to play the rotate game with my phone." The fix reads the EXIF
 * Orientation tag itself instead of trusting the engine; this file proves that reader on tiny
 * hand-built JPEGs, and the transform table it feeds. The canvas work can't run in node and is not
 * tested here.
 */

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const u16 = (n: number, little: boolean) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
const u32 = (n: number, little: boolean) =>
  little
    ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]
    : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

function segment(marker: number, payload: number[]) {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
}
/** An Exif APP1 whose IFD0 has one entry: Orientation (0x0112), SHORT unless told otherwise. */
function app1(orientation: number, little: boolean, type = 3) {
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(0x2a, little), ...u32(8, little)];
  const value = type === 4 ? u32(orientation, little) : [...u16(orientation, little), 0, 0];
  const ifd = [...u16(1, little), ...u16(0x0112, little), ...u16(type, little), ...u32(1, little), ...value, ...u32(0, little)];
  return segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, ...ifd]);
}
const JFIF = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const XMP = segment(0xe1, [...Array.from("http://ns.adobe.com/xap/1.0/\0", (c) => c.charCodeAt(0)), 0x3c, 0x78]);
const sof = (w: number, h: number, marker = 0xc0) => segment(marker, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
const SOS = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34]; // a scan header and two bytes of "data"
const jpeg = (...parts: number[][]) => new Uint8Array([...SOI, ...parts.flat(), ...EOI]).buffer;
const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

/** A real 4×2 JPEG written by macOS sips (DQT after the SOF, two DHTs, 4:2:0), tagged orientation 6. */
const REAL_O6 = "/9j/4QAiRXhpZgAASUkqAAgAAAABABIBAwABAAAABgAAAAAAAAD/wAARCAACAAQDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/9sAQwEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/90ABAAB/9oADAMBAAIRAxEAPwD+UX48/wDJV/FX/cD/APUb0ev+qT9iX/yrF+jN/wB5m/8AYgvFc/oD9r3/AMrEfpC/94m/9cd4Zn//2Q==";

describe("exifOrientation reads tag 0x0112", () => {
  for (const little of [true, false]) {
    for (const o of [1, 3, 6, 8]) {
      it(`orientation ${o} from a ${little ? "little" : "big"}-endian TIFF`, () => {
        expect(exifOrientation(jpeg(app1(o, little), sof(4, 2), SOS))).toBe(o);
      });
    }
  }
  it("finds the Exif APP1 behind a JFIF APP0 and an XMP APP1, the way a real file lays them out", () => {
    expect(exifOrientation(jpeg(JFIF, XMP, app1(6, true), sof(4, 2), SOS))).toBe(6);
  });
  it("tolerates a LONG-typed value", () => {
    expect(exifOrientation(jpeg(app1(8, false, 4), sof(4, 2), SOS))).toBe(8);
  });
  it("reads a JPEG a real encoder wrote", () => {
    expect(exifOrientation(bytes(REAL_O6))).toBe(6);
  });
});

describe("exifOrientation says null rather than guessing", () => {
  it("a JPEG with no APP1", () => {
    expect(exifOrientation(jpeg(JFIF, sof(4, 2), SOS))).toBeNull();
  });
  it("a PNG", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    expect(exifOrientation(png.buffer)).toBeNull();
  });
  it("an empty buffer", () => {
    expect(exifOrientation(new ArrayBuffer(0))).toBeNull();
  });
  it("a bare SOI", () => {
    expect(exifOrientation(new Uint8Array(SOI).buffer)).toBeNull();
  });
  it("a truncated APP1: every possible cut point returns without throwing, and a cut inside the directory is null", () => {
    const whole = new Uint8Array(jpeg(app1(6, true), sof(4, 2), SOS));
    for (let cut = 0; cut < whole.length; cut++) {
      expect(() => exifOrientation(whole.slice(0, cut).buffer)).not.toThrow();
    }
    // SOI(2) + marker/len(4) + "Exif\0\0"(6) + TIFF header(8) + count(2) + half an entry(6)
    expect(exifOrientation(whole.slice(0, 2 + 4 + 6 + 8 + 2 + 6).buffer)).toBeNull();
    // cut right after the count: the directory is empty as far as the file goes
    expect(exifOrientation(whole.slice(0, 2 + 4 + 6 + 8 + 2).buffer)).toBeNull();
  });
  it("an APP1 whose length claims more than the file holds", () => {
    const b = new Uint8Array(jpeg(app1(6, true), sof(4, 2), SOS));
    b[2 + 2] = 0xff;
    b[2 + 3] = 0xff; // length 65535 — the directory still fits in what exists, so it reads
    expect(exifOrientation(b.buffer)).toBe(6);
    const short = b.slice(0, 2 + 4 + 6 + 8 + 2 + 3);
    expect(() => exifOrientation(short.buffer)).not.toThrow();
    expect(exifOrientation(short.buffer)).toBeNull();
  });
  it("a value outside 1..8", () => {
    expect(exifOrientation(jpeg(app1(0, true), sof(4, 2), SOS))).toBeNull();
    expect(exifOrientation(jpeg(app1(9, false), sof(4, 2), SOS))).toBeNull();
  });
  it("an APP1 that is XMP, not Exif", () => {
    expect(exifOrientation(jpeg(XMP, sof(4, 2), SOS))).toBeNull();
  });
  it("a TIFF with a byte order that is neither II nor MM", () => {
    const b = new Uint8Array(jpeg(app1(6, true), sof(4, 2), SOS));
    b[2 + 4 + 6] = 0x4a; // "JI"
    expect(exifOrientation(b.buffer)).toBeNull();
  });
  it("an APP1 that comes after the scan starts is not a header any more", () => {
    expect(exifOrientation(jpeg(sof(4, 2), SOS, app1(6, true)))).toBeNull();
  });
  it("lost marker sync", () => {
    const b = new Uint8Array(jpeg(JFIF, app1(6, true), sof(4, 2), SOS));
    b[2] = 0x00; // the byte after SOI should be 0xFF
    expect(() => exifOrientation(b.buffer)).not.toThrow();
    expect(exifOrientation(b.buffer)).toBeNull();
  });
});

describe("jpegHeader reads the stored frame size next to the tag", () => {
  it("baseline SOF0", () => {
    expect(jpegHeader(jpeg(JFIF, app1(6, true), sof(4032, 3024), SOS))).toEqual({ orientation: 6, width: 4032, height: 3024 });
  });
  it("progressive SOF2", () => {
    expect(jpegHeader(jpeg(app1(8, false), sof(300, 200, 0xc2), SOS))).toEqual({ orientation: 8, width: 300, height: 200 });
  });
  it("DHT (0xC4) is not a frame header", () => {
    expect(jpegHeader(jpeg(segment(0xc4, [0, 0, 0, 0, 0, 0]), sof(4, 2), SOS))).toEqual({ orientation: null, width: 4, height: 2 });
  });
  it("a frame with no size yet (height 0, DNL) stays null", () => {
    expect(jpegHeader(jpeg(sof(4, 0), SOS)).width).toBeNull();
  });
  it("no SOF, no tag", () => {
    expect(jpegHeader(jpeg(JFIF, SOS))).toEqual({ orientation: null, width: null, height: null });
  });
  it("a JPEG a real encoder wrote (DQT after the SOF)", () => {
    expect(jpegHeader(bytes(REAL_O6))).toEqual({ orientation: 6, width: 4, height: 2 });
  });
  it("not a JPEG", () => {
    expect(jpegHeader(new ArrayBuffer(0))).toEqual({ orientation: null, width: null, height: null });
  });
});

describe("the probe tag", () => {
  it("is one 36-byte APP1 that the reader itself decodes as orientation 6", () => {
    expect(PROBE_APP1.length).toBe(36);
    expect(exifOrientation(new Uint8Array([...SOI, ...PROBE_APP1, ...EOI]).buffer)).toBe(6);
  });
  it("splices onto an untagged JPEG without disturbing its frame", () => {
    const tagged = withProbeTag(jpeg(JFIF, sof(2, 1), SOS));
    expect(jpegHeader(tagged.buffer)).toEqual({ orientation: 6, width: 2, height: 1 });
    // the JFIF is still right behind the probe tag, and the end is still EOI
    expect(Array.from(tagged.subarray(2 + 36, 2 + 36 + 4))).toEqual(JFIF.slice(0, 4));
    expect(Array.from(tagged.subarray(-2))).toEqual(EOI);
  });
});

describe("orientationTransform stands the stored pixels up", () => {
  const map = (t: number[], x: number, y: number) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  const dw = 4;
  const dh = 2;

  it("6 (portrait shot, phone upright): the stored left edge becomes the top, the stored top the right", () => {
    const t = orientationTransform(6, dw, dh);
    expect(map(t, 0, dh / 2)[1]).toBe(0); // left edge → y = 0
    expect(map(t, dw / 2, 0)[0]).toBe(dh); // top edge → x = right side of a dh-wide canvas
  });
  it("8: the stored top edge becomes the left, the stored left edge the bottom", () => {
    const t = orientationTransform(8, dw, dh);
    expect(map(t, dw / 2, 0)[0]).toBe(0);
    expect(map(t, 0, dh / 2)[1]).toBe(dw);
  });
  it("3: a half turn", () => {
    expect(map(orientationTransform(3, dw, dh), 0, 0)).toEqual([dw, dh]);
    expect(map(orientationTransform(3, dw, dh), dw, dh)).toEqual([0, 0]);
  });
  it("2 and 4 are mirrors, 1 and junk are the identity", () => {
    expect(map(orientationTransform(2, dw, dh), 0, 0)).toEqual([dw, 0]);
    expect(map(orientationTransform(4, dw, dh), 0, 0)).toEqual([0, dh]);
    expect(orientationTransform(1, dw, dh)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(orientationTransform(0, dw, dh)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(orientationTransform(9, dw, dh)).toEqual([1, 0, 0, 1, 0, 0]);
  });
  it("every orientation keeps the picture exactly inside its canvas", () => {
    for (let o = 1; o <= 8; o++) {
      const t = orientationTransform(o, dw, dh);
      const corners = [map(t, 0, 0), map(t, dw, 0), map(t, 0, dh), map(t, dw, dh)];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const [cw, ch] = o >= 5 ? [dh, dw] : [dw, dh];
      expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([0, cw, 0, ch]);
    }
  });
});
