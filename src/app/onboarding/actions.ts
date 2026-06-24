"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { TRADE_PRESETS } from "@/lib/trade-codes";

export async function createOrganization(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    redirect(`/onboarding?error=${encodeURIComponent("Company name is required.")}`);
  }

  // Seed the picked trade's job codes (deck, electrical, …); falls back to a
  // trade-neutral default when the trade is unknown/blank. The org can edit them
  // in Settings anytime.
  const trade = String(formData.get("trade") ?? "");
  const codes = TRADE_PRESETS[trade]?.codes ?? null;

  // Atomic, RLS-safe: creates the org, makes the caller its owner, seeds the trade's
  // job codes + a safety form. (See create_organization in 0078.)
  const { error } = await supabase.rpc("create_organization", { p_name: name, p_codes: codes });
  if (error) {
    redirect(`/onboarding?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/", "layout");
  redirect("/planner");
}

export async function acceptInvitation() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.rpc("accept_invitation");
  if (error) {
    redirect(`/onboarding?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/", "layout");
  redirect("/planner");
}
