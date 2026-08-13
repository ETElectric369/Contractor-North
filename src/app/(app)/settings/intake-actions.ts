"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { INTAKE_STARTER } from "@/lib/playbook/public-intake";
import { intakeStarterForTrade } from "@/lib/playbook/starters/intake";
import { getOrgSettings } from "@/lib/org-settings";

/**
 * Flip the public intake door on or off (0185).
 *
 * ON with no flagged form: seed a "Customer intake" form from INTAKE_STARTER and flag it. ON with
 * one already there (flagged off earlier): re-flag the same form, so their edits survive an
 * off-and-on. OFF: clear the flag — the /intake page and its submit action both 404/refuse from
 * that moment, because an off switch that only hides the page isn't an off switch.
 *
 * Caller's own RLS client end to end: only someone who can edit this org's forms can open a
 * public door into it. Every write `.select("id")`s — the silent-write law.
 */
export async function setPublicIntake(on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  if (!on) {
    const { data, error } = await supabase
      .from("forms")
      .update({ is_public_intake: false })
      .eq("is_public_intake", true)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "It wasn't on." };
    revalidatePath("/settings");
    return { ok: true };
  }

  // Re-flag the previous intake form if one exists (name match keeps it deterministic)…
  const { data: existing } = await supabase
    .from("forms")
    .select("id")
    .eq("name", "Customer intake")
    .limit(1)
    .maybeSingle();
  if (existing?.id) {
    const { data, error } = await supabase
      .from("forms")
      .update({ is_public_intake: true })
      .eq("id", existing.id)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "That didn't save. Try again?" };
  } else {
    // …else seed the starter that matches the TRADE. The neutral five are the right thing to hand
    // a contractor we know nothing about and the wrong thing for a deck company, whose front door
    // should ask wood-or-composite rather than leave it in a paragraph for somebody to read back
    // out. The trade intakes reuse the walk-through's keys, so what a customer answers here is
    // already answered when the inspector opens on site (lib/inquiries/carry-intake-answers).
    const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
    const playbook = intakeStarterForTrade(getOrgSettings((org as { settings?: unknown } | null)?.settings).trade_label, INTAKE_STARTER);
    const { data, error } = await supabase
      .from("forms")
      .insert({ name: "Customer intake", schema: [], playbook, is_public_intake: true, is_inspection: false })
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "That didn't save. Try again?" };
  }
  revalidatePath("/settings");
  return { ok: true };
}
