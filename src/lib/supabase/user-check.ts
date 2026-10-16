import { isAuthRetryableFetchError, isAuthSessionMissingError, type AuthError, type SupabaseClient, type User } from "@supabase/supabase-js";

/** What the sign-in check found: a person, nobody (no session), a refused session, or no answer. */
export type SignInCheck = {
  user: User | null;
  reason: "ok" | "none" | "refused" | "failed";
  /** The check could not be made: the auth server was unreachable or answered 5xx / 429 / a gateway page. */
  failed: boolean;
  error: AuthError | null;
};

/** A blip, not an answer: unreachable; 5xx or 429; or a gateway's HTML / text page in place of
 *  JSON, which auth-js hands over as AuthUnknownError with NO status (skeptic #15, 2026-10-16). */
export function transientAuthError(error: AuthError): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  if (error.name === "AuthUnknownError") return true;
  const s = Number(error.status ?? 0);
  return s >= 500 || s === 429;
}

/** A first look slower than this already carried auth-js's own refresh retries (~25 s with the
 *  network down): a second look would double a hang past the edge's 25 s. */
export const RETRY_ONLY_UNDER_MS = 4000;

const ok = (user: User): SignInCheck => ({ user, reason: "ok", failed: false, error: null });
const failed = (error: AuthError | null): SignInCheck => ({ user: null, reason: "failed", failed: true, error });

/** THE SIGN-IN CHECK, TOLD APART FROM A SIGN-OUT (Erik, 2026-10-16, twice in one night: the app
 *  came back from the lock screen or a relaunch, the layout's getUser came back empty for a
 *  moment, and `if (!user) redirect("/login")` sent him to the login screen mid-conversation;
 *  the second time he re-typed his password and a second live session was born while the first
 *  went on refreshing). getUser answers nothing for three different reasons, and only one of
 *  them is a sign-out: no session at all ("none"), a session the auth server REFUSED ("refused":
 *  an expired or revoked token — a real sign-out, reported so the cause is known), or no answer
 *  at all ("failed"). A blip is looked at once more after `retryMs` — unless the first look was
 *  already slow. And "no session" on that SECOND look is still the blip: a blip on the token
 *  refresh makes auth-js drop its own copy of the session before we look again
 *  (GoTrueClient _callRefreshToken → _removeSession), so nobody is signed out by it. */
export async function checkUser(
  supabase: Pick<SupabaseClient, "auth">,
  opts: { retryMs?: number; retryOnlyUnderMs?: number } = {},
): Promise<SignInCheck> {
  const retryMs = opts.retryMs ?? 300;
  const retryOnlyUnderMs = opts.retryOnlyUnderMs ?? RETRY_ONLY_UNDER_MS;
  const t0 = Date.now();
  const first = await supabase.auth.getUser();
  if (first.data.user) return ok(first.data.user);
  const e1 = first.error;
  if (!e1 || isAuthSessionMissingError(e1)) return { user: null, reason: "none", failed: false, error: null };
  if (!transientAuthError(e1)) return { user: null, reason: "refused", failed: false, error: e1 };
  if (Date.now() - t0 > retryOnlyUnderMs) return failed(e1);
  await new Promise<void>((r) => setTimeout(r, retryMs));
  const second = await supabase.auth.getUser();
  if (second.data.user) return ok(second.data.user);
  const e2 = second.error;
  if (!e2 || isAuthSessionMissingError(e2) || transientAuthError(e2)) return failed(e2 ?? e1);
  return { user: null, reason: "refused", failed: false, error: e2 };
}
