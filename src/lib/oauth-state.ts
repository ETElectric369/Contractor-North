import "server-only";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

/**
 * OAuth CSRF protection. A random `state` nonce is set as an httpOnly cookie when the
 * user starts the connect flow, passed to the provider, and verified on the callback.
 * Without it, an attacker can trick a logged-in owner into a callback carrying the
 * ATTACKER's auth code, binding the attacker's QuickBooks/Google account to the
 * victim's org. The cookie is sameSite=lax so it survives the provider's top-level
 * redirect back, and an attacker can't set it cross-site.
 */
const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: 600 };

export function newOAuthState(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export function setOAuthState(res: NextResponse, provider: string, state: string): void {
  res.cookies.set(`oauth_state_${provider}`, state, COOKIE_OPTS);
}

/** True if the returned state matches the cookie set at connect-time. Always clears
 *  the cookie on `res` (single-use), whether or not it matched. */
export async function verifyOAuthState(
  res: NextResponse,
  provider: string,
  returned: string | null,
): Promise<boolean> {
  const jar = await cookies();
  const expected = jar.get(`oauth_state_${provider}`)?.value;
  res.cookies.set(`oauth_state_${provider}`, "", { ...COOKIE_OPTS, maxAge: 0 });
  return !!expected && !!returned && expected === returned;
}
