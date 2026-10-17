/**
 * STORAGE'S REFUSAL IN PLAIN WORDS.
 *
 * The bucket answers a file over its limit with its own sentence, "The object exceeded the maximum
 * allowed size" (a 413), and a dead connection comes back as the browser's "Failed to fetch" or
 * "Load failed". Erik, the night the first whole-room 3D model went up (2026-10-16): the Inspector
 * showed storage's sentence as it came, then offered to send the same file again, a dead end since
 * the size never changes. A refusal that is FINAL says so, names ONE action (the caller's: a smaller
 * walk, a smaller file), and the door drops the copy it kept; one that is the signal's keeps the
 * file for another tap where there's service.
 */
export type UploadRefusal = { sentence: string; final: boolean };

const TOO_BIG = /exceeded the maximum allowed size|payload too large|entity too large/i;
const NO_SIGNAL = /failed to fetch|load failed|networkerror|network request failed/i;

/** `what` leads the sentence ("The 3D model", a photo's name); `bytes` is what was sent; `action` is the one thing to do when it is over the limit. */
export function uploadRefusal(e: unknown, o: { what: string; bytes: number; action: string }): UploadRefusal {
  const err = e as { message?: unknown; statusCode?: unknown; status?: unknown } | null;
  const msg = typeof err?.message === "string" ? err.message.trim() : "";
  // The code as well as the words, so a rewording by storage still reads as the size.
  const code = String(err?.statusCode ?? err?.status ?? "");
  if (code === "413" || TOO_BIG.test(msg)) return { sentence: `${o.what} is too big to send (${megabytes(o.bytes)} MB). ${o.action}`, final: true };
  if (NO_SIGNAL.test(msg)) return { sentence: `${o.what} didn't go: no signal. Try again where there's service.`, final: false };
  return { sentence: msg || "Upload failed.", final: false };
}

/** 62 for a model, 7.5 or 0.4 for a smaller file: one decimal under ten. */
export function megabytes(bytes: number): number {
  const n = Math.max(0, bytes) / 1_000_000;
  return n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
}
