/**
 * WHEN A SERVER ACTION THROWS INSTEAD OF ANSWERING (audit v994, SI2).
 *
 * A server action that loses its connection (one bar in a basement, a phone that slept mid-save)
 * does not return `{ ok: false }`: its promise REJECTS. A door that only reads `res.ok` then either
 * throws into the error boundary (the page is replaced and a typed amount, a note or a job pick is
 * lost) or never clears its busy flag (the row greys out until reload, with nothing said).
 *
 * The sentence is careful NOT to claim nothing saved. A lost RESPONSE can hide a write that
 * committed, so "try again" alone is how one cost is recorded twice. It says "may not have" and
 * points at the list, which is where the truth is.
 */
export const LOST_SIGNAL_MAYBE_SAVED =
  "Couldn't reach the server, so this may not have saved. Check the list before trying again.";

/**
 * Run one server action and turn a rejection into an ordinary refusal, so every caller already
 * handles it: `res.ok` is false, `res.error` is the sentence above, and `lost` says which kind.
 * Callers keep their inputs and their modal open exactly as they do for any other refusal.
 */
export async function callOrLost<T extends { ok: boolean; error?: string }>(
  fn: () => Promise<T>,
  sentence: string = LOST_SIGNAL_MAYBE_SAVED,
): Promise<T | { ok: false; error: string; lost: true }> {
  try {
    return await fn();
  } catch {
    return { ok: false, error: sentence, lost: true };
  }
}
