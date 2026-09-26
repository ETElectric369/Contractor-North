"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { dbError } from "@/lib/db-error";
import { isFeatureKey, type FeatureKey } from "@/lib/features";

export type SetFeatureResult =
  | { ok: true; key: FeatureKey; on: boolean; previous: boolean }
  | { ok: false; error: string };

/**
 * TURN ONE FEATURE ON OR OFF (the switch board, 0352). The owner only, and the database decides
 * that, not this file: set_org_feature checks the role of an active seat, takes the company from
 * the signed-in person, whitelists the key and writes the audit row. This file only says the
 * answer in plain words.
 *
 * NOTHING SILENT: the RPC hands back the value it stored, and anything but the asked-for value is
 * a failure, never a quiet success. `previous` comes back for Undo.
 */
export async function setFeature(key: FeatureKey, on: boolean): Promise<SetFeatureResult> {
  if (!isFeatureKey(key)) return { ok: false, error: "That isn't a feature." };
  if (typeof on !== "boolean") return { ok: false, error: "Say on or off." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_org_feature", { p_key: key, p_on: on });
  if (error) {
    // PGRST202: PostgREST has no such function (0352 not applied: a deploy can land before its
    // migration). 42883: Postgres says the same thing.
    if (error.code === "PGRST202" || error.code === "42883")
      return { ok: false, error: "Features need an update from North. Nothing changed." };
    return { ok: false, error: dbError(error) };
  }
  const back = (data ?? null) as { key?: unknown; on?: unknown; previous?: unknown } | null;
  if (back?.key !== key || back?.on !== on) return { ok: false, error: "That didn't save. Reload and try again." };
  // Every door in the shell reads the switches: the dock, the menus, the job tabs, Needs You.
  revalidatePath("/", "layout");
  return { ok: true, key, on, previous: back.previous !== false };
}
