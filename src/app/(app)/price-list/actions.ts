"use server";
import { dbError } from "@/lib/db-error";

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
  if (error) return { ok: false, error: dbError(error) };
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
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/price-list");
  return { ok: true };
}

export async function deletePriceItem(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("price_list_items").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/price-list");
  return { ok: true };
}

/** Bulk insert from a parsed CSV. Inserts in chunks; returns the count. */
export async function bulkImportPriceItems(rows: PriceItemInput[]): Promise<Result> {
  // requireStaff, like every other write in this file. The DB boundary already holds — 0020's
  // price_list_write policy carries `is_org_staff()` and the stamp_org_price_list trigger sets
  // org_id — so this was never a hole. It was the ONE action here that let a tech through to a
  // raw Postgres RLS message instead of a sentence, and an app guard that disagrees with its own
  // siblings is how the two eventually drift apart.
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

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

/**
 * APPLY A SUPPLIER-QUOTE REVIEW — only ever the rows a person ticked.
 *
 * Erik: "some people arent going to want anything to override anything so maybe that should be
 * handled lightly per org or a flag for review." This is the flag-for-review shape: the supplier
 * upload PROPOSES (lib/pricing/book-review sorts lines into updates/additions, matching by exact
 * code or exact normalized description, no fuzzy rung), the review card shows old → new with
 * every tick DEFAULT OFF, and this action receives only what was ticked. Nothing overrides
 * silently, ever. A per-org auto-apply default can sit on top the day an org asks.
 *
 * PROVENANCE RIDES THE `supplier` COLUMN — "CED quote · Aug 15, 2026" — so a price always says
 * where it came from, which is the difference between a book and a pile of numbers.
 */
export async function applyPriceBookReview(
  updates: { itemId: string; newBuy: number }[],
  additions: { description: string; unit: string; newBuy: number }[],
  sourceLabel: string,
): Promise<{ ok: boolean; error?: string; updated?: number; added?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const source = sourceLabel.trim().slice(0, 80) || "supplier quote";

  // Bounded: a review is a human reading rows, not a bulk import — the CSV importer exists for
  // that. 200 covers any real quote and stops a crafted payload rewriting the whole book.
  const ups = updates.slice(0, 200).filter((u) => u.itemId && Number.isFinite(u.newBuy) && u.newBuy >= 0);
  const adds = additions.slice(0, 200).filter((a) => a.description?.trim() && Number.isFinite(a.newBuy) && a.newBuy >= 0);
  if (!ups.length && !adds.length) return { ok: false, error: "Nothing was ticked." };

  let updated = 0;
  for (const u of ups) {
    // Per-row, with the silent-write check — one refused row must not report the whole review
    // applied. RLS scopes the id to this org.
    const { data: wrote, error } = await supabase
      .from("price_list_items")
      .update({ buy_price: Math.round(u.newBuy * 100) / 100, supplier: source })
      .eq("id", u.itemId)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (wrote?.length) updated++;
  }

  let added = 0;
  if (adds.length) {
    const { data: ins, error } = await supabase
      .from("price_list_items")
      .insert(
        adds.map((a) => ({
          description: a.description.trim(),
          unit: a.unit?.trim() || "ea",
          buy_price: Math.round(a.newBuy * 100) / 100,
          // markup_pct 0 = the item rung is vacuous, so pricing falls through to customer level →
          // org default — the same ladder every other line rides.
          markup_pct: 0,
          supplier: source,
        })),
      )
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    added = ins?.length ?? 0;
  }

  revalidatePath("/price-list");
  return { ok: true, updated, added };
}
