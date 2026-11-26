import type { createClient } from "@/lib/supabase/server";

/**
 * Where does a freshly-signed-in user with NO org belong? An external site collaborator
 * (site_collaborators seat, profile org_id NULL — cn-v459) lives on /content, never the app.
 * auth/callback already claims + routes them — but that's only the email-confirmation path;
 * with confirmations OFF, signup/login/OTP create an INSTANT session and used to dump them on
 * /planner → the (app) shell's /onboarding "create your company" wall with zero access. So
 * every session-creating door calls this: claim any grants invited to this email, then
 * return "/content" for a collaborator, null for everyone else (org members skip the RPC).
 *
 * One helper for the login actions and the emailed sign-in link's door (/auth/confirm, cn-v1199),
 * moved here out of login/actions.ts so the two cannot drift.
 */
export async function collaboratorHome(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: me } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
  if (me?.org_id) return null; // org member → normal app, untouched
  await supabase.rpc("claim_site_collaborations");
  const { data: g } = await supabase.from("site_collaborators").select("org_id").eq("user_id", user.id).limit(1);
  return g?.length ? "/content" : null;
}
