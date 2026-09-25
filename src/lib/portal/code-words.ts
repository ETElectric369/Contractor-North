/**
 * THE PORTAL SIGN-IN CODE: THE RULES AND THE WORDS (0331). Pure and browser-safe (no node imports),
 * so the sign-in screen and the server say the same thing. The crypto half is ./code.
 */
/** The rules, said once. The database pins the same numbers (0331): these are for the words. */
export const CODE_DIGITS = 6;
export const CODE_TTL_MINUTES = 10;
export const CODE_MAX_TRIES = 5;
export const SENDS_PER_WINDOW = 3;
export const SEND_WINDOW_MINUTES = 15;
/** At most this many codes a link in 24 hours (0331): 50 guesses a day, and a flooded inbox is
 *  reported to the office. */
export const CODES_PER_DAY = 10;
export const SESSION_DAYS = 30;
/** Per-IP ceilings, on the shared rate_limits table (0098). A household behind one address can send
 *  a few codes to a few links; a script walking links can't. */
export const IP_SENDS_PER_HOUR = 10;
export const IP_TRIES_PER_15_MIN = 30;

/** How a code reaches the customer. 'sms' is the seam for when texting is live: 0331 answers it
 *  with channel_unavailable, and deliverPortalCode refuses it, until then. */
export type CodeChannel = "email" | "sms";

/** What a person typed, as a code: digits only (spaces, dashes and a pasted "Your code is" are
 *  dropped), and null unless exactly six are left. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const digits = input.replace(/\D/g, "");
  return digits.length === CODE_DIGITS ? digits : null;
}

/**
 * "mcpowder@comcast.net" → "m*******@comcast.net". Enough for the customer to know which inbox to
 * look in, not enough to read the address off the screen. The first letter stays, every other
 * letter of the name becomes a star (at least 3, so a short name doesn't give its length away), and
 * the domain stays whole. Not an email shape: null (the page says to ask the business).
 */
export function maskEmail(email: string | null | undefined): string | null {
  const e = String(email ?? "").trim();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return null;
  const name = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!domain.includes(".")) return null;
  return `${name[0]}${"*".repeat(Math.max(3, name.length - 1))}@${domain}`;
}

/** "(530) 555-0100" / "+1 530..." → "(***) ***-0100" style: the last 4 digits only. For the SMS
 *  seam; unused until texting is live. */
export function maskPhone(phone: string | null | undefined): string | null {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length < 7) return null;
  return `•••-•••-${d.slice(-4)}`;
}

// ── what the customer reads ──────────────────────────────────────────────────────────────────────

/** Why a send didn't go out, as the database says it (0331 portal_code_issue) plus the app's own. */
export type SendRefusal = "no_link" | "no_email" | "too_many" | "day_limit" | "channel_unavailable" | "busy" | "send_failed";

/** Minutes until a refused send can go again, rounded up, at least 1. */
export function minutesUntil(retryAt: string | null | undefined, now: Date = new Date()): number {
  const t = retryAt ? Date.parse(retryAt) : NaN;
  if (!Number.isFinite(t)) return SEND_WINDOW_MINUTES;
  return Math.max(1, Math.ceil((t - now.getTime()) / 60_000));
}

export function sendRefusalWords(reason: SendRefusal, business: string, retryMinutes?: number): string {
  switch (reason) {
    case "too_many": {
      const m = retryMinutes ?? SEND_WINDOW_MINUTES;
      return `That's a few codes in a row. Use the newest one in your email, or try again in ${m} minute${m === 1 ? "" : "s"}.`;
    }
    case "day_limit": {
      const m = retryMinutes ?? 24 * 60;
      const wait = m >= 90 ? `about ${Math.ceil(m / 60)} hours` : `${m} minute${m === 1 ? "" : "s"}`;
      return `That's as many codes as we send in one day. Use the newest one in your email, try again in ${wait}, or ask ${business} for help.`;
    }
    case "no_email":
      return `${business} doesn't have an email for you yet. Ask them to add it so we can send your code.`;
    case "no_link":
      return `This link was turned off. Ask ${business} for a new one.`;
    case "channel_unavailable":
      return "Codes by text aren't available yet. We can email it instead.";
    case "busy":
      return "Too many codes were asked for from this network. Try again in a little while.";
    case "send_failed":
    default:
      return "We couldn't send your code just now. Try again in a minute.";
  }
}

/** After a send. Every send cancels the code before it, so say so: an older code typed next is
 *  otherwise a mystery "didn't match". */
export function codeSentWords(maskedEmail: string | null): string {
  return `We sent a 6-digit code to ${maskedEmail ?? "your email"}. It works for ${CODE_TTL_MINUTES} minutes. Any code we sent before this one no longer works.`;
}

/** The page opened while a code is already out (re-clicking the link from a text, say): the code
 *  box, not a new send that would cancel the code just read. */
export function liveCodeWords(maskedEmail: string | null, minutesAgo: number): string {
  const when = minutesAgo < 1 ? "just now" : `${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago`;
  return `We emailed a code to ${maskedEmail ?? "your email"} ${when}. Enter it below.`;
}

/** Why a code didn't work, as portal_code_try / the comparison says it. */
export type CheckRefusal = "wrong" | "expired" | "used_up" | "spent" | "no_code" | "no_link" | "format" | "busy" | "error";

export function checkRefusalWords(reason: CheckRefusal, business: string, triesLeft?: number): string {
  switch (reason) {
    case "format":
      return "Enter the 6 digits from your email.";
    case "wrong":
      return triesLeft && triesLeft > 0
        ? `That code didn't match. ${triesLeft} ${triesLeft === 1 ? "try" : "tries"} left.`
        : "That code didn't match, and that was the last try. Send a new code.";
    case "expired":
      return `That code is more than ${CODE_TTL_MINUTES} minutes old. Send a new one.`;
    case "used_up":
      return "That code has had too many tries. Send a new one.";
    case "spent":
      return "That code can't be used anymore. Send a new one.";
    case "no_code":
      return "There's no code waiting for this page. Send one first.";
    case "no_link":
      return `This link was turned off. Ask ${business} for a new one.`;
    case "busy":
      return "Too many tries from this network. Wait a few minutes and try again.";
    case "error":
    default:
      return "We couldn't check your code just now. Try again in a minute.";
  }
}
