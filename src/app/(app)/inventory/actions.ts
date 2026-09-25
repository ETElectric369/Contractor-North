"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { requireStaff } from "@/lib/staff-guard";
import { SHELF_NEEDS_0328, isMissingShelfRpc, undoTake, unshelveLot } from "@/lib/stock-ledger";
import type { ShelfPickerItem } from "@/lib/shelf-plan";

export type Result = { ok: boolean; error?: string; id?: string };

/** Every write here org-scopes by id AND asks for the row back.
 *
 *  WHAT THESE NO LONGER WRITE (Shop Stock, 0303): quantity_on_hand, which the shelf's record keeps
 *  (a typed number is refused by the database), and unit_cost, which lives per purchase on the lots
 *  now, to the cent. An item is its name, part number, category, unit, reorder point, vendor and
 *  where it lives.
 *
 *  THE SILENT-WRITE LAW, and why this file needed it. A PostgREST update that matches no row is a
 *  204: no error, no rows, and the code above reads it as saved. Before cn-v964 all four actions
 *  checked only `error`, so an item belonging to another org (or one deleted in another tab) came
 *  back from "Save changes" looking saved and was not. That mattered little while the table had
 *  zero rows in it; the shelf now keeps real counts and real costs (lib/stock-ledger.ts, 0303), so
 *  these are about to be numbers Erik orders against. `.select("id")` on every write, zero rows is a failure. */
const NO_ORG = "Your sign-in isn't attached to a company yet, so there's no stock list to change.";

export async function createInventoryItem(formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { data, error } = await supabase
    .from("inventory_items")
    .insert({
      org_id: orgId,
      name,
      part_number: emptyToNull(formData.get("part_number")),
      category: emptyToNull(formData.get("category")),
      unit: String(formData.get("unit") ?? "ea") || "ea",
      reorder_point: Number(formData.get("reorder_point")) || 0,
      vendor: emptyToNull(formData.get("vendor")),
      location: emptyToNull(formData.get("location")),
    })
    .select("id");

  if (error) return { ok: false, error: dbError(error) };
  const id = data?.[0]?.id as string | undefined;
  if (!id) return { ok: false, error: "That item didn't save. Nothing was added - try again." };

  // ALREADY ON THE SHELF: its first roll, counted in (an opening roll: a count, a typed cost and a
  // note). Checked before it is written, and a refusal says the item itself was made.
  const openingPieces = Number(formData.get("opening_pieces")) || 0;
  if (openingPieces > 0) {
    const roll = await addOpeningRoll({
      itemId: id,
      pieces: openingPieces,
      cost: Number(formData.get("opening_cost")) || 0,
      note: String(formData.get("opening_note") ?? ""),
    });
    if (!roll.ok) {
      revalidatePath("/inventory");
      return { ok: false, id, error: `The item is made, but its roll didn't go on the shelf: ${roll.error} Add it from the item's row with Add A Roll Counted In.` };
    }
  }
  revalidatePath("/inventory");
  return { ok: true, id };
}

export async function updateInventoryItem(id: string, formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { data, error } = await supabase
    .from("inventory_items")
    .update({
      name,
      part_number: emptyToNull(formData.get("part_number")),
      category: emptyToNull(formData.get("category")),
      unit: String(formData.get("unit") ?? "ea") || "ea",
      reorder_point: Number(formData.get("reorder_point")) || 0,
      vendor: emptyToNull(formData.get("vendor")),
      location: emptyToNull(formData.get("location")),
    })
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That item isn't there any more. Reload the page and try again." };
  revalidatePath("/inventory");
  return { ok: true };
}

export async function deleteInventoryItem(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const { data, error } = await supabase
    .from("inventory_items")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That item was already gone. The list is up to date." };
  revalidatePath("/inventory");
  return { ok: true };
}

/**
 * MARK INACTIVE / MAKE ACTIVE (review of Phase 2). An item with rolls or moves on the shelf's record
 * can never be deleted (0304 keeps its history), and that refusal names this door, so it has to
 * exist. Inactive hides the item from Shop Stock and the pickers; it never hides money, so an item
 * with anything still on the shelf is refused until it is counted to 0. A roll that later lands on
 * the item makes it active again (shelve_bill_lines, 0328).
 */
export async function setInventoryItemActive(id: string, active: boolean): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  if (!active) {
    const { data: item, error: itemErr } = await supabase
      .from("inventory_items")
      .select("id, name, unit, quantity_on_hand")
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (itemErr) return { ok: false, error: dbError(itemErr) };
    if (!item) return { ok: false, error: "That item isn't there any more. Reload the page and try again." };
    const { data: live, error: liveErr } = await supabase
      .from("stock_lot_balance")
      .select("lot_id, pieces_left, cost_left")
      .eq("org_id", orgId)
      .eq("item_id", id)
      .eq("live", true);
    if (liveErr) return { ok: false, error: dbError(liveErr) };
    const left = ((live ?? []) as { pieces_left?: unknown; cost_left?: unknown }[]).some(
      (l) => Number(l.pieces_left) > 0 || Number(l.cost_left) > 0,
    );
    const onHand = Number((item as { quantity_on_hand?: unknown }).quantity_on_hand) || 0;
    if (left || onHand !== 0) {
      const it = item as { name: string; unit: string };
      return {
        ok: false,
        error: `${it.name} still has ${onHand} ${it.unit} on the shelf's record. Count It to 0 first, so its value doesn't disappear from Shop Stock with it.`,
      };
    }
  }
  const { data, error } = await supabase
    .from("inventory_items")
    .update({ active })
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That item isn't there any more. Reload the page and try again." };
  revalidatePath("/inventory");
  return { ok: true };
}

/*
 * adjustQuantity IS GONE (Shop Stock, 0303). What is on hand is a cache the shelf's own record keeps
 * (rolls in, pieces out), and the database refuses a typed-over count, so a door that typed one
 * would only ever say no. Counting the shelf is Count It below (recount moves, 0328), the one way a
 * count can change without a number nobody can trace.
 */

/** The shelf's items for a picker: names and units only, never a cost (Shop Stock, Phase 2). */
export async function shelfPickerItems(): Promise<{ ok: true; items: ShelfPickerItem[] } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This is office-only." };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const { data, error } = await supabase
    .from("inventory_items")
    .select("id, name, unit, key_part, part_number, price_item_id, created_at")
    .eq("org_id", orgId)
    .eq("active", true)
    .order("name")
    .limit(2000);
  if (error) return { ok: false, error: dbError(error) };
  return { ok: true, items: (data ?? []) as ShelfPickerItem[] };
}

/**
 * COUNT IT (Shop Stock, 0328). A person counted what is really on the shelf. Fewer than the record
 * are written off oldest roll first at what they cost (Shop Stock Lost); more are found pieces at
 * $0 (no paper behind them). Nothing is typed over: each difference is a move with an Undo.
 */
export async function countItem(itemId: string, counted: number, note?: string | null): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const n = Number(counted);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Say how many are on the shelf (0 if none)." };
  const { data, error } = await supabase.rpc("stock_recount", { p_item: itemId, p_counted: n, p_note: note ?? null });
  if (error) return { ok: false, error: isMissingShelfRpc(error) ? SHELF_NEEDS_0328.replace("Putting things on the shelf", "Counting the shelf") : dbError(error) };
  const d = (data ?? {}) as { changed?: boolean; on_hand?: unknown; moves?: { kind: string; qty: unknown }[] };
  revalidatePath("/inventory");
  if (!d.changed) return { ok: true, message: "That matches the shelf's record. Nothing changed." };
  const down = (d.moves ?? []).filter((m) => m.kind === "recount_down").reduce((s, m) => s + Number(m.qty || 0), 0);
  const up = (d.moves ?? []).filter((m) => m.kind === "recount_up").reduce((s, m) => s + Number(m.qty || 0), 0);
  return {
    ok: true,
    message: down > 0
      ? `Counted: ${Number(d.on_hand)} on the shelf. ${Math.round(down * 1000) / 1000} short were written off at what they cost (Shop Stock Lost).`
      : `Counted: ${Number(d.on_hand)} on the shelf. ${Math.round(up * 1000) / 1000} found, at $0 (no receipt behind them).`,
  };
}

/** Undo a count, a write-off or a found piece: an office upkeep move. A take is undone by stock_undo. */
export async function undoShelfMove(moveId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const { data, error } = await supabase
    .from("stock_moves")
    .update({ undone_at: new Date().toISOString() })
    .eq("id", moveId)
    .eq("org_id", orgId)
    .in("kind", ["recount_down", "recount_up"])
    .is("undone_at", null)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That count is already undone, or isn't a count. Reload to see where it stands." };
  revalidatePath("/inventory");
  return { ok: true };
}

/** Undo a take from the shelf (Phase 3's Took From Stock), until an invoice bills it. */
export async function undoShelfTake(drawGroup: string): Promise<Result> {
  const res = await undoTake(drawGroup);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Take a roll back off the shelf before anything was taken from it. */
export async function takeLotOffShelf(lotId: string): Promise<Result> {
  const res = await unshelveLot(lotId);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * A MANUAL ADD IS AN OPENING ROLL (the plan's Phase 2): something already on the shelf with no
 * receipt in the app. It needs a count, what it cost (typed, $0 allowed) and a note saying where
 * the figure came from, so nobody later mistakes it for paper.
 */
export async function addOpeningRoll(input: { itemId: string; pieces: number; cost: number; note: string }): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const pieces = Number(input.pieces);
  const cost = Math.round((Number(input.cost) || 0) * 100) / 100;
  const note = String(input.note ?? "").trim();
  if (!(pieces > 0)) return { ok: false, error: "Say how many are on the shelf." };
  if (cost < 0) return { ok: false, error: "What it cost can't be below $0." };
  if (!note) return { ok: false, error: "Say where this came from (for example, \"counted in the truck, 9/24\"). A roll with no receipt needs a note." };
  const { data: item, error: itemErr } = await supabase.from("inventory_items").select("id, unit").eq("id", input.itemId).eq("org_id", orgId).maybeSingle();
  if (itemErr) return { ok: false, error: dbError(itemErr) };
  if (!item) return { ok: false, error: "That item isn't on this company's shelf any more. Reload and try again." };
  const { data, error } = await supabase
    .from("stock_lots")
    .insert({ org_id: orgId, item_id: input.itemId, kind: "opening", pieces: Math.round(pieces * 1000) / 1000, unit: (item as { unit: string }).unit, cost, note })
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That roll didn't go on the shelf. Nothing changed - try again." };
  revalidatePath("/inventory");
  return { ok: true, id: String(data[0].id) };
}

