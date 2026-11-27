"use server";
import { headers } from "next/headers";
import { after } from "next/server";
import { reportError } from "@/lib/observe";
import { fillText, translator } from "@/lib/i18n";
import { callerLang } from "@/lib/lang-of";
import { langFromAcceptLanguage } from "@/lib/request-lang";
import { clientIp } from "@/lib/rate-limit";
import { authMailRefused, mailOneTimeCode } from "@/lib/auth-mail";

import { createClient } from "@/lib/supabase/server";
import { checkCurrentPassword } from "@/lib/supabase/password-check";

/** The auth server counts a password in BYTES and takes at most 72 of them. */
const MAX_PASSWORD_BYTES = 72;

/** The codes that mean the server wants a fresh sign-in (or the current password) before a change.
 *  current_password_invalid is not here since cn-v1203: it says the current password sent was wrong. */
const FRESH_SIGN_IN_CODES = new Set(["reauthentication_needed", "current_password_required"]);

/** Set the signed-in user's own password and clear the must-reset flag. Used by the first-login
 *  "choose your password" gate and by Settings › You › Change My Password (cn-v1202). Its refusals
 *  come back in the caller's language (callerLang, cn-v1138): a session exists here, so the profile
 *  is the one source of truth.
 *
 *  SAVED AS TYPED (cn-v1202): sign-in sends what was typed, untrimmed, so the save does too; a
 *  password typed with a space at an end used to be saved without it and then refused at sign-in.
 *  A refusal is read by its CODE and said in one of the app's own sentences, never the auth
 *  server's English. After a save every OTHER session of this person is signed out (scope
 *  "others" keeps this one and its cookies); `othersSignedOut` is true only when that call answered
 *  without an error, and its failure never fails the save. A password never reaches a report.
 *  When the save worked and only the must-reset flag could not be cleared, the answer carries
 *  `saved: true` with `othersSignedOut`, so the Settings row says the password changed.
 *
 *  ONE RULE DECIDES WHO GIVES THE CURRENT PASSWORD (cn-v1203, 2026-11-26, the owner: "require current
 *  password"). The caller's own must_reset_password decides it. TRUE is the first-password page's
 *  person (an invited person, or one who arrived by the reset email, which auth/confirm marks): no
 *  current password is asked, checked or sent. FALSE is everyone else, Settings › You › Change My
 *  Password: the current password is required and checked first (lib/supabase/password-check, a
 *  separate sign-in that keeps no session), and only a match goes on; the save then carries it as
 *  current_password, so a host that enforces it on its side is satisfied too. A failed read of the
 *  flag saves nothing. */
export async function updateMyPassword(
  newPassword: string,
  currentPassword?: string,
): Promise<{ ok: boolean; error?: string; othersSignedOut?: boolean; saved?: boolean }> {
  const supabase = await createClient();
  const t = translator(await callerLang(supabase));
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: t("au_notSignedIn") };

  const pw = typeof newPassword === "string" ? newPassword : "";
  if (pw.length < 8) return { ok: false, error: t("au_password8") };

  // WHO MUST GIVE THE CURRENT PASSWORD: the caller's own flag, their own row, their own client.
  let flagged: boolean;
  try {
    const { data: me, error: readError } = await supabase.from("profiles").select("must_reset_password").eq("id", user.id).maybeSingle();
    if (readError || !me) throw readError ?? new Error("no row");
    flagged = (me as { must_reset_password?: unknown }).must_reset_password === true;
  } catch (e) {
    const code = String((e as { code?: unknown } | null)?.code ?? "") || null;
    reportError("set-password-read-flag", new Error("reading the must-reset flag failed"), { code });
    return { ok: false, error: t("au_couldNotUpdate") };
  }

  let current: string | null = null;
  if (!flagged) {
    if (typeof currentPassword !== "string" || currentPassword === "") return { ok: false, error: t("au_currentPasswordNeeded") };
    const email = typeof user.email === "string" && user.email ? user.email : null;
    const check = email ? await checkCurrentPassword(email, currentPassword) : { result: "unknown" as const, code: null, status: null };
    if (check.result === "wrong") return { ok: false, error: t("au_currentPasswordWrong") };
    if (check.result !== "ok") {
      reportError("set-password-check-current", new Error("the current password could not be checked"), { code: check.code, status: check.status });
      return { ok: false, error: t("au_currentPasswordUnchecked") };
    }
    current = currentPassword;
  }

  const { error } = await supabase.auth.updateUser(current === null ? { password: pw } : { password: pw, current_password: current });
  if (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    const status = (error as { status?: unknown }).status;
    // THE ORDER (cn-v1202, after skeptic #99): first the codes the app knows, whatever the length,
    // because each names its own cause. "Too long" only when what was typed is over the server's
    // 72 BYTES AND the answer is the server's validation refusal (validation_failed, or no code at
    // all with 400/422): a failed call, a rate limit or a missing session is not a length problem,
    // and is said as au_couldNotUpdate and reported like any other.
    if (code === "weak_password") return { ok: false, error: t("au_joinWeakPassword") };
    if (code === "same_password") return { ok: false, error: t("au_samePassword") };
    if (code === "current_password_invalid") return { ok: false, error: t("au_currentPasswordWrong") };
    // The door named is the link a person sees first on the sign-in screen (au_signInWithCode).
    if (FRESH_SIGN_IN_CODES.has(code)) return { ok: false, error: fillText(t("au_signInFreshToChange"), { door: t("au_signInWithCode") }) };
    const validationRefusal = code === "validation_failed" || (!code && (status === 400 || status === 422));
    if (validationRefusal && new TextEncoder().encode(pw).length > MAX_PASSWORD_BYTES) return { ok: false, error: t("au_passwordTooLong") };
    reportError("set-password-update", new Error("the auth server refused the new password"), {
      code: code || null,
      status: status ?? null,
    });
    return { ok: false, error: t("au_couldNotUpdate") };
  }

  // THE OTHER DEVICES. Scope "others" revokes every session but this one, and leaves this one's
  // cookies where they are (auth-js _signOut removes the local session only for "local"/"global").
  let othersSignedOut = false;
  try {
    const { error: outError } = await supabase.auth.signOut({ scope: "others" });
    if (outError) {
      reportError("set-password-sign-out-others", new Error("signing out the other sessions failed"), {
        code: String((outError as { code?: unknown }).code ?? "") || null,
        status: (outError as { status?: unknown }).status ?? null,
      });
    } else {
      othersSignedOut = true;
    }
  } catch {
    reportError("set-password-sign-out-others", new Error("signing out the other sessions threw"), { code: null, status: null });
  }

  // profiles_update_self lets the user clear their own flag. CHECK THE ROWS (audit v921): a
  // zero-row update is a 204, and swallowing it left the person bouncing between /set-password
  // and /planner forever with nothing on screen saying why.
  const { data: cleared, error: flagError } = await supabase
    .from("profiles")
    .update({ must_reset_password: false })
    .eq("id", user.id)
    .select("id");
  if (flagError || !(cleared ?? []).length) {
    reportError("set-password-clear-flag", flagError ?? new Error("no rows"), { userId: user.id });
    // SAVED IS SAID AS SAVED (cn-v1202): the password IS saved; only the flag is left. `saved` lets
    // the Settings row say so (a person there never has the flag set: the app layout sends a flagged
    // person to the first-password page); the first-password form shows this sentence as before.
    return { ok: false, error: t("au_savedButStuck"), saved: true, othersSignedOut };
  }
  return { ok: true, othersSignedOut };
}

/** EMAIL ME A RESET LINK (cn-v1203): the way out for a forgotten current password, inside the
 *  Settings row, so a signed-in person (the phone app included) never leaves the app's frame for
 *  /forgot, whose only links lead to the sign-in form. It takes NO argument: the address is the
 *  signed-in person's own login email and nothing a caller sends can name another. The email goes
 *  out exactly as the forgot page's (login/actions requestPasswordReset): the same two limits
 *  (lib/auth-mail authMailRefused, per caller and per mailbox), then the app's own reset email in
 *  after(), so the answer never waits on the mint or the mailer. Its link lands on the
 *  first-password page through /auth/confirm, which marks the person as choosing a password. The
 *  answer is in the caller's language; the address reaches no log and no report here. */
export async function emailMyResetLink(): Promise<{ ok: boolean; message: string }> {
  const supabase = await createClient();
  const t = translator(await callerLang(supabase));
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: t("au_notSignedIn") };
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (!email) return { ok: false, message: t("au_resetNotSent") };
  const h = await headers();
  if (await authMailRefused(clientIp(h), email)) return { ok: false, message: t("au_tooManyEmails") };
  const requestLang = langFromAcceptLanguage(h.get("accept-language"));
  after(() => mailOneTimeCode({ kind: "reset", email, requestLang, translatorFor: translator }));
  return { ok: true, message: t("au_resetSentToYou") };
}
