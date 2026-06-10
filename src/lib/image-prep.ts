/**
 * Client-side image normalizer for uploads that get read by AI.
 * - Converts anything the browser can decode (incl. iPhone HEIC on Safari)
 *   to JPEG, so the vision API never rejects a format.
 * - Downscales huge photos (48MP phone shots) to a size that uploads fast
 *   and stays well under API limits, without losing receipt legibility.
 * Falls back to the original file if decoding fails.
 */

const MAX_DIM = 2200;
const JPEG_QUALITY = 0.85;
const PASS_THROUGH = ["application/pdf"];
const ALREADY_FINE = ["image/jpeg", "image/png", "image/webp", "image/gif"];

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

export async function prepareImageForUpload(file: File): Promise<File> {
  if (PASS_THROUGH.includes(file.type)) return file;

  const needsConvert = !ALREADY_FINE.includes(file.type);
  const needsShrink = file.size > 3 * 1024 * 1024;
  if (!needsConvert && !needsShrink) return file;

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

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) return file;

  const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], name, { type: "image/jpeg" });
}
