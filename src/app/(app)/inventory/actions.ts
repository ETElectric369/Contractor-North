"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string; id?: string };

/** Every write here org-scopes by id AND asks for the row back.
 *
 *  THE SILENT-WRITE LAW, and why this file needed it. A PostgREST update that matches no row is a
 *  204: no error, no rows, and the code above reads it as saved. Before cn-v964 all four actions
 *  checked only `error`, so an item belonging to another org (or one deleted in another tab) came
 *  back from "Save changes" looking saved and was not. That mattered little while the table had
 *  zero rows in it; stock now ARRIVES from receipts (lib/stock-flow.ts), so these counts are about
 *  to be numbers Erik orders against. `.select("id")` on every write, zero rows is a failure. */
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
      quantity_on_hand: Number(formData.get("quantity_on_hand")) || 0,
      reorder_point: Number(formData.get("reorder_point")) || 0,
      unit_cost: numOrNull(formData.get("unit_cost")),
      vendor: emptyToNull(formData.get("vendor")),
      location: emptyToNull(formData.get("location")),
    })
    .select("id");

  if (error) return { ok: false, error: dbError(error) };
  const id = data?.[0]?.id as string | undefined;
  if (!id) return { ok: false, error: "That item didn't save. Nothing was added - try again." };
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
      unit_cost: numOrNull(formData.get("unit_cost")),
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

/** Adjust quantity on hand by a delta (+ received, − used), or set it after a recount.
 *
 *  IT REFUSES TO GO BELOW ZERO RATHER THAN CLAMPING TO IT. `Math.max(0, ...)` was the app deciding
 *  the shelf was right and the person was wrong, without saying so - and the count it wrote was
 *  then a number nobody had chosen. Same rule as drawStockForJob in lib/stock-flow.ts: say the
 *  real number and let him decide. */
export async function adjustQuantity(id: string, delta: number): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  if (!Number.isFinite(delta)) return { ok: false, error: "That count isn't a number." };

  const { data: item, error: readErr } = await supabase
    .from("inventory_items")
    .select("quantity_on_hand")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  if (!item) return { ok: false, error: "That item isn't there any more. Reload the page and try again." };

  // Untyped client: coerce before doing arithmetic on it.
  const onHand = Number(item.quantity_on_hand ?? 0);
  if (!Number.isFinite(onHand)) return { ok: false, error: "This item's count didn't come through as a number." };
  const next = Math.round((onHand + delta) * 100) / 100;
  if (next < 0) {
    return {
      ok: false,
      error: `There ${onHand === 1 ? "is" : "are"} only ${onHand} on hand, so that would put it below zero.`,
    };
  }

  const { data, error } = await supabase
    .from("inventory_items")
    .update({ quantity_on_hand: next })
    .eq("id", id)
    .eq("org_id", orgId)
    // The count read above has to still be the count being written over. Two people counting the
    // same shelf on two phones would otherwise each write their own total and the last one would
    // win silently.
    .eq("quantity_on_hand", item.quantity_on_hand)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length)
    return { ok: false, error: "What's on hand changed while this was saving, so nothing was written. Reload and try again." };

  revalidatePath("/inventory");
  return { ok: true };
}

function numOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  return s.length ? Number(s) : null;
}
