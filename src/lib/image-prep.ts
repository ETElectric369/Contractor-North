/**
 * Client-side image normalizer for uploads that get read by AI.
 * - Converts anything the browser can decode (incl. iPhone HEIC on Safari)
 *   to JPEG, so the vision API never rejects a format.
 * - Downscales huge photos (48MP phone shots) to a size that uploads fast
 *   and stays well under API limits, without losing receipt legibility.
 * - Strips EXIF (audit v921): the re-encode is the strip, and it now runs on EVERY
 *   raster image, because some of these end up in PUBLIC buckets on the org's site.
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

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
  try {
    return await createImageBitmap(file);
  } catch {
    // createImageBitmap can't do HEIC even on Safari — <img> often can.
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
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

  const src = await decode(file);
  if (!src) return file; // can't decode — let the server explain

  const w = "width" in src ? src.width : (src as HTMLImageElement).naturalWidth;
  const h = "height" in src ? src.height : (src as HTMLImageElement).naturalHeight;
  if (!w || !h) return file;

  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(src as any, 0, 0, canvas.width, canvas.height);
  if ("close" in src) (src as ImageBitmap).close();

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
