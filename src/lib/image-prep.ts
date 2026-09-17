/**
 * Client-side image normalizer for uploads that get read by AI — and looked at by people.
 * - Converts anything the browser can decode (incl. iPhone HEIC on Safari)
 *   to JPEG, so the vision API never rejects a format.
 * - Downscales huge photos (48MP phone shots) to a size that uploads fast
 *   and stays well under API limits, without losing receipt legibility.
 * - Strips EXIF (audit v921): the re-encode is the strip, and it now runs on EVERY
 *   raster image, because some of these end up in PUBLIC buckets on the org's site.
 * - Stands the picture up: the EXIF Orientation tag is baked into the pixels before the strip
 *   throws it away, so a receipt shot on a phone reads right side up in every viewer.
 * Falls back to the original file if decoding fails.
 */

const MAX_DIM = 2200;
const JPEG_QUALITY = 0.85;
// GIF joins the PDF here: it has no EXIF container to strip, and a canvas re-encode would
// flatten an animation to one frame.
const PASS_THROUGH = ["application/pdf", "image/gif"];
// EVERY OTHER RASTER IMAGE GOES THROUGH THE CANVAS (audit v921). The old early return for
// "already fine" formats handed the phone's ORIGINAL bytes — full EXIF, including the GPS of the
// customer's house — to the uploader, and a normal iPhone JPEG is 1–3MB, so the common case never
// re-encoded. Those bytes land in the PUBLIC branding and lead-uploads buckets, where the
// /object/public/ URL serves the original (only the imgproxy render variant strips metadata).
// The re-encode is the strip. Alpha-carrying formats keep their own container so a transparent
// logo doesn't come back on a black square; everything else becomes JPEG.
const KEEP_CONTAINER: Record<string, string> = { "image/png": "image/png", "image/webp": "image/webp" };

// ─── Which way is up ───────────────────────────────────────────────────────────────────────────
// AUTO-ROTATE TO RIGHT SIDE UP. Erik, 2026-09-16: "we need to add an auto-rotate to right side up
// for bills and such because if i want to look at it i have to play the rotate game with my phone."
// A phone camera stores the sensor's pixels as they lie (sideways for a portrait shot) plus an EXIF
// Orientation tag saying which way is up, and every viewer rotates on the fly. The audit v921 EXIF
// strip pushed every photo through this canvas re-encode, and when the engine decodes WITHOUT
// applying that tag — WebKit's createImageBitmap on a File did exactly that — the output is the
// sideways pixels with the tag gone, so every viewer shows the receipt on its side. Nort's reader
// never noticed (a model reads a sideways receipt fine); a person did. Before v921 the original
// bytes still carried the tag, so the strip is what regressed orientation.
// The fix, in three parts: ask the engine to apply the tag; read the tag ourselves and check whether
// it actually did; if it didn't, turn the picture on the canvas. The pixels come out upright and no
// tag is needed.

/** How much of the file the header scan reads. EXIF (APP1) sits right behind SOI; the frame header
 *  (SOF) follows the APPn segments, and a phone's EXIF + ICC + XMP is a few tens of KB. */
const HEADER_BYTES = 512 * 1024;

export type JpegHeader = {
  /** EXIF tag 0x0112, 1..8; null when absent, malformed, or not a JPEG. */
  orientation: number | null;
  /** The frame size AS STORED (before any turn the tag asks for); null when no SOF was seen. */
  width: number | null;
  height: number | null;
};

/** Tag 0x0112 from a JPEG's EXIF, 1..8, or null (no tag / not a JPEG / malformed). Never throws. */
export function exifOrientation(buffer: ArrayBuffer): number | null {
  return jpegHeader(buffer).orientation;
}

/** Walks the JPEG marker segments up to the scan data: the orientation from the Exif APP1, the
 *  stored frame size from the SOF. Dependency-free; every read is bounds-checked, so a truncated,
 *  malformed, or non-JPEG buffer just yields nulls. */
export function jpegHeader(buffer: ArrayBuffer): JpegHeader {
  const out: JpegHeader = { orientation: null, width: null, height: null };
  try {
    const v = new DataView(buffer);
    const n = v.byteLength;
    if (n < 4 || v.getUint16(0) !== 0xffd8) return out; // no SOI: not a JPEG
    let i = 2;
    while (i + 4 <= n) {
      if (v.getUint8(i) !== 0xff) return out; // lost the marker sync
      const marker = v.getUint8(i + 1);
      if (marker === 0xff) {
        i += 1; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // standalone marker, no length
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return out; // EOI / SOS: the headers are behind us
      const len = v.getUint16(i + 2); // includes its own two bytes
      if (len < 2) return out;
      const start = i + 4;
      const end = Math.min(i + 2 + len, n); // clipped: a truncated segment reads as far as it goes
      if (marker === 0xe1 && out.orientation === null) {
        out.orientation = exifFromApp1(v, start, end);
      } else if (isSof(marker) && out.width === null && end - start >= 5) {
        const h = v.getUint16(start + 1);
        const w = v.getUint16(start + 3);
        if (w && h) {
          out.width = w;
          out.height = h;
        }
      }
      if (out.orientation !== null && out.width !== null) return out;
      i += 2 + len;
    }
  } catch {
    // a read past the end of a malformed file — return whatever was found before it
  }
  return out;
}

/** SOF0–SOF15, minus the three C-markers that aren't frame headers (DHT, JPG, DAC). */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** IFD0 of the TIFF inside an Exif APP1 → tag 0x0112, or null. XMP rides in APP1 too (it starts
 *  with a URL, not "Exif\0\0") and fails the first check. */
function exifFromApp1(v: DataView, start: number, end: number): number | null {
  if (end - start < 14) return null; // "Exif\0\0" + an 8-byte TIFF header
  if (v.getUint32(start) !== 0x45786966 || v.getUint16(start + 4) !== 0) return null;
  const tiff = start + 6;
  const order = v.getUint16(tiff);
  const little = order === 0x4949; // "II" (Intel) — "MM" (Motorola) is big-endian
  if (!little && order !== 0x4d4d) return null;
  if (v.getUint16(tiff + 2, little) !== 0x2a) return null;
  const ifd = tiff + v.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return null;
  const count = v.getUint16(ifd, little);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return null; // the directory runs off the segment (truncated APP1)
    if (v.getUint16(e, little) !== 0x0112) continue;
    const type = v.getUint16(e + 2, little); // 3 = SHORT per the spec; tolerate a LONG
    const value = type === 3 ? v.getUint16(e + 8, little) : type === 4 ? v.getUint32(e + 8, little) : -1;
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/** The standard EXIF table. Given the size the STORED pixels are drawn at (dw×dh), the canvas
 *  transform under which drawImage(src, 0, 0, dw, dh) lands them upright. The canvas itself is
 *  dh×dw for 5–8 (a quarter turn swaps the sides) and dw×dh otherwise. Orientation 1 — and any
 *  value that isn't 2–8 — is the identity. */
export function orientationTransform(
  orientation: number,
  dw: number,
  dh: number,
): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, dw, 0]; // mirrored left-right
    case 3:
      return [-1, 0, 0, -1, dw, dh]; // upside down
    case 4:
      return [1, 0, 0, -1, 0, dh]; // mirrored top-bottom
    case 5:
      return [0, 1, 1, 0, 0, 0]; // transposed
    case 6:
      return [0, 1, -1, 0, dh, 0]; // needs a quarter turn clockwise (a portrait shot, phone upright)
    case 7:
      return [0, -1, -1, 0, dh, dw]; // transversed
    case 8:
      return [0, -1, 1, 0, 0, dw]; // needs a quarter turn counter-clockwise
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

async function bitmapOf(blob: Blob): Promise<ImageBitmap | null> {
  // Say it out loud: the spec's default became "from-image" (apply the tag) in 2023, but engines
  // differed for years, and one that predates the value throws on it — hence the plain call as the
  // second try. Either way the caller MEASURES what came back instead of trusting the option.
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    // the option itself was refused — try without it
  }
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

type Decoded = { src: ImageBitmap | HTMLImageElement; fromImg: boolean; w: number; h: number };

async function decode(file: File): Promise<Decoded | null> {
  const bmp = await bitmapOf(file);
  if (bmp) return { src: bmp, fromImg: false, w: bmp.width, h: bmp.height };
  // createImageBitmap can't do HEIC even on Safari — <img> often can. An <img> is rendered with its
  // orientation applied (CSS image-orientation: from-image has been every engine's default since
  // 2020), so naturalWidth/naturalHeight are the upright size and drawImage from it yields upright
  // pixels: nothing more to do for that path.
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ src: img, fromImg: true, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** An Exif APP1 whose only entry is Orientation = 6 (little-endian TIFF, IFD0 at offset 8).
 *  Test-visible. */
export const PROBE_APP1 = new Uint8Array([
  0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** A JPEG's bytes with PROBE_APP1 spliced in right behind SOI: the same picture, now claiming it
 *  needs a quarter turn. Test-visible. */
export function withProbeTag(jpeg: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const src = new Uint8Array(jpeg);
  const out = new Uint8Array(src.length + PROBE_APP1.length);
  out.set(src.subarray(0, 2), 0);
  out.set(PROBE_APP1, 2);
  out.set(src.subarray(2), 2 + PROBE_APP1.length);
  return out;
}

let probe: Promise<boolean> | null = null;
/** Does this engine's createImageBitmap apply the EXIF tag? Asked once per page, lazily, and only
 *  when a photo's own numbers can't settle it (see tagApplied). A 2×1 JPEG the engine itself just
 *  encoded, tagged orientation 6, comes back 1×2 from an engine that applies the tag and 2×1 from
 *  one that ignores it. When the probe can't run at all the answer is "applied": leaving a photo
 *  as it came (today's behaviour) beats turning an upright one sideways. */
function engineAppliesExif(): Promise<boolean> {
  if (!probe) {
    probe = (async () => {
      try {
        const c = document.createElement("canvas");
        c.width = 2;
        c.height = 1;
        c.getContext("2d")?.fillRect(0, 0, 2, 1);
        const encoded = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/jpeg"));
        if (!encoded) return true;
        const tagged = withProbeTag(await encoded.arrayBuffer());
        const bmp = await bitmapOf(new Blob([tagged], { type: "image/jpeg" }));
        if (!bmp) return true;
        const applied = bmp.width === 1 && bmp.height === 2;
        bmp.close();
        return applied;
      } catch {
        return true;
      }
    })();
  }
  return probe;
}

/** Did the engine bake the tag into the bitmap it handed back? For a quarter-turn tag on a
 *  non-square photo the bitmap's own size says so (stored size = ignored, sides swapped = applied);
 *  a flip or a half turn keeps the size, so those — and a square — ask the one-time probe. */
async function tagApplied(orientation: number, w: number, h: number, hdr: JpegHeader): Promise<boolean> {
  if (orientation >= 5 && hdr.width && hdr.height && hdr.width !== hdr.height) {
    if (w === hdr.width && h === hdr.height) return false;
    if (w === hdr.height && h === hdr.width) return true;
  }
  return engineAppliesExif();
}

async function readHeader(file: File): Promise<JpegHeader> {
  try {
    return jpegHeader(await file.slice(0, HEADER_BYTES).arrayBuffer());
  } catch {
    return { orientation: null, width: null, height: null };
  }
}

/** Does the drawn canvas actually carry transparency? Samples the alpha channel — a fully opaque
 *  PNG (a screenshot, a photo saved as PNG) has no reason to stay PNG. Sampling rather than
 *  scanning every pixel keeps this cheap on a phone; a logo's transparency is never one stray
 *  pixel, so a stride sample finds it. */
function hasAlpha(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // every 40th pixel (stride 160 bytes), plus the edges where a logo's transparency lives
    for (let i = 3; i < data.length; i += 160) if (data[i] < 255) return true;
    return false;
  } catch {
    return true; // tainted canvas or no readback — keep the safe container
  }
}

export async function prepareImageForUpload(file: File): Promise<File> {
  if (PASS_THROUGH.includes(file.type)) return file;

  const [hdr, dec] = await Promise.all([readHeader(file), decode(file)]);
  if (!dec) return file; // can't decode — let the server explain
  const { src, w, h } = dec;
  if (!w || !h) return file;

  // Which way is up. An <img> is already upright (see decode); so is a bitmap the engine oriented.
  const orientation = hdr.orientation ?? 1;
  const upright = orientation === 1 || dec.fromImg || (await tagApplied(orientation, w, h, hdr));
  const turned = !upright && orientation >= 5; // a quarter turn: the canvas takes the swapped sides
  const ow = turned ? h : w;
  const oh = turned ? w : h;

  const scale = Math.min(1, MAX_DIM / Math.max(ow, oh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(ow * scale);
  canvas.height = Math.round(oh * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  if (upright) {
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  } else {
    // The engine handed back the sensor's pixels as stored: draw them at their stored (scaled) size
    // through the transform that stands them up. For 5–8 that size is the canvas's, sides swapped.
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);
    ctx.setTransform(...orientationTransform(orientation, dw, dh));
    ctx.drawImage(src, 0, 0, dw, dh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  if ("close" in src) src.close();

  // KEEP THE ALPHA CONTAINER ONLY WHEN THERE IS ALPHA (audit v921 review blocker). Keeping PNG for
  // every PNG re-encoded photographic screenshots losslessly at ~5-9MB — BIGGER than the original
  // and over the 4MB cap on the public Ask-Nort upload door, and multi-MB PNGs were being pushed
  // into the public branding bucket that serves the marketing site. Transparency is what needs the
  // container; a flat image is always better off as JPEG.
  const wantsAlpha = KEEP_CONTAINER[file.type] && hasAlpha(ctx, canvas);
  const outType = wantsAlpha ? KEEP_CONTAINER[file.type] : "image/jpeg";
  let blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outType, JPEG_QUALITY),
  );
  // Even a transparent source can come back enormous; if the JPEG is smaller and we didn't need
  // the alpha, take it.
  if (blob && wantsAlpha && blob.size > 2_000_000) {
    const asJpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (asJpeg && asJpeg.size < blob.size) blob = asJpeg;
  }
  // A browser that can't ENCODE webp hands back null. Returning the original file would put the
  // EXIF right back, so fall back to PNG — lossless, alpha intact, no metadata.
  if (!blob && outType !== "image/jpeg") {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  }
  if (!blob) return file;

  const type = blob.type || outType;
  const ext = type === "image/png" ? ".png" : type === "image/webp" ? ".webp" : ".jpg";
  const name = file.name.replace(/\.[^.]+$/, "") + ext;
  return new File([blob], name, { type });
}
