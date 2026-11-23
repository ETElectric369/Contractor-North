"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { endSessionIfDeactivated } from "@/lib/deactivation-gate";
import { reportError } from "@/lib/observe";
import { fillText, translator, type Lang } from "@/lib/i18n";
import { langFromAcceptLanguage } from "@/lib/request-lang";
import { shellFromUserAgent } from "@/lib/native-shell";
import { cleanInviteToken, decideInviteDoor, inviteJoinPath, type InviteRow, type JoinErrorCode } from "@/lib/invite-door";
import { readInviteDoor } from "@/lib/invite-door-read";
import { setLanguage } from "@/app/(app)/settings/actions";

/**
 * THE ONE-STEP INVITE'S DOOR (cn-v1183). The invitation's token is the proof of the mailbox: the
 * link that carried it was sent to that address, so the account this makes is ALREADY CONFIRMED and
 * no second email is sent. Then the person is signed in, joined to the company and lands in the app.
 *
 * Every export of a "use server" file is a public endpoint, so this file exports only the two doors,
 * and each one reads and decides again: the page's render is never trusted. The address is ALWAYS
 * the invitation's, never a field. A confirmed account is never touched here: no password is ever
 * set on one. A never-confirmed, never-signed-in account with no company (someone started the old
 * sign-up form with the invited address) is CLAIMED: the token holder's password replaces the old one
 * in the same write that confirms it. Nothing here writes the sign-up allowlist: an open invitation
 * already passes the auth trigger (0125), and an allowlist row would outlive the invitation.
 * The sink hears the invitation's id and an error's code, never the token, never an address.
 */

const enc = encodeURIComponent;

/** An error as the sink may hear it: its code and status, never its message (a message can carry an address). */
function bare(where: string, e: unknown): Error {
  const o = (e ?? {}) as { code?: unknown; status?: unknown };
  return new Error(`${where}${o.code ? ` code=${String(o.code)}` : ""}${o.status ? ` status=${String(o.status)}` : ""}`);
}

/** Back to the join page for this token, with a CODE when there is one (fixer #85): the page maps
 *  the code to its own catalog sentence, so no free text from a URL is ever drawn there. */
function back(token: string, code?: JoinErrorCode): never {
  redirect(`${inviteJoinPath(token)}${code ? `&e=${code}` : ""}`);
}

async function request(): Promise<{ lang: Lang; shell: boolean }> {
  const h = await headers();
  return { lang: langFromAcceptLanguage(h.get("accept-language")), shell: shellFromUserAgent(h.get("user-agent")).native };
}

type Cookie = Awaited<ReturnType<typeof createClient>>;

async function sessionOf(supabase: Cookie): Promise<{ email: string | null; orgId: string | null } | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: me } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
  return { email: user.email ?? null, orgId: (me as { org_id?: string | null } | null)?.org_id ?? null };
}

/** GoTrue's own refusal of a password (too weak, too short): said back as the `weak` code, in the
 *  page's own words and language (its English sentence is never passed through). */
function passwordRefused(e: { code?: unknown; message?: unknown } | null): boolean {
  if (!e) return false;
  return String(e.code ?? "") === "weak_password" || /password/i.test(String(e.message ?? ""));
}

function alreadyRegistered(e: { code?: unknown; message?: unknown } | null): boolean {
  if (!e) return false;
  return /^(email_exists|user_already_exists)$/.test(String(e.code ?? "")) || /already (been )?registered|already exists/i.test(String(e.message ?? ""));
}

/** Steps 7 to 10, for both doors, as the signed-in person: accept, check, close the others, land. */
async function finish(supabase: Cookie, invite: InviteRow, lang: Lang): Promise<never> {
  const { error } = await supabase.rpc("accept_invitation");
  if (error) redirect(`/onboarding?error=${enc(String(error.message ?? ""))}`);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("org_id, role").eq("id", user?.id ?? "").maybeSingle();
  const joined = (me as { org_id?: string | null } | null)?.org_id ?? null;
  const seat = (me as { role?: string | null } | null)?.role ?? null;
  if (joined === invite.org_id && seat !== invite.role) {
    // accept_invitation() takes the NEWEST open row for the address; createInvitation now keeps one
    // open row per company and address, so the seat should be the link's. The sink hears it if not.
    reportError("joinInvite.otherRole", new Error("the person's role is not the invitation's after accept"), { invitationId: invite.id });
  }
  if (joined !== invite.org_id) {
    // The door's own check makes this unreachable; the sink hears it if it ever is not.
    reportError("joinInvite.otherCompany", new Error("the person's company is not the invitation's after accept"), { invitationId: invite.id });
  } else {
    // ONE DOOR OPENS, THE LAST ONE CLOSES: every other still-open invitation for this address in this
    // company is closed with it, so no second key to the same seat stays live in an inbox.
    try {
      const { error: tidyErr } = await createServiceClient()
        .from("invitations")
        .update({ accepted_at: new Date().toISOString() })
        .eq("org_id", invite.org_id)
        .eq("email", String(invite.email).trim().toLowerCase())
        .is("accepted_at", null)
        .select("id");
      if (tidyErr) reportError("joinInvite.closeOthers", bare("close others", tidyErr), { invitationId: invite.id });
    } catch (e) {
      reportError("joinInvite.closeOthers", bare("close others", e), { invitationId: invite.id });
    }
  }

  // The page was read in Spanish: the person's own profile follows, through the door the app's
  // language switch uses. A failure stops nothing.
  if (lang === "es") {
    try {
      const res = await setLanguage("es");
      if (!res?.ok) reportError("joinInvite.language", new Error("setLanguage refused"), { invitationId: invite.id });
    } catch (e) {
      reportError("joinInvite.language", bare("language", e), { invitationId: invite.id });
    }
  }

  revalidatePath("/", "layout");
  redirect("/planner");
}

/** The page's form: make the account (already confirmed), sign in, join. */
export async function joinWithInvite(formData: FormData) {
  const token = cleanInviteToken(formData.get("t"));
  if (!token) redirect("/auth/join");
  const { lang, shell } = await request();
  const t = translator(lang);

  const read = await readInviteDoor(token);
  if (!read.ok) back(token, "unavailable");
  const supabase = await createClient();
  const state = decideInviteDoor({
    invite: read.invite,
    now: new Date(),
    shell,
    session: read.invite ? await sessionOf(supabase) : null,
    account: read.account,
    newerElsewhere: read.newerElsewhere,
  });
  if (state.kind !== "create" || !read.invite) back(token);
  const invite = read.invite;

  const fullName = String(formData.get("full_name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!fullName || fullName.length > 120) back(token, "name");
  if (password.length < 6) back(token, "password");
  // THE INVITATION'S ADDRESS, never a field: a form that carries its own "email" is not read.
  const email = String(invite.email).trim().toLowerCase();
  const company = read.orgName || t("au_joinYourTeam");

  const svc = createServiceClient();
  if (state.claim) {
    if (!read.accountId) {
      reportError("joinWithInvite.claim", new Error("claim without an account id"), { invitationId: invite.id });
      back(token, "failed");
    }
    // ONE write: the token holder's password replaces the old one AND the address is confirmed.
    // user_metadata: GoTrue's admin update MERGES metadata, it does not replace it, so any other key
    // the earlier sign-up sent survives. Only full_name is read anywhere (0001's handle_new_user and
    // the profile it writes), and it is set here, so nothing that survives is ever read.
    const { error } = await svc.auth.admin.updateUserById(read.accountId, {
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) {
      if (passwordRefused(error)) back(token, "weak");
      reportError("joinWithInvite.claim", bare("claim", error), { invitationId: invite.id });
      back(token, "failed");
    }
    const { data: named, error: nameErr } = await svc.from("profiles").update({ full_name: fullName }).eq("id", read.accountId).select("id");
    if (nameErr || !(named as unknown[] | null)?.length) {
      reportError("joinWithInvite.claimName", nameErr ? bare("name", nameErr) : new Error("profile name wrote zero rows"), { invitationId: invite.id });
    }
  } else {
    const { error } = await svc.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) {
      // An auth user already holds the address (a race, or a profile whose address drifted, which
      // the read rightly ignores): the page would only draw the same form again, a loop (fixer #85,
      // S2). Sign in instead, and the link brings them back here to join. Never a claim.
      if (alreadyRegistered(error)) {
        reportError("joinWithInvite.alreadyRegistered", bare("create", error), { invitationId: invite.id });
        redirect(`/login?email=${enc(email)}&next=${enc(inviteJoinPath(token))}&message=${enc(fillText(t("au_joinSignInFirst"), { company }))}`);
      }
      if (passwordRefused(error)) back(token, "weak");
      reportError("joinWithInvite.create", bare("create", error), { invitationId: invite.id });
      back(token, "failed");
    }
  }

  const { error: signErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signErr) {
    // The account exists and is confirmed: sign in by hand, and the link brings them back to join.
    redirect(`/login?email=${enc(email)}&next=${enc(inviteJoinPath(token))}&message=${enc(fillText(t("au_joinReadySignIn"), { company }))}`);
  }
  if (await endSessionIfDeactivated(supabase)) redirect(`/login?error=${enc(t("au_deactivated"))}`);
  return finish(supabase, invite, lang);
}

/** Already signed in as the invited address, with no company: one tap joins. */
export async function joinSignedIn(formData: FormData) {
  const token = cleanInviteToken(formData.get("t"));
  if (!token) redirect("/auth/join");
  const { lang, shell } = await request();
  const t = translator(lang);

  const read = await readInviteDoor(token);
  if (!read.ok) back(token, "unavailable");
  const supabase = await createClient();
  const session = read.invite ? await sessionOf(supabase) : null;
  const state = decideInviteDoor({
    invite: read.invite,
    now: new Date(),
    shell,
    session,
    account: read.account,
    newerElsewhere: read.newerElsewhere,
  });
  if (state.kind !== "join_signed_in" || !read.invite) back(token);
  if (await endSessionIfDeactivated(supabase)) redirect(`/login?error=${enc(t("au_deactivated"))}`);
  return finish(supabase, read.invite, lang);
}
