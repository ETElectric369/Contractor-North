"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { after } from "next/server";
import { endSessionIfDeactivated } from "@/lib/deactivation-gate";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-next";
import { reportError } from "@/lib/observe";
import { translator } from "@/lib/i18n";
import { langFromAcceptLanguage } from "@/lib/request-lang";
import { clientIp } from "@/lib/rate-limit";
import { collaboratorHome } from "@/lib/collaborator-home";
import { authMailRefused, mailOneTimeCode, type AuthMailKind } from "@/lib/auth-mail";

/**
 * THE WORDS AN ERROR COMES BACK IN (cn-v1138). Nobody is signed in when these doors refuse, so the
 * language is the phone's: the Accept-Language header's first tag, the same read login/page.tsx
 * makes, so the page and the error it shows agree. au_deactivated is lib/deactivation-gate's one
 * sentence, in the catalog (login-words.test.tsx pins them equal). GoTrue's own sentences ("Invalid
 * login credentials") still pass through as they are.
 */
async function words() {
  return translator(langFromAcceptLanguage((await headers()).get("accept-language")));
}

/** GoTrue answers a BANNED seat with its own wording ("Invalid login credentials" on some
 *  versions, "User is banned" on others). setMemberActive bans the login on deactivation, so that
 *  rejection happens before any app code runs and the deactivation gate never gets to speak.
 *  Translate it back to the one sentence the office tells people (audit v921). Anything else is
 *  passed through untouched — a real typo must still read like a typo. */
function bannedMessage(raw: string, t: (key: string) => string): string {
  return /banned|user is banned/i.test(raw) ? t("au_deactivated") : raw;
}

/** The deactivation rule lives in ONE place now (lib/deactivation-gate) so the magic-link
 *  callback cannot drift from these two forms — it did, and that was an audit v921 high. */
async function isDeactivated(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean> {
  return endSessionIfDeactivated(supabase);
}

export async function login(formData: FormData) {
  const supabase = await createClient();
  const t = await words();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // setMemberActive now BANS the seat at GoTrue, which rejects the sign-in before any app code
    // runs — so the deactivation gate below can never speak (audit v921 review blocker). Say the
    // sentence the office expects instead of GoTrue's raw "Invalid login credentials".
    redirect(`/login?error=${encodeURIComponent(bannedMessage(error.message, t))}`);
  }

  // A deactivated account must not get a session at all. Migration 0158 already denies it
  // data, but without this they could sign in again after being cut and sit on a live
  // token — and the credential itself is what an ex-employee still holds. Sign the new
  // session straight back out and say so plainly.
  if (await isDeactivated(supabase)) {
    redirect(`/login?error=${encodeURIComponent(t("au_deactivated"))}`);
  }

  // A RETURNING org-less collaborator belongs on /content (their grants may still be pending
  // claim if their first session never hit a claiming route). Otherwise honour ?next= — the
  // middleware stamps it on every bounce to /login, and until now sign-in threw it away, so a
  // deep link (a job, an invoice, a doc) always dumped the person on My Day (audit v921).
  const wanted = safeNextPath(String(formData.get("next") ?? "")) ?? "/planner";
  const dest = (await collaboratorHome(supabase)) ?? wanted;
  revalidatePath("/", "layout");
  redirect(dest);
}

export async function signup(formData: FormData) {
  const supabase = await createClient();
  const t = await words();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const full_name = String(formData.get("full_name") ?? "");
  // Carried through the signup form as a hidden field (collaborator invite links arrive as
  // /login?mode=signup&email=…&next=/content). Validated: same-app relative paths only.
  const next = safeNextPath(formData.get("next"));

  // INVITE-ONLY (migration 0125): the real gate is a BEFORE INSERT trigger on auth.users
  // (it also stops bots POSTing straight to GoTrue with the anon key). This pre-check just
  // turns the refusal into a clean message instead of a raw database error.
  const { data: allowed } = await supabase.rpc("signup_allowed", { p_email: email });
  if (allowed === false) {
    redirect(`/login?mode=signup&error=${encodeURIComponent(t("au_inviteOnly"))}`);
  }

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name },
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
    },
  });

  if (error) {
    redirect(`/login?mode=signup&error=${encodeURIComponent(error.message)}`);
  }

  // If email confirmations are ON, the user must confirm first. If OFF (handy
  // for the first owner account), a session is created immediately.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Instant session (confirmations off): the auth/callback claim never runs, so claim + route
    // HERE. An org-less collaborator goes to their invite's next (or /content); everyone else
    // keeps today's /planner.
    const collab = await collaboratorHome(supabase);
    revalidatePath("/", "layout");
    redirect(collab ? (next ?? collab) : "/planner");
  }

  redirect(`/login?message=${encodeURIComponent(t("au_checkEmailConfirm"))}`);
}

/**
 * THE APP SENDS THE EMAIL ITSELF (cn-v1199, lib/auth-mail): the two limits first, the same for every
 * address; then the mint and the send are queued in after(), past the answer, so neither what the
 * door says nor how long it takes tells whether the address has an account. Nothing the mint or the
 * mailer answers ever reaches the screen. True when the limits refused (the caller says so).
 */
async function queueAuthMail(kind: AuthMailKind, email: string): Promise<boolean> {
  const h = await headers();
  if (await authMailRefused(clientIp(h), email)) return true;
  const requestLang = langFromAcceptLanguage(h.get("accept-language"));
  after(() => mailOneTimeCode({ kind, email, requestLang, translatorFor: translator }));
  return false;
}

export async function requestPasswordReset(formData: FormData) {
  const t = await words();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) redirect(`/forgot?error=${encodeURIComponent(t("au_enterEmail"))}`);
  if (await queueAuthMail("reset", email)) redirect(`/forgot?error=${encodeURIComponent(t("au_tooManyEmails"))}`);

  // Always show success (don't reveal whether an email exists).
  redirect(`/forgot?message=${encodeURIComponent(t("au_resetOnItsWay"))}`);
}

export async function updatePassword(formData: FormData) {
  const supabase = await createClient();
  const t = await words();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/forgot");

  const password = String(formData.get("password") ?? "");
  if (password.length < 6) {
    redirect(`/reset?error=${encodeURIComponent(t("au_password6"))}`);
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    redirect(`/reset?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/", "layout");
  redirect("/planner");
}

const enc = encodeURIComponent;

/** Passwordless login — email the user a code (no password to remember). Existing users
 *  only: the mint never makes an account (lib/auth-mail). The app's own email carries the code and
 *  a Sign In button to /auth/confirm; every address gets the same answer, the code box. A refusal
 *  (too many asked) keeps the code box as well: a code already in the inbox must still have
 *  somewhere to be typed, and in the phone app an emailed button opens the browser, not the app. */
export async function sendLoginCode(formData: FormData) {
  const t = await words();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) redirect(`/login?mode=code&error=${enc(t("au_enterEmail"))}`);
  if (await queueAuthMail("signin", email)) redirect(`/login?mode=code&email=${enc(email)}&sent=1&error=${enc(t("au_tooManyEmails"))}`);
  redirect(`/login?mode=code&email=${enc(email)}&sent=1`);
}

/** Verify the code the user typed → establishes a session. Its length is the auth host's setting
 *  (6 to 10 digits), so the whole of what was typed is sent, never the first six (cn-v1199). */
export async function verifyLoginCode(formData: FormData) {
  const supabase = await createClient();
  const t = await words();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const token = String(formData.get("code") ?? "").replace(/\D/g, "").slice(0, 10);
  const back = `/login?mode=code&email=${enc(email)}&sent=1`;
  if (!email || token.length < 6) redirect(`${back}&error=${enc(t("au_enterCode"))}`);
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) redirect(`${back}&error=${enc(error.message)}`);
  // Same deactivation gate as the password path — otherwise the emailed code is a way
  // straight around it.
  if (await isDeactivated(supabase)) {
    redirect(`/login?error=${enc(t("au_deactivated"))}`);
  }
  // Same routing as password login: an org-less site collaborator belongs on /content, and a
  // deep link the middleware stashed in ?next= is honoured.
  const wanted = safeNextPath(String(formData.get("next") ?? "")) ?? "/planner";
  const dest = (await collaboratorHome(supabase)) ?? wanted;
  revalidatePath("/", "layout");
  redirect(dest);
}

/** The session id inside a Supabase access token (no verification — we only need the claim). */
function sessionIdFromJwt(token: string | undefined): string | null {
  try {
    const payload = JSON.parse(Buffer.from((token ?? "").split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload?.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}

export async function signOut() {
  const supabase = await createClient();
  // THIS device only — and never through GoTrue's /logout. Two things bit us on 2026-09-04:
  //   1. supabase-js signOut() defaults to scope "global": one tap signed out the phone, the office
  //      desktop and the native shell together.
  //   2. /logout?scope=local falls back to a USER-WIDE logout when the session in the token can't be
  //      found (already ended — the action ran twice) — verified: a fresh page, one Sign Out, every
  //      session gone.
  // So: end exactly this session by id (0242, SECURITY DEFINER, user_id = auth.uid()), then drop
  // the cookies. Deactivation and offboarding keep the global kill on purpose.
  const { data } = await supabase.auth.getSession();
  const sid = sessionIdFromJwt(data.session?.access_token);
  if (sid) {
    // The RPC's answer is not optional (audit v921): it returns the DELETE's row count, and a
    // 0 — or an error — means the auth.sessions row and its refresh token are still ALIVE on
    // the server while this device is about to look signed out. Nothing to show the user (the
    // cookies do go), but it must not vanish: it lands in error_events for the ops triage.
    const { data: ended, error } = await supabase.rpc("end_my_session", { p_session: sid });
    if (error || Number(ended) === 0) {
      reportError("signOut.end_my_session", error ?? new Error("no session row ended"), { sessionId: sid });
    }
  } else if (data.session) {
    // A session exists but its token carries no session_id claim — we have nothing to end by
    // id, so the server-side session outlives the cookies. Same reason to log it.
    reportError("signOut.end_my_session", new Error("no session_id claim in access token"));
  }
  const store = await cookies();
  for (const c of store.getAll()) {
    if (/^sb-.*-auth-token(\.\d+)?$/.test(c.name)) store.delete(c.name);
  }
  revalidatePath("/", "layout");
  redirect("/login");
}
