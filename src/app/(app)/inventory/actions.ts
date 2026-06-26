"use server";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string; id?: string };

export async function createInventoryItem(formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { error } = await supabase.from("inventory_items").insert({
    name,
    part_number: emptyToNull(formData.get("part_number")),
    category: emptyToNull(formData.get("category")),
    unit: String(formData.get("unit") ?? "ea") || "ea",
    quantity_on_hand: Number(formData.get("quantity_on_hand")) || 0,
    reorder_point: Number(formData.get("reorder_point")) || 0,
    unit_cost: numOrNull(formData.get("unit_cost")),
    vendor: emptyToNull(formData.get("vendor")),
    location: emptyToNull(formData.get("location")),
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/inventory");
  return { ok: true };
}

export async function updateInventoryItem(id: string, formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { error } = await supabase
    .from("inventory_items")
    .update({
      name,
      part_number: emptyToNull(formData.get("part_number")),
      category: emptyToNull(formData.get("category")),
      unit: String(formData.get("unit") ?? "ea") || "ea",
      reorder_point: Number(formData.get("reorder_point")) || 0,
      unit_cost: numOrNull(formData.get("unit_cost")),
      vendor: emptyToNull(formData.get("vendor")),
      location: emptyToNull(formData.get("location")),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/inventory");
  return { ok: true };
}

export async function deleteInventoryItem(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("inventory_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/inventory");
  return { ok: true };
}

/** Adjust quantity on hand by a delta (+ received, − used). */
export async function adjustQuantity(
  id: string,
  delta: number,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: item, error: readErr } = await supabase
    .from("inventory_items")
    .select("quantity_on_hand")
    .eq("id", id)
    .single();
  if (readErr) return { ok: false, error: readErr.message };

  const next = Math.max(0, Number(item.quantity_on_hand) + delta);
  const { error } = await supabase
    .from("inventory_items")
    .update({ quantity_on_hand: next })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/inventory");
  return { ok: true };
}

function numOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  return s.length ? Number(s) : null;
}
