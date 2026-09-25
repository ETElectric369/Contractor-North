"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { requireStaff } from "@/lib/staff-guard";

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

/*
 * adjustQuantity IS GONE (Shop Stock, 0303). What is on hand is a cache the shelf's own record keeps
 * (rolls in, pieces out), and the database refuses a typed-over count, so a door that typed one
 * would only ever say no. Counting the shelf comes back as Count It (a recount move, Phase 2), the
 * one way a count can change without a number nobody can trace.
 */

