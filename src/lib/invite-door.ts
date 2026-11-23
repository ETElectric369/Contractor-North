/**
 * THE ONE-STEP INVITE (cn-v1183): the invitation's own token is the proof of the mailbox.
 *
 * The old way in was four steps: the app's invite email opened the sign-up form, the auth service
 * then sent a SECOND email to confirm the address, its link landed on the sign-in page, and the
 * onboarding page still asked for Join. The invite email's link now carries the invitation's token
 * (48 hex characters, 192 bits, unique, 14 days); the page it opens is one form and the door behind
 * it makes the account already confirmed, signs the person in and joins them to the company.
 *
 * This file is pure: the token's shape, THE ONE BUILDER of the link (createInvitation and the
 * office's Copy Link both call it), and the decision of what the door may do, dated by argument.
 * It imports no catalog and no client.
 */

/** A token exactly as the database makes it: encode(gen_random_bytes(24), 'hex'). Anything else is
 *  refused BEFORE any read, so a malformed value never reaches the database. */
export function cleanInviteToken(raw: unknown): string | null {
  return typeof raw === "string" && /^[0-9a-f]{48}$/.test(raw) ? raw : null;
}

/** The join page's path for a clean token. */
export function inviteJoinPath(token: string): string {
  return `/auth/join?t=${token}`;
}

/** THE ONE BUILDER of the link a person is sent: absolute, or null when the base is not http(s) or
 *  the token is not clean (the caller then falls back to the old sign-up link). */
export function inviteJoinLink(base: string | null | undefined, token: unknown): string | null {
  const b = String(base ?? "").replace(/\/+$/, "");
  const t = cleanInviteToken(token);
  if (!t || !/^https?:\/\/[^/\s]+/i.test(b)) return null;
  return `${b}${inviteJoinPath(t)}`;
}

/** The OLD sign-up link (sign up with this email, then the confirm email). It still works, and it is
 *  what is sent when the join page could not read the row (no service client) or no token came back. */
export function inviteSignupLink(base: string, email: string): string {
  return `${base}/login?mode=signup&email=${encodeURIComponent(email)}`;
}

/** What the office's Copy Link copies (fixer #85, F5): the one-step link only when the join page can
 *  read the row (`joinReady` = the service client is configured, read on the server), else the old
 *  link, exactly as createInvitation falls back. */
export function inviteCopyLink(siteUrl: string, email: string, token: unknown, joinReady: boolean): string {
  return (joinReady ? inviteJoinLink(siteUrl, token) : null) ?? inviteSignupLink(siteUrl, email);
}

/** The only things the join door may send back to its page: a CODE, never text (fixer #85, F6).
 *  The page maps each code to its catalog key; an unknown code draws nothing. */
export type JoinErrorCode = "name" | "password" | "failed" | "unavailable" | "weak";
const JOIN_ERROR_KEYS: Record<JoinErrorCode, string> = {
  name: "au_nameRequired",
  password: "au_password6",
  failed: "au_joinFailed",
  unavailable: "au_joinUnavailable",
  weak: "au_joinWeakPassword",
};
export function joinErrorKey(code: unknown): string | null {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(JOIN_ERROR_KEYS, code) ? JOIN_ERROR_KEYS[code as JoinErrorCode] : null;
}

export type InviteRow = {
  id: string;
  org_id: string;
  email: string;
  role: string;
  accepted_at: string | null;
  expires_at: string;
};

export type InviteDoorInput = {
  invite: InviteRow | null;
  now: Date;
  /** Inside the native shell: no account is created there (the store's rule), sign-in only. */
  shell: boolean;
  session: { email: string | null; orgId: string | null } | null;
  account: { confirmed: boolean; everSignedIn: boolean; orgId: string | null } | null;
  /** A NEWER open invitation for the same email exists from ANOTHER company. */
  newerElsewhere: boolean;
};

export type InviteDoorState =
  | { kind: "invalid" }
  | { kind: "used" }
  | { kind: "expired"; expiresAt: string }
  | { kind: "superseded" }
  | { kind: "signed_in_other"; sessionEmail: string }
  | { kind: "member" }
  | { kind: "other_company" }
  | { kind: "join_signed_in" }
  | { kind: "sign_in_first" }
  | { kind: "shell" }
  | { kind: "create"; claim: boolean };

const same = (a: string | null | undefined, b: string | null | undefined) =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase() && String(a ?? "").trim() !== "";

/**
 * What the door may do, in this order (the order is the rule; a table test pins it):
 *  1. no row → invalid;  2. accepted → used (member when the session is already in its company);
 *  3. past its day → expired;  4. a newer open invitation from another company → superseded;
 *  5. a session: another address → signed_in_other; a company → member (this one) or
 *     other_company; none → join_signed_in;
 *  6. no session: an account in a company → other_company (sign_in_first when it is THIS company:
 *     signing in lands them where they already belong); an account ever confirmed or ever signed in
 *     → sign_in_first; else shell (no account is made in the shell) or create.
 * `claim` is true only for an account that was NEVER confirmed, NEVER signed in and has no company:
 * anyone could have started the old sign-up form with the invited address and a password of their
 * own, so the token holder's password REPLACES that one in the same write that confirms it. A
 * confirmed account is never touched by this door.
 */
export function decideInviteDoor(input: InviteDoorInput): InviteDoorState {
  const { invite, now, shell, session, account, newerElsewhere } = input;
  if (!invite) return { kind: "invalid" };
  if (invite.accepted_at) {
    return session?.orgId && session.orgId === invite.org_id ? { kind: "member" } : { kind: "used" };
  }
  const exp = new Date(invite.expires_at);
  if (!(exp.getTime() > now.getTime())) return { kind: "expired", expiresAt: invite.expires_at };
  if (newerElsewhere) return { kind: "superseded" };
  if (session) {
    if (!same(session.email, invite.email)) return { kind: "signed_in_other", sessionEmail: String(session.email ?? "") };
    if (session.orgId) return session.orgId === invite.org_id ? { kind: "member" } : { kind: "other_company" };
    return { kind: "join_signed_in" };
  }
  if (account) {
    if (account.orgId) return account.orgId === invite.org_id ? { kind: "sign_in_first" } : { kind: "other_company" };
    if (account.confirmed || account.everSignedIn) return { kind: "sign_in_first" };
  }
  if (shell) return { kind: "shell" };
  return { kind: "create", claim: account !== null };
}
