"use server";

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
  if (error) return { ok: false, error: error.message };

  // profiles_update_self lets the user clear their own flag.
  await supabase.from("profiles").update({ must_reset_password: false }).eq("id", user.id);
  return { ok: true };
}
