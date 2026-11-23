import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { adminConfigured } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observe";
import type { InviteRow } from "@/lib/invite-door";

/**
 * WHAT THE JOIN DOOR READS (cn-v1183), on the service client: nobody holding the link has a session
 * that may read an invitation, and the account's confirmation lives in the auth service.
 *
 * The caller has already passed the token through cleanInviteToken: this never sees a malformed one.
 * The invitation is read BY TOKEN ONLY and the select never lists the token. Nothing here writes.
 * A failed read is said to the sink with the invitation's id when it is known: never the token,
 * never an email address.
 */
export type InviteDoorRead =
  | {
      ok: true;
      invite: InviteRow | null;
      orgName: string;
      account: { confirmed: boolean; everSignedIn: boolean; orgId: string | null } | null;
      /** The account to claim, only when exactly one profile carries the address and the auth
       *  service agrees it is that address. */
      accountId: string | null;
      newerElsewhere: boolean;
    }
  | { ok: false };

/** What the sink may hear about a failure: its code and status, never its message (a message can
 *  carry the address). */
function bare(e: unknown): Error {
  const o = (e ?? {}) as { code?: unknown; status?: unknown };
  return new Error(`read failed${o.code ? ` code=${String(o.code)}` : ""}${o.status ? ` status=${String(o.status)}` : ""}`);
}

export async function readInviteDoor(token: string, now: Date = new Date()): Promise<InviteDoorRead> {
  if (!adminConfigured()) return { ok: false };
  try {
    const svc = createServiceClient();
    const { data: inv, error: invErr } = await svc
      .from("invitations")
      .select("id, org_id, email, role, accepted_at, expires_at")
      .eq("token", token)
      .maybeSingle();
    if (invErr) {
      reportError("readInviteDoor.invitation", bare(invErr));
      return { ok: false };
    }
    if (!inv) return { ok: true, invite: null, orgName: "", account: null, accountId: null, newerElsewhere: false };
    const invite = inv as InviteRow;
    const email = String(invite.email ?? "").trim().toLowerCase();

    const { data: org, error: orgErr } = await svc.from("organizations").select("name").eq("id", invite.org_id).maybeSingle();
    if (orgErr) {
      reportError("readInviteDoor.organization", bare(orgErr), { invitationId: invite.id });
      return { ok: false };
    }
    const orgName = String((org as { name?: string } | null)?.name ?? "").trim();

    // accept_invitation() joins the NEWEST open invitation for the address; this door never lets a
    // link join a company other than the one it names.
    const { data: newest, error: newErr } = await svc
      .from("invitations")
      .select("id, org_id")
      .eq("email", email)
      .is("accepted_at", null)
      .gt("expires_at", now.toISOString())
      .order("created_at", { ascending: false })
      .limit(1);
    if (newErr) {
      reportError("readInviteDoor.newest", bare(newErr), { invitationId: invite.id });
      return { ok: false };
    }
    const top = ((newest ?? []) as { id: string; org_id: string }[])[0];
    const newerElsewhere = !!top && top.id !== invite.id && top.org_id !== invite.org_id;

    // Exact equality: "_" and "%" are legal in an address, so never ilike.
    const { data: profs, error: profErr } = await svc.from("profiles").select("id, org_id, active").eq("email", email);
    if (profErr) {
      reportError("readInviteDoor.profiles", bare(profErr), { invitationId: invite.id });
      return { ok: false };
    }
    const rows = (profs ?? []) as { id: string; org_id: string | null }[];
    // A PROFILE ROW IS ONLY EVIDENCE OF AN ACCOUNT WHEN THE AUTH USER BEHIND IT HOLDS THE ADDRESS
    // (fixer #85, S1). profiles.email is writable by its owner, so anyone signed in can type the
    // invited address into their own profile. Every row is asked of the auth service and only the
    // rows whose auth email IS the invitation's are kept: a stranger's row can neither block the
    // invitee (a false "sign in first") nor switch the claim off. None kept: no account, and
    // createUser's own uniqueness decides. One kept: that is the account. More than one: the safe
    // side (sign in first, never a claim). A failed ask is "unavailable", never a guess.
    type AuthFacts = { email?: string | null; email_confirmed_at?: string | null; last_sign_in_at?: string | null };
    const agreeing: { row: { id: string; org_id: string | null }; user: AuthFacts }[] = [];
    for (const row of rows) {
      const { data: got, error: userErr } = await svc.auth.admin.getUserById(row.id);
      if (userErr) {
        reportError("readInviteDoor.account", bare(userErr), { invitationId: invite.id });
        return { ok: false };
      }
      const u = (got as { user?: AuthFacts | null } | null)?.user;
      if (u && String(u.email ?? "").trim().toLowerCase() === email) agreeing.push({ row, user: u });
    }
    let account: { confirmed: boolean; everSignedIn: boolean; orgId: string | null } | null = null;
    let accountId: string | null = null;
    if (agreeing.length > 1) {
      account = { confirmed: true, everSignedIn: true, orgId: null };
    } else if (agreeing.length === 1) {
      const { row, user: u } = agreeing[0];
      account = { confirmed: !!u.email_confirmed_at, everSignedIn: !!u.last_sign_in_at, orgId: row.org_id ?? null };
      accountId = row.id;
    }
    return { ok: true, invite, orgName, account, accountId, newerElsewhere };
  } catch (e) {
    reportError("readInviteDoor", bare(e));
    return { ok: false };
  }
}
