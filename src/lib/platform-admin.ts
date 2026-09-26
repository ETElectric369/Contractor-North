import { createClient } from "@/lib/supabase/server";

type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

/**
 * THE PLATFORM ADMIN (0176): the people who run North itself, not any one company. Listed in
 * public.platform_admins and asked through is_platform_admin(), which answers for the caller only.
 * profiles.role is NOT this: every company sets its own roles, so a role would be self-grantable.
 *
 * Bug reports, Bug Watch and the AI key's status are North's business, not a subscriber's
 * (Wave 0). A failed or missing call answers false: the door stays shut rather than open.
 */
export async function isPlatformAdmin(supabase: RpcClient): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("is_platform_admin");
    return !error && data === true;
  } catch {
    return false;
  }
}

/** A server action's first line for a platform-only write or read, shaped like requireStaff. */
export async function requirePlatformAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." as const };
  if (!(await isPlatformAdmin(supabase))) return { error: "Only North's own team can do that." as const };
  return { supabase, userId: user.id };
}
