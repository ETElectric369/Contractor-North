/**
 * THE FIGURE, DRAWN ON ITS PICTURE (cn-v1160, Measure from the +). The measuring screen's snapshot
 * shows the points and the line and nothing else: the number is not in it (MeasurePlugin.swift hands
 * the meters back beside the JPEG). On a visit the figure rides beside the picture as its caption. On
 * a job's Photos tab a picture is a square tile with no words on it, so an unstamped snapshot is a
 * photo of white dots. Saved to a job, the figure is drawn onto the picture itself (and is in the
 * document's name), so the tile, the lightbox and a download all say what was measured.
 *
 * WHERE IT IS DRAWN is a pure function (stampLayout), so it is tested without a canvas: one band
 * across the picture at the foot of its MIDDLE SQUARE. A Photos tile is a square cut from the middle
 * of the picture (object-cover), and the measuring screen is a tall phone screen, so a band along the
 * very bottom would be cut off every tile. The words are sized from the picture's short side and
 * shrunk until they fit inside that square.
 *
 * NOTHING HERE CAN LOSE THE PICTURE. One that will not decode, a page with no canvas, an encoder that
 * hands nothing back: each returns the file AS IT CAME, the same File, so the caller can tell the
 * figure is not on it and say so instead of claiming it is.
 *
 * The words drawn are a RECORD (English, like the Inspector's stored labels) and arrive already
 * chosen: this file imports no catalog.
 */

/** One line of words on the band: drawn centred on `x`, with its middle on `y`. */
export type StampLine = { text: string; x: number; y: number; size: number };

export type StampLayout = {
  /** The band behind the words: the picture's full width, ending at the foot of its middle square. */
  band: { x: number; y: number; w: number; h: number };
  /** What was measured ("Measured length"), small, over the figure. Null when no label was handed in. */
  label: StampLine | null;
  /** The figure itself ("12 ft 0 in"), large. */
  figure: StampLine;
};

/** How wide `text` draws at `size` pixels. The canvas answers this for real; a test hands its own. */
export type WidthOf = (text: string, size: number) => number;

/** Under these the words are specks: they stop shrinking and may run past the square instead. */
export const MIN_FIGURE_PX = 12;
export const MIN_LABEL_PX = 9;
/** The picture is drawn no larger than this on its long side (the plugin's own snapshot is 1600). */
export const STAMP_MAX_DIM = 2200;

/** A bold sans-serif runs a little over half its size per character: close enough to lay out by
 *  when no canvas is there to measure with. */
export const roughWidth: WidthOf = (text, size) => text.length * size * 0.58;

/** The size `text` is drawn at: the wanted one, or smaller until it fits `room`, never under `min`. */
function fit(text: string, want: number, room: number, min: number, widthOf: WidthOf): number {
  const wide = widthOf(text, want);
  if (!(wide > room)) return Math.max(min, want);
  return Math.max(min, Math.floor((want * room) / wide));
}

/**
 * Where the band and its two lines go on a picture `width` × `height` pixels. Pure: numbers in,
 * numbers out. Everything is whole pixels.
 */
export function stampLayout(width: number, height: number, caption: string, label: string, widthOf: WidthOf = roughWidth): StampLayout {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  // The square a Photos tile cuts from the middle: the words must sit inside it.
  const side = Math.min(w, h);
  const pad = Math.max(4, Math.round(side * 0.035));
  const room = Math.max(1, side - pad * 2);

  const figureSize = fit(caption, Math.round(side / 9), room, MIN_FIGURE_PX, widthOf);
  const said = label.trim();
  const labelSize = said ? fit(said, Math.round(figureSize * 0.45), room, MIN_LABEL_PX, widthOf) : 0;
  const gap = said ? Math.max(2, Math.round(labelSize * 0.4)) : 0;

  const wanted = pad + (said ? labelSize + gap : 0) + figureSize + pad;
  const bandH = Math.min(h, wanted);
  // The foot of the middle square: halfway down plus half the short side. On a wide picture that
  // is the picture's own bottom edge.
  const foot = Math.min(h, Math.round((h + side) / 2));
  const top = Math.max(0, foot - bandH);
  const cx = Math.round(w / 2);

  return {
    band: { x: 0, y: top, w, h: bandH },
    label: said ? { text: said, x: cx, y: top + pad + Math.round(labelSize / 2), size: labelSize } : null,
    figure: { text: caption, x: cx, y: top + bandH - pad - Math.round(figureSize / 2), size: figureSize },
  };
}

/** The band is the app's own dark slate, see-through enough that the picture reads under it. */
const BAND_FILL = "rgba(15, 23, 42, 0.72)";
const INK = "#ffffff";
/** The phone's own face first: the picture is stamped on the phone that took it. */
const FACE = '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif';
const JPEG_QUALITY = 0.9;

type Decoded = { image: CanvasImageSource; w: number; h: number; close?: () => void };

/** The picture as something a canvas can draw, standing the way it was taken; null when it will not decode. */
async function decode(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === "function") {
    // Ask for the picture upright first; an engine that predates the option throws on it, so the
    // plain call is the second try (the same two steps lib/image-prep takes).
    for (const upright of [true, false]) {
      try {
        const bmp = upright ? await createImageBitmap(file, { imageOrientation: "from-image" }) : await createImageBitmap(file);
        return { image: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
      } catch {
        // refused: the next way
      }
    }
  }
  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ image: img, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * The picture with the figure drawn on it, as a JPEG under the picture's own name. `caption` is the
 * figure ("12 ft 0 in"), `label` what was measured ("Measured length"); both are drawn as handed in.
 * Anything that goes wrong returns `file` itself, untouched.
 */
export async function stampFigure(file: File, caption: string, label: string): Promise<File> {
  if (typeof document === "undefined" || !caption.trim()) return file;
  let src: Decoded | null = null;
  try {
    src = await decode(file);
    if (!src || !src.w || !src.h) return file;
    const scale = Math.min(1, STAMP_MAX_DIM / Math.max(src.w, src.h));
    const w = Math.max(1, Math.round(src.w * scale));
    const h = Math.max(1, Math.round(src.h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(src.image, 0, 0, w, h);

    const face = (size: number, weight: number) => `${weight} ${size}px ${FACE}`;
    // Measured at the heavier weight, so the lighter label can only come out narrower than planned.
    const lay = stampLayout(w, h, caption.trim(), label, (text, size) => {
      ctx.font = face(size, 700);
      return ctx.measureText(text).width;
    });
    ctx.fillStyle = BAND_FILL;
    ctx.fillRect(lay.band.x, lay.band.y, lay.band.w, lay.band.h);
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (lay.label) {
      ctx.font = face(lay.label.size, 600);
      ctx.fillText(lay.label.text, lay.label.x, lay.label.y);
    }
    ctx.font = face(lay.figure.size, 700);
    ctx.fillText(lay.figure.text, lay.figure.x, lay.figure.y);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) return file;
    const name = `${file.name.replace(/\.[^.]+$/, "") || "measure"}.jpg`;
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    src?.close?.();
  }
}
