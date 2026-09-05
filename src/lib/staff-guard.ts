import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";

/** Resolve a Supabase client ONLY if the caller is signed in AND staff
 *  (owner/admin/office). Returns { error } otherwise. Use as the first line of
 *  money/admin server actions so authorization is enforced in the app layer —
 *  not on the RLS write policy alone (which is the single-layer failure class
 *  that already had to be retro-fixed for reads in migration 0056).
 *
 *  Usage:
 *    const ctx = await requireStaff();
 *    if ("error" in ctx) return { ok: false, error: ctx.error };
 *    const supabase = ctx.supabase;
 */
export async function requireStaff() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." as const };
  const { data: me } = await supabase.from("profiles").select("role, org_id, active").eq("id", user.id).maybeSingle();
  if (!me || !isStaffRole(me.role)) return { error: "This action is staff-only." as const };
  // DEACTIVATED IS A BOUNDARY, NOT A BADGE (audit v921 critical). 0158 deliberately leaves the
  // own-row profile read open, so role+org_id still come back for someone who was cut — and an
  // action that then reaches for the service-role client bypasses RLS entirely. An access token
  // outlives the seat (admin.signOut revokes refresh tokens, not issued JWTs), so the app layer
  // has to say no. Every requireStaff caller inherits this.
  if ((me as { active?: boolean | null }).active === false) {
    return { error: "This account has been deactivated." as const };
  }
  // orgId comes back too: nearly every caller needs it (to org-scope an id-keyed write,
  // or to attribute cost), and re-fetching the same profile row in each action was a
  // repeated papercut that quietly encouraged unscoped queries.
  return { supabase, userId: user.id, orgId: (me as { org_id?: string | null }).org_id ?? null };
}
