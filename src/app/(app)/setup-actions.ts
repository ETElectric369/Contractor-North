"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { runHear, type HearRun } from "@/lib/playbook/hear-run";
import { coerceByPlaybook } from "@/lib/playbook/answers";
import { SETUP_PLAYBOOK } from "@/lib/onboarding/setup-playbook";
import { updateOrgSettings } from "./settings/actions";
import { createStarterInspectionSheet } from "./forms/actions";
import type { Answers } from "@/lib/playbook/types";

type Result = { ok: true; seededSheet: boolean } | { ok: false; error: string };

/** Setting a company up is the same shape as walking a job — same playbook, same extraction. */
export async function hearSetup(answers: Answers, transcript: string): Promise<HearRun> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  return runHear(SETUP_PLAYBOOK, answers, transcript);
}

/**
 * COMMIT THE SETUP. This one IS executing, which is why it is a separate press.
 *
 * Filling the boxes needed no permission — it wrote into fields he could see and change. Writing
 * them onto the company is a different act: it changes what every estimate is priced against and
 * what the public page says. So hearSetup fills, and this saves, and the two are never the same
 * button. [[fill-vs-execute]].
 *
 * THE TRADE SEEDS THE SHEET. Andrew Cohen signed up with a blank trade and got a generic
 * six-question walk-through, then pressed "generate questions" and couldn't find what it made.
 * Naming the trade is what was missing, so naming it is what fixes it — here, in the same press,
 * rather than as a second thing to go and discover.
 */
export async function saveSetup(answers: Answers): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", user.id).maybeSingle();
  const role = (me as { role?: string } | null)?.role;
  if (!role || !["owner", "admin", "office"].includes(role))
    return { ok: false, error: "You don't have access to that." };

  // Same coercion the fill path uses — a hand-typed rate and a heard one land identically.
  const a = coerceByPlaybook(SETUP_PLAYBOOK, answers);
  const text = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");

  const name = text("full_name");
  if (name) {
    const { error } = await supabase.from("profiles").update({ full_name: name }).eq("id", user.id);
    if (error) return { ok: false, error: error.message };
  }

  // Only send what was actually answered. A blank in this card must never blank a setting somebody
  // already filled in elsewhere — the card is a way IN, not the source of truth for the whole org.
  const patch: Record<string, unknown> = {};
  if (text("trade")) patch.trade_label = text("trade");
  if (text("city")) patch.public_city = text("city");
  if (text("service_area")) patch.service_area = text("service_area");
  if (typeof a.labor_rate === "number" && a.labor_rate > 0) patch.default_labor_rate = a.labor_rate;
  if (Object.keys(patch).length) {
    const r = await updateOrgSettings(patch);
    if (!r.ok) return { ok: false, error: r.error ?? "Couldn't save that." };
  }

  // The trade is only worth naming if something happens because of it. If they have no
  // walk-through yet, this is the moment it exists — seeded for the trade they just said.
  let seededSheet = false;
  if (patch.trade_label) {
    const { count } = await supabase
      .from("forms")
      .select("id", { count: "exact", head: true })
      .eq("is_inspection", true);
    if (!count) {
      const r = await createStarterInspectionSheet();
      seededSheet = r.ok;
    }
  }

  revalidatePath("/planner");
  revalidatePath("/settings");
  return { ok: true, seededSheet };
}
