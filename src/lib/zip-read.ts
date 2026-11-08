/**
 * A .ZIP, READ IN THE BROWSER, WITH NOTHING ADDED TO THE APP (cn-v1152).
 *
 * Erik dropped his supplier's zip of invoice PDFs on the Bills page and was told what Snap or Note
 * takes instead. A zip is not a kind of paper, it is a bag of them: the one door opens the bag and
 * every file inside goes through the same rules as if he had dropped them one by one.
 *
 * THE WALK CAME OUT OF xlsx-read.ts, which has read a zip since the vendor import (an .xlsx is a zip
 * of XML parts): the central directory from the end record (the table of contents every reader
 * trusts; the local headers can carry zeroed sizes when the writer streamed), then each entry through
 * its local header. It lives here now so one reader serves both, and xlsx-read.ts calls it.
 *
 * ZERO DEPENDENCIES. The one thing plain code can't do is inflate, so the caller passes it in:
 * DecompressionStream('deflate-raw') in the browser (inflateRawInBrowser, iOS 16.4 and later), zlib's
 * inflateRawSync in tests. Every size a zip declares was written by whoever made the file, so the
 * inflate is capped and counts as it goes (InflateTooBig), never trusted.
 *
 * WHAT THE DOOR DOES WITH EACH ENTRY is decided here from its name and flags alone (zipEntryFate):
 *   · a folder, anything under __MACOSX/ (the Finder's shadow files) and a dot-file are skipped
 *     without a word: nobody meant to add them;
 *   · a zip inside the zip is not opened (its line says to unzip that one first);
 *   · an encrypted entry is refused by name: the password is his, not the app's;
 *   · the rest become ordinary Files (openZip), named by their basename and typed by their
 *     extension, so the door that takes a dropped file takes them the same way.
 */

/** Inflate raw DEFLATE data (no zlib header). May be sync (zlib) or async (DecompressionStream).
 *  It must stop once the output passes `maxBytes` and throw InflateTooBig: the sizes a zip declares
 *  are written by whoever made the file, so only counting while inflating stops a zip bomb. */
export type InflateRaw = (bytes: Uint8Array, maxBytes: number) => Uint8Array | Promise<Uint8Array>;

/** Thrown by an InflateRaw that can't run on this device, so the reader can say so by name. */
export class InflateUnavailable extends Error {}
/** Thrown by an InflateRaw whose output passed its maxBytes: stopped mid-inflate, never held whole. */
export class InflateTooBig extends Error {}
/** Thrown by readZipEntry: what stopped this one entry. */
export class ZipRefusal extends Error {
  constructor(public why: "encrypted" | "too-big" | "broken") {
    super(why);
  }
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export type ZipEntry = {
  /** The path inside the zip, as written (folders and all). */
  name: string;
  /** 0 stored, 8 deflated; anything else this reader can't open. */
  method: number;
  /** The general-purpose flags: bit 0 encrypted, bit 11 the name is UTF-8. */
  flags: number;
  compSize: number;
  size: number;
  localOffset: number;
  /** When the file was saved, by the zip's own MS-DOS stamp (local time), as ms since the epoch;
   *  null when the stamp is blank. A CSV taken out of a zip speaks for the day it was saved. */
  modified: number | null;
};

export type ZipDirectory = { ok: true; entries: ZipEntry[] } | { ok: false; why: "not-a-zip" | "zip64" | "broken" };

/** An MS-DOS date and time (2-second steps, local, no zone) → ms since the epoch on this device's clock. */
function dosTimeToMs(time: number, date: number): number | null {
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  if (month < 1 || month > 12 || day < 1) return null;
  const ms = new Date(((date >> 9) & 0x7f) + 1980, month - 1, day, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * THE ZIP'S TABLE OF CONTENTS, read from its end. The end record may sit before a comment of up to
 * 65,535 bytes, so the search walks back that far. A name is decoded as UTF-8 whether or not bit 11
 * says so: the spec's other alphabet (CP437) is the same bytes for the ASCII a file name has in
 * practice. ZIP64 is refused rather than misread: it is a 4 GB download, never a bag of papers.
 */
export function zipDirectory(b: Uint8Array): ZipDirectory {
  const floor = Math.max(0, b.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = b.length - 22; i >= floor; i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, why: "not-a-zip" };
  const count = u16(b, eocd + 10);
  const offset = u32(b, eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) return { ok: false, why: "zip64" };
  const entries: ZipEntry[] = [];
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) return { ok: false, why: "broken" };
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const modified = dosTimeToMs(u16(b, p + 12), u16(b, p + 14));
    const compSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const localOffset = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, flags, compSize, size, localOffset, modified });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries };
}

/**
 * ONE ENTRY'S BYTES, through its local header. Throws ZipRefusal (encrypted, too-big, broken) and
 * lets the inflate's own InflateUnavailable through, so the caller can say which in its own words.
 * `maxBytes` caps what the entry may inflate to, checked against the declared size first and then
 * while inflating: a part that claims 100 bytes and grows past the cap is stopped, never held whole.
 */
export async function readZipEntry(b: Uint8Array, e: ZipEntry, inflate: InflateRaw, maxBytes: number): Promise<Uint8Array> {
  if (e.flags & 1) throw new ZipRefusal("encrypted");
  if (e.size > maxBytes) throw new ZipRefusal("too-big");
  const lo = e.localOffset;
  if (lo + 30 > b.length || u32(b, lo) !== 0x04034b50) throw new ZipRefusal("broken");
  const start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
  // Cut short: the directory promises bytes the file doesn't have (a download that stopped early).
  if (start + e.compSize > b.length) throw new ZipRefusal("broken");
  const data = b.subarray(start, start + e.compSize);
  let raw: Uint8Array;
  if (e.method === 0) raw = data;
  else if (e.method === 8) {
    // A DEFLATE stream can grow about 1,032 times at most; a part that claims more is lying.
    if (e.compSize === 0 && e.size > 0) throw new ZipRefusal("broken");
    try {
      raw = await inflate(data, maxBytes);
    } catch (err) {
      if (err instanceof InflateTooBig) throw new ZipRefusal("too-big");
      throw err;
    }
  } else throw new ZipRefusal("broken");
  if (raw.length > maxBytes) throw new ZipRefusal("too-big");
  return raw;
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

/** The browser's inflate. Throws InflateUnavailable on a device that has none, and InflateTooBig
 *  (after cancelling the stream) the moment the output passes maxBytes, so a zip bomb never fills a
 *  phone's memory. */
export async function inflateRawInBrowser(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (!canInflateRawHere()) throw new InflateUnavailable("deflate-raw");
  const copy = new Uint8Array(bytes); // a plain ArrayBuffer-backed copy for the Blob
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new InflateTooBig("too-big");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// ── THE DOOR'S HALF: a dropped zip becomes the files inside it ────────────────────────────────

/** A zip the browser holds whole to open it: past this, unzip it on the desk. */
export const ZIP_MAX_BYTES = 100 * 1024 * 1024;
/** How many entries one zip may put in the queue; a supplier's month is dozens, never hundreds. */
export const ZIP_MAX_FILES = 200;
/** What one zip may inflate to in all. A bag of real papers never nears it; a crafted one would
 *  fill the device's memory one honest-looking entry at a time. */
export const ZIP_MAX_INFLATED = 200 * 1024 * 1024;

/**
 * A zip, by name or by type. The type alone counts only when the name doesn't claim another kind:
 * a .docx or an .xlsx IS a zip inside, and a device that says so must not have its XML parts
 * spilled out as files.
 */
export function isZipFile(file: { name?: string; type?: string }): boolean {
  const name = String(file?.name ?? "");
  const type = String(file?.type ?? "").toLowerCase();
  if (/\.zip$/i.test(name)) return true;
  return (type === "application/zip" || type === "application/x-zip-compressed") && !/\.[a-z0-9]{1,5}$/i.test(name);
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  ofx: "application/x-ofx",
  qfx: "application/vnd.intu.qfx",
};

/** The type a browser would give a dropped file of this name. Anything else is a plain octet-stream,
 *  so the door refuses it by name exactly as it would the same file dropped on its own. */
export function mimeOfName(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** The file's own name, without the folders it sat in (either slash: old Windows zips wrote backslashes). */
export function zipBasename(name: string): string {
  const parts = name.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? "";
}

export type ZipFate = "file" | "skip" | "nested" | "encrypted";

/** What the door does with one entry, from its name and flags alone; no bytes are read to decide. */
export function zipEntryFate(e: ZipEntry): ZipFate {
  const path = e.name.replace(/\\/g, "/");
  const base = zipBasename(path);
  if (!base || path.endsWith("/") || path.startsWith("__MACOSX/") || path.includes("/__MACOSX/") || base.startsWith(".")) return "skip";
  if (/\.zip$/i.test(base)) return "nested";
  if (e.flags & 1) return "encrypted";
  return "file";
}

export type ZipRefusedWhy = "nested" | "encrypted" | "too-big" | "broken" | "no-inflate";
export type ZipItem = { kind: "file"; name: string; file: File } | { kind: "refused"; name: string; why: ZipRefusedWhy };
export type ZipOpened =
  | { ok: false; why: "not-a-zip" | "zip64" | "broken" }
  | {
      ok: true;
      /** Every entry looked at, in the zip's order: a File to queue, or why this one was turned away. */
      items: ZipItem[];
      /** Folders, the Finder's shadows and dot-files: left out without a word. */
      skipped: number;
      /** Entries past the caps, not looked at. The zip's line says so. */
      left: number;
    };

/**
 * THE BYTES A FILE IS BUILT FROM, copied only when they must be (skeptic #56b). A stored entry is a view
 * into the whole zip (readZipEntry's subarray), and zlib's small outputs are views into its pool: those
 * get their own bytes, so the File owns what it holds and nothing else. A deflated entry the browser
 * inflated is already a fresh buffer of its own and is handed over as it is: on a phone, a second copy
 * of up to 200 MB of inflated bytes is the difference between a zip that opens and a tab that reloads.
 */
export function ownBytes(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  const whole = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength;
  return whole ? (u8 as Uint8Array<ArrayBuffer>) : new Uint8Array(u8);
}

/**
 * OPEN A ZIP INTO FILES. Never throws: a bag that isn't a zip, or can't be read, is a `why`; an entry
 * that can't be opened is its own refused item, and the rest still come through. `maxFile` is the
 * door's own cap on one file (the same cap a dropped file gets), so a part that inflates past it is
 * stopped where it inflates. Each File carries the entry's basename, the type its extension says, and
 * the day the zip says it was saved.
 */
export async function openZip(
  bytes: Uint8Array | ArrayBuffer,
  inflate: InflateRaw,
  opts: { maxFile: number; maxFiles?: number; maxInflated?: number },
): Promise<ZipOpened> {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const maxFiles = opts.maxFiles ?? ZIP_MAX_FILES;
  const maxInflated = opts.maxInflated ?? ZIP_MAX_INFLATED;
  const dir = zipDirectory(b);
  if (!dir.ok) return dir;
  const items: ZipItem[] = [];
  let skipped = 0;
  let left = 0;
  let inflated = 0;
  let full = false;
  for (const e of dir.entries) {
    const fate = zipEntryFate(e);
    if (fate === "skip") {
      skipped++;
      continue;
    }
    // Past a cap, the rest are counted and not opened, in order: never the first 200 by luck.
    if (full || items.length >= maxFiles) {
      full = true;
      left++;
      continue;
    }
    const name = zipBasename(e.name);
    if (fate !== "file") {
      items.push({ kind: "refused", name, why: fate });
      continue;
    }
    if (inflated + Math.min(e.size, opts.maxFile) > maxInflated) {
      full = true;
      left++;
      continue;
    }
    try {
      const data = await readZipEntry(b, e, inflate, opts.maxFile);
      inflated += data.length;
      // Its own bytes for the File: a copy for a view into the zip, the inflated buffer itself otherwise.
      const file = new File([ownBytes(data)], name, e.modified != null ? { type: mimeOfName(name), lastModified: e.modified } : { type: mimeOfName(name) });
      items.push({ kind: "file", name, file });
    } catch (err) {
      const why: ZipRefusedWhy = err instanceof InflateUnavailable ? "no-inflate" : err instanceof ZipRefusal && err.why !== "encrypted" ? err.why : "broken";
      items.push({ kind: "refused", name, why });
    }
  }
  return { ok: true, items, skipped, left };
}
