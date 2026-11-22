/**
 * A BUG REPORT'S PICTURE, IN THE ROW (cn-v1175, migration 0412). The owner, 2026-11-21: "if you cant
 * open screenshots from the bug reports then that needs to be fixed right?"; and, on hearing the row
 * would keep a reduced version: "i thought we had the screenshot in the bug report from the start only
 * for your eyes so it seems strange to me that hasnt been working this whole time and now its a
 * provisional tiny versions of it, just sayin".
 *
 * The screenshot is a file in a private bucket, and the row keeps only its path, so a plain read of
 * the row showed no picture. The reporter now also sends the SAME capture as a JPEG data URL, and the
 * row keeps it in screenshot_copy. It is the picture, as good as the file: drawn at the capture's own
 * width first, and narrower only when it would not fit the cap.
 *
 * ONE RULE, read on both sides: the client's size loop (pickCopy) stops at the cap, the server
 * (cleanCopy) drops anything that is not a JPEG data URL under the cap, and 0412's check is the floor
 * under both. A copy that fails is DROPPED, never a reason to refuse the report.
 *
 * Pure: no browser, no server, no word catalog.
 */

export const COPY_PREFIX = "data:image/jpeg;base64,";
/** 0412's check: about 220 KB of JPEG. */
export const COPY_MAX_CHARS = 300_000;

/** A step of the size loop: a width (null = the capture's own) and a JPEG quality. */
export type CopyStep = { width: number | null; quality: number };

/** The tries, in order: the capture's own width at its own quality, then lower quality, then narrower. */
export const COPY_STEPS: readonly CopyStep[] = [
  { width: null, quality: 0.6 },
  { width: null, quality: 0.45 },
  { width: 640, quality: 0.45 },
  { width: 480, quality: 0.4 },
];

/**
 * HOW BIG THE CAPTURE IS DRAWN (html2canvas' scale). At 0.6 a phone's 390-px screen came out 234
 * pixels wide, which nobody can read. So: 640 / the screen's width, kept between 0.6 and 1 (a phone
 * at 1, a tablet a little under, a desktop at 0.6 as before). A width that is not a positive number
 * gets 0.6.
 */
export function captureScale(innerWidth: number): number {
  if (!Number.isFinite(innerWidth) || innerWidth <= 0) return 0.6;
  return Math.min(1, Math.max(0.6, 640 / innerWidth));
}

/** Is this something the row may keep? A JPEG data URL with something after the prefix, under the cap. */
export function isCopy(v: unknown): v is string {
  return typeof v === "string" && v.length > COPY_PREFIX.length && v.length <= COPY_MAX_CHARS && v.startsWith(COPY_PREFIX);
}

/** The server's check: the copy to write, or null (dropped, never refused). */
export function cleanCopy(v: unknown): string | null {
  return isCopy(v) ? v : null;
}

/**
 * THE SIZE LOOP. `encode(width, quality)` draws the capture at that width (never wider than the
 * capture itself) and returns its data URL, or null when it could not. The first try that fits wins;
 * none, and no copy is sent (the file and the report go on without it).
 */
export function pickCopy(
  sourceWidth: number,
  encode: (width: number, quality: number) => string | null,
  steps: readonly CopyStep[] = COPY_STEPS,
): string | null {
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) return null;
  const seen = new Set<string>();
  for (const s of steps) {
    const width = Math.max(1, Math.round(Math.min(sourceWidth, s.width ?? sourceWidth)));
    const key = `${width}@${s.quality}`;
    if (seen.has(key)) continue; // a narrow capture makes two steps the same: draw it once
    seen.add(key);
    let url: string | null = null;
    try {
      url = encode(width, s.quality);
    } catch {
      url = null;
    }
    if (isCopy(url)) return url;
  }
  return null;
}

/**
 * The write named 0412's column and the database does not have it yet (the code landed before the
 * migration): Postgres' undefined_column (42703), PostgREST's "not in the schema cache" (PGRST204),
 * or the same words naming the column. Anything else is a real failure.
 */
export function isCopyColumnMissing(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? "");
  if (code === "42703" || code === "PGRST204") return true;
  return /screenshot_copy/i.test(msg) && /does not exist|could not find/i.test(msg);
}

/** 0412's check refused the copy (23514 naming its constraint): drop it and file the report. */
export function isCopyRefused(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return String(e?.code ?? "") === "23514" && /screenshot_copy/i.test(String(e?.message ?? ""));
}
