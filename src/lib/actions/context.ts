import { createClient } from "@/lib/supabase/server";
import type { ActionCtx } from "./types";

/** Resolve the caller once (id + role) so execute() can enforce per-action auth.
 *  Extracted so the role lookup lives in ONE place instead of being duplicated
 *  inline across the entity actions. */
export async function buildActionCtx(): Promise<ActionCtx> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let role: string | null = null;
  if (user) {
    const { data } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
    role = (data as any)?.role ?? null;
  }
  const isStaff = role === "owner" || role === "admin" || role === "office";
  return { userId: user?.id ?? null, role, isStaff };
}
