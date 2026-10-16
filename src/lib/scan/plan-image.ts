"use client";

/**
 * THE PLAN AS A PICTURE. The SVG from plan-svg is drawn onto a canvas and handed over as a PNG
 * File, so it lands in the photo grid, the lightbox, the estimate and the portal like any photo
 * (image-prep keeps a PNG a PNG — the lines stay crisp). Where the canvas cannot draw it (an old
 * engine, a tainted canvas), the SVG itself is the file: still a picture, never nothing.
 */
export async function planImageFile(svg: string, name: string, scale = 2): Promise<File> {
  const svgFile = new File([svg], `${name}.svg`, { type: "image/svg+xml" });
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof Image === "undefined") return svgFile;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("svg did not decode"));
      i.src = url;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return svgFile;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return svgFile;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return svgFile;
    return new File([blob], `${name}.png`, { type: "image/png" });
  } catch {
    return svgFile;
  } finally {
    URL.revokeObjectURL(url);
  }
}
