"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { dbError } from "@/lib/db-error";

type Result = { ok: boolean; error?: string };

/**
 * THE OWNER'S ONE SWITCH: may office staff see "Left For You"? (0286; Erik 2026-09-24: "office
 * staff should see mine (optional toggle)").
 *
 * Owner only, and checked here on the server rather than trusted from the page. The general
 * settings save (updateOrgSettings) strips this key, and the DB's guard_owner_money_visibility
 * trigger refuses anyone but an owner, so an admin cannot reach it by any door.
 *
 * ONE KEY, merged into the settings the database holds right now (never a whole settings object
 * rebuilt from defaults), and the row comes back so a zero-row write cannot report success.
 */
export async function setOfficeSeesOwnerMoney(on: boolean): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("role, org_id, active").eq("id", user.id).maybeSingle();
  if (!me || me.active === false || !me.org_id) return { ok: false, error: "Not allowed." };
  if (me.role !== "owner") return { ok: false, error: "Only the owner can change who sees this." };

  const { data: org, error: readErr } = await supabase.from("organizations").select("settings").eq("id", me.org_id).maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  if (!org) return { ok: false, error: "That didn't save. Reload and try again." };
  const merged = { ...((org.settings as Record<string, unknown> | null) ?? {}), office_sees_owner_money: on === true };

  const { data: wrote, error } = await supabase
    .from("organizations")
    .update({ settings: merged })
    .eq("id", me.org_id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That didn't save. Reload and try again." };
  revalidatePath("/analytics");
  return { ok: true };
}
