import { describe, it, expect } from "vitest";
import { cleanInviteToken, decideInviteDoor, inviteJoinLink, inviteJoinPath, type InviteDoorInput } from "./invite-door";

/**
 * THE ONE-STEP INVITE'S RULES (cn-v1183): the token's shape, the one builder of the link, and the
 * table of what the door may do, in its order.
 */
const TOKEN = "ab".repeat(24);
const NOW = new Date("2026-11-22T12:00:00Z");
const INVITE = {
  id: "inv-1",
  org_id: "org-larkspur",
  email: "dana.rook@example.com",
  role: "tech",
  accepted_at: null as string | null,
  expires_at: "2026-12-06T12:00:00Z",
};
const base = (over: Partial<InviteDoorInput> = {}): InviteDoorInput => ({
  invite: INVITE,
  now: NOW,
  shell: false,
  session: null,
  account: null,
  newerElsewhere: false,
  ...over,
});

describe("the token's shape", () => {
  it("only 48 lowercase hex characters pass", () => {
    expect(cleanInviteToken(TOKEN)).toBe(TOKEN);
    expect(cleanInviteToken("AB".repeat(24))).toBeNull();
    expect(cleanInviteToken("ab".repeat(23))).toBeNull();
    expect(cleanInviteToken("ab".repeat(25))).toBeNull();
    expect(cleanInviteToken(`${"ab".repeat(23)}zz`)).toBeNull();
    expect(cleanInviteToken(`${TOKEN} `)).toBeNull();
    expect(cleanInviteToken(`${TOKEN}' or 1=1`)).toBeNull();
    expect(cleanInviteToken(null)).toBeNull();
    expect(cleanInviteToken(undefined)).toBeNull();
    expect(cleanInviteToken(42)).toBeNull();
    expect(cleanInviteToken([TOKEN])).toBeNull();
  });
});

describe("the one builder of the link", () => {
  it("absolute, on the join page, carrying the token", () => {
    expect(inviteJoinPath(TOKEN)).toBe(`/auth/join?t=${TOKEN}`);
    expect(inviteJoinLink("https://app.example.com", TOKEN)).toBe(`https://app.example.com/auth/join?t=${TOKEN}`);
    expect(inviteJoinLink("https://app.example.com/", TOKEN)).toBe(`https://app.example.com/auth/join?t=${TOKEN}`);
    expect(inviteJoinLink("http://localhost:3000", TOKEN)).toBe(`http://localhost:3000/auth/join?t=${TOKEN}`);
  });
  it("null for a base that is not http(s), or a token that is not clean", () => {
    expect(inviteJoinLink("", TOKEN)).toBeNull();
    expect(inviteJoinLink(null, TOKEN)).toBeNull();
    expect(inviteJoinLink("/relative", TOKEN)).toBeNull();
    expect(inviteJoinLink("javascript:alert(1)", TOKEN)).toBeNull();
    expect(inviteJoinLink("https://app.example.com", "nope")).toBeNull();
    expect(inviteJoinLink("https://app.example.com", undefined)).toBeNull();
  });
});

describe("decideInviteDoor: every state, in its order", () => {
  const used = { ...INVITE, accepted_at: "2026-11-20T00:00:00Z" };
  const expired = { ...INVITE, expires_at: "2026-11-22T12:00:00Z" };
  const me = { email: "Dana.Rook@Example.com", orgId: null };
  const table: [string, Partial<InviteDoorInput>, unknown][] = [
    ["no row", { invite: null }, { kind: "invalid" }],
    ["accepted", { invite: used }, { kind: "used" }],
    ["accepted beats expired", { invite: { ...used, expires_at: "2026-01-01T00:00:00Z" } }, { kind: "used" }],
    ["accepted, the session already in its company", { invite: used, session: { email: "dana.rook@example.com", orgId: "org-larkspur" } }, { kind: "member" }],
    ["accepted, a session in another company", { invite: used, session: { email: "dana.rook@example.com", orgId: "org-other" } }, { kind: "used" }],
    ["expires exactly now", { invite: expired }, { kind: "expired", expiresAt: expired.expires_at }],
    ["expired beats superseded", { invite: expired, newerElsewhere: true }, { kind: "expired", expiresAt: expired.expires_at }],
    ["a newer invitation from another company", { newerElsewhere: true }, { kind: "superseded" }],
    ["superseded beats a session", { newerElsewhere: true, session: me }, { kind: "superseded" }],
    ["signed in as another address", { session: { email: "theo.vance@example.com", orgId: null } }, { kind: "signed_in_other", sessionEmail: "theo.vance@example.com" }],
    ["signed in with no address", { session: { email: null, orgId: null } }, { kind: "signed_in_other", sessionEmail: "" }],
    ["signed in as the address (any case), in this company", { session: { ...me, orgId: "org-larkspur" } }, { kind: "member" }],
    ["signed in as the address, in another company", { session: { ...me, orgId: "org-other" } }, { kind: "other_company" }],
    ["signed in as the address, no company", { session: me }, { kind: "join_signed_in" }],
    ["signed in beats the shell", { session: me, shell: true }, { kind: "join_signed_in" }],
    ["no session, no account", {}, { kind: "create", claim: false }],
    ["no session, no account, in the shell", { shell: true }, { kind: "shell" }],
    ["an account in another company", { account: { confirmed: true, everSignedIn: true, orgId: "org-other" } }, { kind: "other_company" }],
    ["an unconfirmed account in another company is still another company", { account: { confirmed: false, everSignedIn: false, orgId: "org-other" } }, { kind: "other_company" }],
    ["an account already in this company signs in", { account: { confirmed: true, everSignedIn: true, orgId: "org-larkspur" } }, { kind: "sign_in_first" }],
    ["a confirmed account", { account: { confirmed: true, everSignedIn: false, orgId: null } }, { kind: "sign_in_first" }],
    ["an account that once signed in", { account: { confirmed: false, everSignedIn: true, orgId: null } }, { kind: "sign_in_first" }],
    ["a confirmed account in the shell signs in too", { shell: true, account: { confirmed: true, everSignedIn: true, orgId: null } }, { kind: "sign_in_first" }],
    ["a never-confirmed, never-signed-in account with no company is claimed", { account: { confirmed: false, everSignedIn: false, orgId: null } }, { kind: "create", claim: true }],
    ["the same in the shell is not created there", { shell: true, account: { confirmed: false, everSignedIn: false, orgId: null } }, { kind: "shell" }],
  ];
  it.each(table)("%s", (_name, over, want) => {
    expect(decideInviteDoor(base(over))).toEqual(want);
  });

  it("claim is true ONLY for never confirmed AND never signed in AND no company", () => {
    for (const confirmed of [false, true])
      for (const everSignedIn of [false, true])
        for (const orgId of [null, "org-other", "org-larkspur"]) {
          const s = decideInviteDoor(base({ account: { confirmed, everSignedIn, orgId } }));
          const claim = s.kind === "create" && s.claim;
          expect(claim).toBe(!confirmed && !everSignedIn && orgId === null);
        }
  });
});
