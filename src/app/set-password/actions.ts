"use server";
import { reportError } from "@/lib/observe";
import { fillText, translator } from "@/lib/i18n";
import { callerLang } from "@/lib/lang-of";

import { createClient } from "@/lib/supabase/server";

/** The auth server counts a password in BYTES and takes at most 72 of them. */
const MAX_PASSWORD_BYTES = 72;

/** The codes that mean the server wants a fresh sign-in (or the current password) before a change. */
const FRESH_SIGN_IN_CODES = new Set(["reauthentication_needed", "current_password_required", "current_password_invalid"]);

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
 *  `saved: true` with `othersSignedOut`, so the Settings row says the password changed. */
export async function updateMyPassword(newPassword: string): Promise<{ ok: boolean; error?: string; othersSignedOut?: boolean; saved?: boolean }> {
  const supabase = await createClient();
  const t = translator(await callerLang(supabase));
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: t("au_notSignedIn") };

  const pw = typeof newPassword === "string" ? newPassword : "";
  if (pw.length < 8) return { ok: false, error: t("au_password8") };

  const { error } = await supabase.auth.updateUser({ password: pw });
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
