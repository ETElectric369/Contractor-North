"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { searchPaidPrices, type LearnedPrice } from "@/lib/pricing/learned-prices";

export type Result = { ok: boolean; error?: string; imported?: number };

/** "What I've paid" — real material costs learned from this org's own bills. Staff-only (cost data),
 *  RLS-scoped to the org via the authed client. Returns [] when there's no purchase history. */
export async function searchMyPrices(query: string): Promise<{ ok: boolean; items: LearnedPrice[]; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, items: [], error: ctx.error };
  const items = await searchPaidPrices(ctx.supabase, String(query ?? ""), 40);
  return { ok: true, items };
}

export interface PriceItemInput {
  code?: string | null;
  description: string;
  category?: string | null;
  supplier?: string | null;
  unit?: string;
  buy_price?: number;
  markup_pct?: number;
}

export async function createPriceItem(input: PriceItemInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.description?.trim()) return { ok: false, error: "Description is required." };
  const { error } = await supabase.from("price_list_items").insert({
    code: input.code?.trim() || null,
    description: input.description.trim(),
    category: input.category?.trim() || null,
    supplier: input.supplier?.trim() || null,
    unit: input.unit?.trim() || "ea",
    buy_price: Number.isFinite(input.buy_price) ? input.buy_price : 0,
    markup_pct: Number.isFinite(input.markup_pct) ? input.markup_pct : 0,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/price-list");
  return { ok: true };
}

export async function updatePriceItem(id: string, patch: PriceItemInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const clean: Record<string, unknown> = {};
  if (patch.code !== undefined) clean.code = patch.code?.trim() || null;
  if (patch.description !== undefined) clean.description = patch.description.trim();
  if (patch.category !== undefined) clean.category = patch.category?.trim() || null;
  if (patch.supplier !== undefined) clean.supplier = patch.supplier?.trim() || null;
  if (patch.unit !== undefined) clean.unit = patch.unit?.trim() || "ea";
  if (patch.buy_price !== undefined) clean.buy_price = patch.buy_price ?? 0;
  if (patch.markup_pct !== undefined) clean.markup_pct = patch.markup_pct ?? 0;
  const { error } = await supabase.from("price_list_items").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/price-list");
  return { ok: true };
}

export async function deletePriceItem(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("price_list_items").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/price-list");
  return { ok: true };
}

/** Bulk insert from a parsed CSV. Inserts in chunks; returns the count. */
export async function bulkImportPriceItems(rows: PriceItemInput[]): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const clean = rows
    .filter((r) => r.description?.trim())
    .map((r) => ({
      code: r.code?.toString().trim() || null,
      description: r.description.toString().trim(),
      category: r.category?.toString().trim() || null,
      supplier: r.supplier?.toString().trim() || null,
      unit: r.unit?.toString().trim() || "ea",
      buy_price: Number.isFinite(Number(r.buy_price)) ? Number(r.buy_price) : 0,
      markup_pct: Number.isFinite(Number(r.markup_pct)) ? Number(r.markup_pct) : 0,
    }));

  if (clean.length === 0) return { ok: false, error: "No valid rows found in the file." };

  let imported = 0;
  for (let i = 0; i < clean.length; i += 500) {
    const chunk = clean.slice(i, i + 500);
    const { error } = await supabase.from("price_list_items").insert(chunk);
    if (error) return { ok: false, error: `${error.message} (after ${imported} rows)` };
    imported += chunk.length;
  }
  revalidatePath("/price-list");
  return { ok: true, imported };
}
