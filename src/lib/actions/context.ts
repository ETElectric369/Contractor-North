import { createClient } from "@/lib/supabase/server";
import type { ActionCtx } from "./types";
import { asLang } from "@/lib/locale";

/** Resolve the caller once (id + role + language) so execute() can enforce per-action auth and a
 *  handler can answer in the person's words (cn-v1138: the language rides the same read, projection
 *  law — one trip, never a second read of the same row). Extracted so the lookup lives in ONE place
 *  instead of being duplicated inline across the entity actions. */
export async function buildActionCtx(): Promise<ActionCtx> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let role: string | null = null;
  let orgId: string | null = null;
  let lang: ActionCtx["lang"] = "en";
  if (user) {
    const { data } = await supabase
      .from("profiles")
      .select("role, org_id, language")
      .eq("id", user.id)
      .maybeSingle();
    role = (data as any)?.role ?? null;
    orgId = (data as any)?.org_id ?? null;
    lang = asLang((data as any)?.language);
  }
  // Role gating goes through roleCanRun(role, auth) in execute() — no separate
  // isStaff flag needed.
  return { userId: user?.id ?? null, orgId, role, lang };
}
