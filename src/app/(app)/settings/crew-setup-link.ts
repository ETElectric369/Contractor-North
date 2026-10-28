/**
 * THE CREW IMPORT'S ONE-TIME LINK (cn-v1134). Until now each imported person's password was their
 * phone digits (or "deck-" + 8 hex for a row with no phone), shown once on the import screen — a
 * password anyone with the roster could guess. Now the login is made with a long random password
 * nobody sees, and the office hands each person a ONE-TIME LINK instead.
 *
 * HOW THE LINK WORKS, END TO END:
 *   1. importCrew asks the admin API for a recovery link (auth.admin.generateLink type "recovery").
 *      generateLink SENDS NOTHING; it answers the token hash. (Its action_link is not used: that
 *      link is the implicit flow — the session comes back in the URL FRAGMENT — which the app's
 *      server-side /auth/callback can never read, because @supabase/ssr is PKCE and the admin API
 *      has no verifier.)
 *   2. The link below carries that hash to /auth/confirm (src/app/auth/confirm/route.ts), which
 *      shows ONE button (a link preview must not spend the token); the tap POSTs the hash, which is
 *      verified server-side (auth.verifyOtp type "recovery"), writes the session cookies the same
 *      way /auth/callback does, and sends the person to /set-password.
 *   3. /set-password is the app's own Set A Password page (profiles.must_reset_password is true
 *      on every imported seat, so the app shell sends them there anyway until they choose one).
 * A recovery hash is consumed when it is verified and expires on the project's email-OTP clock
 * (an hour by default), so each link works once and soon; a used or expired link lands on the
 * login page with the way out said in words.
 *
 * Pure: the words and the URL, shared by the server door and the screen, testable without either.
 */

/** Where the link lands after the hash is verified: the app's Set A Password page. */
export const CREW_SETUP_NEXT = "/set-password";

/** The screen's words. */
export const CREW_IMPORT_WORDS = {
  before: "Upload a CSV with Name, Email, Phone, Role columns. Each person gets a one-time link to set their own password. Nothing is emailed.",
  handOut: "Hand each person their link. It opens Set A Password. Nothing was emailed.",
  onceAndSoon: "These links are shown once. Copy each one now; they are gone when you press Done. Each works once and for a short time; if one expires, that person signs in with a code from the login page and sets a password there.",
  noLink: "Added, but no link could be made. They can sign in with a code from the login page.",
  noRoster: "Added, but the roster row could not be written. Open Team and finish their seat there.",
} as const;

/**
 * The one-time link for a hashed recovery token: `<base>/auth/confirm?token_hash=…&type=recovery&next=/set-password`.
 * `base` is the app's own origin (NEXT_PUBLIC_SITE_URL, the same door the reset email uses); a
 * trailing slash is dropped. Returns null when there is no base or no hash to build from.
 */
export function crewSetupLink(base: string | undefined | null, hashedToken: string | undefined | null): string | null {
  const origin = String(base ?? "").trim().replace(/\/+$/, "");
  const hash = String(hashedToken ?? "").trim();
  if (!/^https?:\/\/[^/]+$/.test(origin) || !hash) return null;
  const q = new URLSearchParams({ token_hash: hash, type: "recovery", next: CREW_SETUP_NEXT });
  return `${origin}/auth/confirm?${q.toString()}`;
}
