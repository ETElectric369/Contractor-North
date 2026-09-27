/**
 * A .ZIP FILE, WITH NOTHING ADDED TO THE APP (the accountant download, 2026-09-27).
 *
 * The accountant's spreadsheet is a zip of XML parts, and "Same Thing As CSV Files" is a zip of one
 * CSV per tab. package.json has no zip library, and a zip is small enough to write by hand: a local
 * header and the bytes for each file, then the central directory (the table of contents every
 * reader trusts), then its end record. xlsx-read.ts is the matching reader.
 *
 * ZERO DEPENDENCIES. Compression is passed in (zlib's deflateRawSync on the server); without it, or
 * when deflating would not make a file smaller, the file is STORED as it is. Every entry carries its
 * CRC-32, and names are UTF-8 (flag bit 11), so "Résumé.csv" reads the same on every machine.
 *
 * Not ZIP64: a download past 4 GB or 65,535 files is refused, never quietly cut.
 */

/** Deflate raw (no zlib header), e.g. `(b) => deflateRawSync(b)` from node:zlib. */
export type DeflateRaw = (bytes: Uint8Array) => Uint8Array;

export type ZipFile = { name: string; data: Uint8Array | string };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3, the zip one): crc32("123456789") is 0xCBF43926. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date (2-second steps, 1980 at the earliest), from the date's own UTC fields so
 *  the same download is the same bytes on any server. */
function dosDateTime(d: Date): { time: number; date: number } {
  const y = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

const FLAG_UTF8 = 0x0800;
const LIMIT = 0xffffffff;

export function buildZip(files: ZipFile[], opts: { deflate?: DeflateRaw; modified?: Date } = {}): Uint8Array {
  if (files.length > 0xffff) throw new Error("too many files for one zip");
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(opts.modified ?? new Date(Date.UTC(1980, 0, 1)));
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = String(f.name ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!name || name.split("/").includes("..")) throw new Error(`a zip entry needs a plain name: "${f.name}"`);
    if (seen.has(name)) throw new Error(`two files named "${name}" in one zip`);
    seen.add(name);
    const nameBytes = enc.encode(name);
    const raw = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (opts.deflate && raw.length > 0) {
      const squeezed = opts.deflate(raw);
      if (squeezed.length < raw.length) {
        method = 8;
        body = squeezed;
      }
    }
    if (raw.length >= LIMIT || body.length >= LIMIT || offset >= LIMIT) throw new Error("the download is too large for one zip");

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed: 2.0 (deflate)
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // made by: 2.0, MS-DOS attributes
    cv.setUint16(6, 20, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    // extra, comment, disk number, internal and external attributes: all zero
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  if (offset + cdSize >= LIMIT) throw new Error("the download is too large for one zip");
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + end.length);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
