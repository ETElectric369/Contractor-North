"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { TRADE_PRESETS } from "@/lib/trade-codes";
import { featurePreset, normalizeTradeKey } from "@/lib/features";

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

  // THE TRADE IS KEPT NOW (0352). It seeds the picked trade's job codes (deck, electrical, …), and
  // it is saved as the company's trade key with its starting switches (lib/features featurePreset).
  // "Other / Not Listed" is a real answer: trade-neutral codes and the light preset. No answer at
  // all is not one: the select is required, and a form that arrives without it says so.
  const picked = String(formData.get("trade") ?? "").trim();
  if (!picked) {
    redirect(`/onboarding?error=${encodeURIComponent("Pick your trade, or Other / Not Listed.")}`);
  }
  const trade = normalizeTradeKey(picked); // "other" and anything unknown → "" (blank)
  const codes = trade ? (TRADE_PRESETS[trade]?.codes ?? null) : null;

  // Atomic, RLS-safe: creates the org, makes the caller its owner, seeds the trade's job codes + a
  // safety form, and saves the trade and its switches. (See create_organization in 0352.)
  let { error } = await supabase.rpc("create_organization", {
    p_name: name,
    p_codes: codes,
    p_trade: trade || null,
    p_features: featurePreset(trade),
  });
  // PGRST202: the database doesn't have 0352 yet. The company is still made the old way; with no
  // switches stored, every feature reads as on (today's app), and the trade is only lost as before.
  if (error?.code === "PGRST202") {
    ({ error } = await supabase.rpc("create_organization", { p_name: name, p_codes: codes }));
  }
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
