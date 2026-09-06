"use server";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";

import { createClient } from "@/lib/supabase/server";

/** Set the signed-in user's own password and clear the must-reset flag. Used by the
 *  first-login "choose your password" gate. */
export async function updateMyPassword(newPassword: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const pw = (newPassword || "").trim();
  if (pw.length < 8) return { ok: false, error: "Password must be at least 8 characters." };

  const { error } = await supabase.auth.updateUser({ password: pw });
  if (error) return { ok: false, error: dbError(error) };

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
    return {
      ok: false,
      error: "Your new password is saved, but this screen couldn't finish. Sign out, sign back in with it, and tell an owner or admin if it asks again.",
    };
  }
  return { ok: true };
}
