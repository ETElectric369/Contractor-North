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
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.description.trim()) return { ok: false, error: "Description is required." };
  // Org-safe: RLS scopes the kit to the caller's org; confirm it's visible before
  // inserting so a hidden/foreign kit_id can't be written into.
  const { data: kit } = await supabase.from("kits").select("id").eq("id", input.kit_id).maybeSingle();
  if (!kit) return { ok: false, error: "Kit not found." };
  // New items land at the END of the kit — max existing sort_order + 1 (legacy rows
  // all default 0, so appends stay after them and keep a stable authored order).
  const { data: last } = await supabase
    .from("kit_items")
    .select("sort_order")
    .eq("kit_id", input.kit_id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  // Same clamp as updateKitItems — a NaN/negative from a direct caller must not land
  // in a kit template (every future estimate would inherit it).
  const qty = typeof input.quantity === "number" && Number.isFinite(input.quantity) ? Math.max(0, input.quantity) : 1;
  const price = typeof input.unit_price === "number" && Number.isFinite(input.unit_price) ? Math.max(0, input.unit_price) : 0;
  const { data, error } = await supabase
    .from("kit_items")
    .insert({
      kit_id: input.kit_id,
      description: input.description.trim(),
      quantity: qty,
      unit: input.unit?.trim() || "ea",
      unit_price: price,
      sort_order: (Number(last?.sort_order) || 0) + 1,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not add the item." };
  revalidatePath("/price-list");
  return { ok: true, id: data.id };
}

/** Batch-write the Kit Picker's row edits back onto the kit itself — the explicit
 *  "Save changes to kit" path (never silent; import edits alone stay quote-only).
 *  Only ids that actually belong to this kit are touched, so a forged/foreign id in
 *  the payload is skipped rather than upserted into existence. Deleting kit items
 *  stays in Price list & kits. */
export async function updateKitItems(
  kitId: string,
  edits: { id: string; description: string; quantity: number; unit: string; unit_price: number }[],
): Promise<Result & { updated?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Org-safe: RLS scopes the kit to the caller's org; confirm it's visible before mutating.
  const { data: kit } = await supabase.from("kits").select("id").eq("id", kitId).maybeSingle();
  if (!kit) return { ok: false, error: "Kit not found." };
  const { data: owned } = await supabase.from("kit_items").select("id").eq("kit_id", kitId);
  const ownedIds = new Set((owned ?? []).map((r) => r.id));
  let updated = 0;
  for (const e of edits ?? []) {
    if (!ownedIds.has(e.id) || !e.description.trim()) continue;
    const { error } = await supabase
      .from("kit_items")
      .update({
        description: e.description.trim(),
        quantity: Number.isFinite(e.quantity) ? Math.max(0, e.quantity) : 1,
        unit: e.unit?.trim() || "ea",
        unit_price: Number.isFinite(e.unit_price) ? Math.max(0, e.unit_price) : 0,
      })
      .eq("id", e.id);
    if (error) return { ok: false, error: error.message };
    updated++;
  }
  revalidatePath("/price-list");
  return { ok: true, updated };
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
