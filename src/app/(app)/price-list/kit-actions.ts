"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string; id?: string };

export type KitImportRow = { kit: string; category?: string; description: string; quantity?: string; unit?: string; unit_price?: string };

/** Bulk-import kits (preset line-item bundles) from a CSV. Each row is ONE line item with a `kit`
 *  column that groups rows into kits — so an office can build "Deck Package A" etc. in a spreadsheet
 *  and import them instead of hand-entering each. Staff-gated; org_id is stamped by the set_org_id
 *  trigger (same as createKit). One bad kit's items are skipped, not the whole import. */
export async function bulkImportKits(rows: KitImportRow[]): Promise<Result & { kits?: number; items?: number; skipped?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // Group by kit name (in order), skipping rows missing a kit name or a description.
  const groups = new Map<string, KitImportRow[]>();
  let skipped = 0;
  for (const r of rows ?? []) {
    const kit = (r.kit ?? "").trim();
    const desc = (r.description ?? "").trim();
    if (!kit || !desc) { skipped++; continue; }
    const arr = groups.get(kit) ?? [];
    arr.push(r);
    groups.set(kit, arr);
  }
  if (groups.size === 0) return { ok: false, error: "No valid rows — need a 'kit' name and a 'description' per row." };

  const num = (v: string | undefined, dflt: number) => {
    const s = (v ?? "").replace(/[$,]/g, "").trim();
    if (!s) return dflt; // blank → default (Number("") is 0, which would wrongly skip the default)
    const n = Number(s);
    return Number.isFinite(n) ? n : dflt;
  };
  let kitsCreated = 0;
  let itemsCreated = 0;
  for (const [name, items] of groups) {
    const category = items.map((i) => (i.category ?? "").trim()).find(Boolean) || null;
    const { data: kit, error: kErr } = await supabase.from("kits").insert({ name, category }).select("id").single();
    if (kErr || !kit) { skipped += items.length; continue; }
    kitsCreated++;
    const itemRows = items.map((it, idx) => ({
      kit_id: kit.id,
      description: it.description.trim(),
      quantity: Math.max(0, num(it.quantity, 1)),
      unit: (it.unit ?? "").trim() || "ea",
      unit_price: Math.max(0, num(it.unit_price, 0)),
      sort_order: idx,
    }));
    const { error: iErr } = await supabase.from("kit_items").insert(itemRows);
    if (iErr) { skipped += itemRows.length; continue; }
    itemsCreated += itemRows.length;
  }
  revalidatePath("/price-list");
  return { ok: true, kits: kitsCreated, items: itemsCreated, skipped };
}

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

export async function updateKit(
  id: string,
  input: { name: string; category?: string | null },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  // Org-safe: RLS scopes the row to the caller's org; we confirm it's visible
  // before mutating so a hidden/foreign id can't be silently updated.
  const { data: existing } = await supabase.from("kits").select("id").eq("id", id).maybeSingle();
  if (!existing) return { ok: false, error: "Kit not found." };
  const { error } = await supabase
    .from("kits")
    .update({ name: input.name.trim(), category: input.category?.trim() || null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/price-list");
  return { ok: true };
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

export async function updateKitItem(
  id: string,
  input: { description: string; quantity?: number; unit?: string; unit_price?: number },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.description.trim()) return { ok: false, error: "Description is required." };
  // Org-safe: RLS scopes the row to the caller's org; confirm it's visible
  // before mutating so a hidden/foreign id can't be silently updated.
  const { data: existing } = await supabase.from("kit_items").select("id").eq("id", id).maybeSingle();
  if (!existing) return { ok: false, error: "Line item not found." };
  const { error } = await supabase
    .from("kit_items")
    .update({
      description: input.description.trim(),
      quantity: input.quantity ?? 1,
      unit: input.unit?.trim() || "ea",
      unit_price: input.unit_price ?? 0,
    })
    .eq("id", id);
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
