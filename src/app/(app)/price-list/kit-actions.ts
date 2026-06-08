"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string; id?: string };

export async function createKit(input: { name: string; category?: string | null }): Promise<Result> {
  const supabase = await createClient();
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  const { data, error } = await supabase
    .from("kits")
    .insert({ name: input.name.trim(), category: input.category?.trim() || null })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath("/price-list");
  return { ok: true, id: data.id };
}

export async function deleteKit(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("kits").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/price-list");
  return { ok: true };
}

export async function addKitItem(input: {
  kit_id: string;
  description: string;
  quantity?: number;
  unit?: string;
  unit_price?: number;
}): Promise<Result> {
  const supabase = await createClient();
  if (!input.description.trim()) return { ok: false, error: "Description is required." };
  const { error } = await supabase.from("kit_items").insert({
    kit_id: input.kit_id,
    description: input.description.trim(),
    quantity: input.quantity ?? 1,
    unit: input.unit?.trim() || "ea",
    unit_price: input.unit_price ?? 0,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/price-list");
  return { ok: true };
}

export async function deleteKitItem(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("kit_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/price-list");
  return { ok: true };
}
