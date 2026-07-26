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
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", user.id).maybeSingle();
  if (!me || !isStaffRole(me.role)) return { error: "This action is staff-only." as const };
  // orgId comes back too: nearly every caller needs it (to org-scope an id-keyed write,
  // or to attribute cost), and re-fetching the same profile row in each action was a
  // repeated papercut that quietly encouraged unscoped queries.
  return { supabase, userId: user.id, orgId: (me as { org_id?: string | null }).org_id ?? null };
}
