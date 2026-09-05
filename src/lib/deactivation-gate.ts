import type { createClient } from "@/lib/supabase/server";

/**
 * THE ONE DEACTIVATION GATE (audit v921).
 *
 * "A deactivated account must not get a session at all" was enforced in exactly two doors —
 * the password form and the 6-digit code — while /auth/callback (magic link, email
 * confirmation, password-reset link) exchanged a code for a full session with no check at all.
 * A cut employee could request a login link, open it, and hold a live, refreshable session;
 * only the (app) layout's render-time redirect ended it, and only if the client followed the
 * redirect. Three doors, one rule: this helper.
 *
 * Read on the caller's OWN client on purpose: profiles_read's `id = auth.uid()` disjunct still
 * answers for a deactivated user, which is the sliver 0158 deliberately leaves open.
 */
export async function endSessionIfDeactivated(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from("profiles").select("active").eq("id", user.id).maybeSingle();
  if ((data as { active?: boolean | null } | null)?.active !== false) return false;
  // Kill it here rather than leaving it to a later redirect: the token is the thing an
  // ex-employee still holds. Local scope — this is the device in front of us (cn-v919).
  await supabase.auth.signOut({ scope: "local" });
  return true;
}

/** The one sentence a deactivated person sees, wherever they tried to get in. */
export const DEACTIVATED_MESSAGE = "This account has been deactivated. Contact your office.";
