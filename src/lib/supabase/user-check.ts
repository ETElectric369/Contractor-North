import { AuthRetryableFetchError, isAuthRetryableFetchError, isAuthSessionMissingError, type AuthError, type SupabaseClient, type User } from "@supabase/supabase-js";

/** What the sign-in check found: a person, nobody (no session), a refused session, or no answer. */
export type SignInCheck = {
  user: User | null;
  reason: "ok" | "none" | "refused" | "failed";
  /** The check could not be made: the auth server was unreachable or answered 5xx / 429 / a gateway page. */
  failed: boolean;
  error: AuthError | null;
};

/** A blip, not an answer: unreachable; 5xx or 429; or a gateway's HTML / text page in place of
 *  JSON, which auth-js hands over as AuthUnknownError with NO status (skeptic #15, 2026-10-16).
 *  And 409: the auth server's own "conflict" answer when a refresh waited on another refresh of the
 *  same session for its lock and gave up; a busy signal, not a refusal (skeptic #96, cn-v1198). */
export function transientAuthError(error: AuthError): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  if (error.name === "AuthUnknownError") return true;
  const s = Number(error.status ?? 0);
  return s >= 500 || s === 429 || s === 409;
}

/** A first look slower than this already carried auth-js's own refresh retries: a second look
 *  would spend what is left of the check's deadline (CHECK_DEADLINE_MS) on a server that is down. */
export const RETRY_ONLY_UNDER_MS = 4000;

/** THE ONE DEADLINE (cn-v1198): checkUser answers within this long of being called, both looks and
 *  the pause between them included. Without it, auth-js's own refresh retries (eight attempts over
 *  about 25.5 s with the auth server down) ran past the host's 25 s middleware limit. */
export const CHECK_DEADLINE_MS = 8000;

/** The failure a check that ran out of time answers with: retryable (so `transientAuthError` is
 *  true), status 408, which no answer from auth-js carries, so the error sink tells it apart. */
const ranOutOfTime = (ms: number): AuthError => new AuthRetryableFetchError(`The sign-in check ran out of time after ${ms} ms`, 408);

const ok = (user: User): SignInCheck => ({ user, reason: "ok", failed: false, error: null });
const failed = (error: AuthError | null): SignInCheck => ({ user: null, reason: "failed", failed: true, error });
const TIME_UP = Symbol("time-up");

/** THE SIGN-IN CHECK, TOLD APART FROM A SIGN-OUT (Erik, 2026-10-16, twice in one night: the app
 *  came back from the lock screen or a relaunch, the layout's getUser came back empty for a
 *  moment, and `if (!user) redirect("/login")` sent him to the login screen mid-conversation;
 *  the second time he re-typed his password and a second live session was born while the first
 *  went on refreshing). getUser answers nothing for three different reasons, and only one of
 *  them is a sign-out: no session at all ("none"), a session the auth server REFUSED ("refused":
 *  an expired or revoked token — a real sign-out, reported so the cause is known), or no answer
 *  at all ("failed"). A blip is looked at once more after `retryMs` — unless the first look was
 *  already slow. And "no session" on that SECOND look is still counted as the blip, so nobody is
 *  signed out by it. On the installed pair a blip on the token refresh no longer drops the
 *  session: GoTrueClient _callRefreshToken keeps it for a retryable failure (a network error, a
 *  500–504 or a 520–530; 500, 501, 525–529 only from auth-js 2.119), and calls _removeSession
 *  only for a refused refresh, and then only when the access token has already expired.
 *
 *  ONE DEADLINE (cn-v1198): the whole check, both looks and the pause, races ONE timer of
 *  `deadlineMs` (CHECK_DEADLINE_MS) started when it is called, so auth-js's ~25 s of refresh retries
 *  can no longer be waited out here. Time up is the "failed" answer, never a sign-out. A getUser
 *  that throws still reaches the caller as a rejection, as before. The look left behind is safe to
 *  leave: Promise.race holds its later rejection, and a late answer reaches nobody. On a failed
 *  check the middleware sends a NEW response, so a late cookie write by the library lands on an
 *  object nobody sends and the phone keeps the cookies it has; and if the auth server did finish
 *  that refresh, presenting the old refresh token again returns the same active one (the server's
 *  parent-token rule, no time limit, while the session itself is still valid: its own time limits
 *  apply), so the next request picks the session up. */
export async function checkUser(
  supabase: Pick<SupabaseClient, "auth">,
  opts: { retryMs?: number; retryOnlyUnderMs?: number; deadlineMs?: number } = {},
): Promise<SignInCheck> {
  const retryMs = opts.retryMs ?? 300;
  const retryOnlyUnderMs = opts.retryOnlyUnderMs ?? RETRY_ONLY_UNDER_MS;
  const deadlineMs = opts.deadlineMs ?? CHECK_DEADLINE_MS;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let pause: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<typeof TIME_UP>((r) => { deadline = setTimeout(() => r(TIME_UP), deadlineMs); });
  try {
    const t0 = Date.now();
    const first = await Promise.race([supabase.auth.getUser(), timeUp]);
    if (first === TIME_UP) return failed(ranOutOfTime(deadlineMs));
    if (first.data.user) return ok(first.data.user);
    const e1 = first.error;
    if (!e1 || isAuthSessionMissingError(e1)) return { user: null, reason: "none", failed: false, error: null };
    if (!transientAuthError(e1)) return { user: null, reason: "refused", failed: false, error: e1 };
    if (Date.now() - t0 > retryOnlyUnderMs) return failed(e1);
    const paused = await Promise.race([new Promise<void>((r) => { pause = setTimeout(r, retryMs); }), timeUp]);
    if (paused === TIME_UP) return failed(ranOutOfTime(deadlineMs));
    const second = await Promise.race([supabase.auth.getUser(), timeUp]);
    if (second === TIME_UP) return failed(ranOutOfTime(deadlineMs));
    if (second.data.user) return ok(second.data.user);
    const e2 = second.error;
    if (!e2 || isAuthSessionMissingError(e2) || transientAuthError(e2)) return failed(e2 ?? e1);
    return { user: null, reason: "refused", failed: false, error: e2 };
  } finally {
    clearTimeout(deadline);
    clearTimeout(pause);
  }
}
