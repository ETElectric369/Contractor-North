/**
 * WHAT A CONTROL SAYS AFTER A SAVE — one rule for every card and pill that writes through a server
 * action inside a transition (cn-v1131).
 *
 * Two ways a save fails to say anything: the action answers {ok:false} and the control shows "Saved"
 * anyway (the silent-write law, closed on the rates card), and the action THROWS — a dropped
 * connection, a server error — which inside startTransition is uncaught and lands on the error
 * boundary, the whole page gone with no word on the card. So a control asks this for its words: null
 * when the server said ok, else the server's own words, the control's fallback when it gave none, and
 * the one unreachable line when the call itself threw. Nothing is swallowed and nothing escapes.
 */
export const COULD_NOT_REACH = "Couldn't reach the server — press Save again.";

export async function saveWords(
  call: () => Promise<{ ok?: boolean; error?: string | null } | null | undefined>,
  /** The words when the server refused without saying why. */
  fallback: string,
  /** The words when the call threw (default: COULD_NOT_REACH; a pill with no Save button says "try again"). */
  unreachable: string = COULD_NOT_REACH,
): Promise<string | null> {
  let res: { ok?: boolean; error?: string | null } | null | undefined;
  try {
    res = await call();
  } catch {
    return unreachable;
  }
  if (res?.ok) return null;
  return res?.error || fallback;
}
