/**
 * THE PORTAL'S SIGN-IN COOKIE (0331). No node imports: middleware (edge) reads this too.
 *
 * The cookie holds a random session id (the database keeps only its sha256). httpOnly so page
 * script can't read it, Secure, SameSite=Lax so the customer's click from their email still carries
 * it, and scoped to /portal/<token>: it is sent to that one link's pages and nowhere else on the
 * business's domain. 30 days, sliding: the database slides its end on every visit
 * (portal_session_check) and middleware re-sets the cookie's Max-Age to match.
 */
export const PORTAL_COOKIE = "cn_portal";
export const PORTAL_SESSION_SECONDS = 30 * 24 * 60 * 60;
/**
 * The office's See What They See rides its OWN cookie, never the customer's: middleware slides
 * cn_portal to 30 days on every page load, and an office look must end at its 8 hours. The session
 * behind it lasts 8 hours (0331 portal_preview_redeem); the cookie outlives it on purpose, so an
 * ended look shows "Your look ended, go back to the app" instead of the customer's sign-in screen,
 * whose Send My Code would email the customer a code they never asked for.
 */
export const PORTAL_OFFICE_COOKIE = "cn_portal_office";
/** The office session itself: 8 hours, never slid. */
export const PORTAL_OFFICE_SESSION_SECONDS = 8 * 60 * 60;
/** How long the office cookie is kept, so an ended look can say so. */
export const PORTAL_OFFICE_COOKIE_SECONDS = 7 * 24 * 60 * 60;

const TOKEN = /^[0-9a-f]{32,128}$/i;

export function isPortalToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN.test(token);
}

export function portalCookiePath(token: string): string {
  return `/portal/${token}`;
}

export type PortalCookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

/** Secure everywhere except plain-http local development (a browser drops a Secure cookie there). */
export function portalCookieOptions(token: string, maxAge: number = PORTAL_SESSION_SECONDS): PortalCookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    path: portalCookiePath(token),
    maxAge,
  };
}

/** The link token out of a /portal/<token>[/...] path, or null. */
export function portalTokenFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/portal\/([0-9a-f]{32,128})(?:\/|$)/i);
  return m ? m[1] : null;
}
