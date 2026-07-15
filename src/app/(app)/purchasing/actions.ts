"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { subtotalTaxTotal } from "@/lib/invoice-math";

export type Result = { ok: boolean; error?: string; id?: string };

/** Create a PO. If sourceListId is given, seed its items from a material list.
 *  Seeding failures are LOUD: Erik's 7/14 field test produced a "seeded" PO with
 *  zero items — an empty PO that claims it imported a list is worse than an error,
 *  so every step here either works or returns why it didn't (and never strands a
 *  misleading empty PO). */
export async function createPurchaseOrder(input: {
  vendor: string;
  job_id: string | null;
  source_list_id: string | null;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // Resolve the seed list FIRST (RLS-scoped, same pattern as updatePurchaseOrder's
  // job check) so an invisible list or a read error fails before a PO exists.
  let seedItems: any[] | null = null;
  if (input.source_list_id) {
    const { data: list, error: listError } = await supabase
      .from("material_lists")
      .select("id")
      .eq("id", input.source_list_id)
      .maybeSingle();
    if (listError) return { ok: false, error: listError.message };
    if (!list) return { ok: false, error: "That material list isn't visible to you." };

    const { data: items, error: itemsError } = await supabase
      .from("material_list_items")
      .select("description, part_number, quantity, unit, est_cost")
      .eq("list_id", input.source_list_id)
      .order("sort_order");
    if (itemsError) return { ok: false, error: itemsError.message };
    seedItems = items ?? [];
  }

  const { data: po, error } = await supabase
    .from("purchase_orders")
    .insert({
      vendor: input.vendor.trim() || "CED",
      job_id: input.job_id,
      status: "draft",
      created_by: user.id,
      // Provenance backlink (migration 0049) — validated as visible above.
      source_list_id: input.source_list_id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  if (seedItems?.length) {
    const rows = seedItems.map((it: any, idx: number) => ({
      po_id: po.id,
      description: it.description,
      part_number: it.part_number,
      quantity: it.quantity,
      unit: it.unit ?? "ea",
      unit_cost: Number(it.est_cost) || 0,
      sort_order: idx,
    }));
    const { error: seedError } = await supabase
      .from("purchase_order_items")
      .insert(rows);
    if (seedError) {
      // Roll the empty shell back and surface the real failure.
      await supabase.from("purchase_orders").delete().eq("id", po.id);
      return {
        ok: false,
        error: `Couldn't copy the list items onto the PO: ${seedError.message}`,
      };
    }
    await recalcPoTotals(supabase, po.id);
  }

  revalidatePath("/purchasing");
  return { ok: true, id: po.id };
}

export async function addPoItem(
  poId: string,
  item: {
    description: string;
    part_number: string | null;
    quantity: number;
    unit: string;
    unit_cost: number;
  },
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("purchase_order_items").insert({
    po_id: poId,
    description: item.description,
    part_number: item.part_number,
    quantity: item.quantity || 1,
    unit: item.unit || "ea",
    unit_cost: item.unit_cost || 0,
  });
  if (error) return { ok: false, error: error.message };
  await recalcPoTotals(supabase, poId);
  revalidatePath(`/purchasing/${poId}`);
  return { ok: true };
}

/** Edit a PO line in place. Preserves received_qty; recalcs PO totals. */
export async function updatePoItem(
  itemId: string,
  poId: string,
  patch: {
    description: string;
    part_number: string | null;
    quantity: number;
    unit: string;
    unit_cost: number;
  },
): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { error } = await supabase
    .from("purchase_order_items")
    .update({
      description: patch.description,
      part_number: patch.part_number,
      quantity: patch.quantity || 1,
      unit: patch.unit || "ea",
      unit_cost: patch.unit_cost || 0,
      // received_qty intentionally untouched — receiving history is preserved.
    })
    .eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  await recalcPoTotals(supabase, poId);
  revalidatePath(`/purchasing/${poId}`);
  return { ok: true };
}

export async function deletePoItem(itemId: string, poId: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("purchase_order_items")
    .delete()
    .eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  await recalcPoTotals(supabase, poId);
  revalidatePath(`/purchasing/${poId}`);
  return { ok: true };
}

export async function setPoStatus(id: string, status: string): Promise<Result> {
  const supabase = await createClient();
  const patch: Record<string, unknown> = { status };
  if (status === "sent") patch.ordered_at = new Date().toISOString();
  const { error } = await supabase.from("purchase_orders").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/purchasing");
  revalidatePath(`/purchasing/${id}`);
  return { ok: true };
}

/** Edit a PO's header (vendor + linked job). Job id validated as visible via RLS.
 *  PATCH semantics: only the keys the caller sent are written — an omitted field never
 *  touches its column (it used to reset the vendor to CED and unlink the job). */
export async function updatePurchaseOrder(
  id: string,
  patch: { vendor?: string; description?: string | null; job_id?: string | null },
): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const clean: Record<string, unknown> = {};
  if (patch.vendor !== undefined) clean.vendor = patch.vendor.trim() || "CED";
  if (patch.description !== undefined) clean.description = patch.description?.trim() || null;
  if (patch.job_id !== undefined) {
    // Only accept a job the caller can actually see (RLS-scoped); otherwise clear it.
    let jobId: string | null = null;
    if (patch.job_id) {
      const { data: job } = await supabase
        .from("jobs")
        .select("id")
        .eq("id", patch.job_id)
        .maybeSingle();
      jobId = job?.id ?? null;
    }
    clean.job_id = jobId;
  }
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };

  const { error } = await supabase
    .from("purchase_orders")
    .update(clean)
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/purchasing");
  revalidatePath(`/purchasing/${id}`);
  return { ok: true };
}

export async function deletePurchaseOrder(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("purchase_orders").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/purchasing");
  revalidatePath("/bills");
  return { ok: true };
}

/** Mark a line fully received; recompute PO status from line receipts. */
export async function receiveItem(
  itemId: string,
  poId: string,
  receivedQty: number,
): Promise<Result> {
  const supabase = await createClient();
  const { data: item } = await supabase
    .from("purchase_order_items")
    .select("received_qty, part_number, description, unit, unit_cost")
    .eq("id", itemId)
    .maybeSingle();
  const oldQty = Number(item?.received_qty ?? 0);
  const newQty = Math.max(0, receivedQty);
  const { error } = await supabase
    .from("purchase_order_items")
    .update({ received_qty: newQty })
    .eq("id", itemId);
  if (error) return { ok: false, error: error.message };

  // Received goods flow into stock: add the delta to the matching inventory item
  // (by part number), creating it if it's new. Lines with no part number are
  // skipped (nothing reliable to match on).
  const delta = newQty - oldQty;
  const pn = item?.part_number?.trim();
  if (delta !== 0 && pn) {
    const { data: inv } = await supabase
      .from("inventory_items")
      .select("id, quantity_on_hand")
      .eq("part_number", pn)
      .limit(1)
      .maybeSingle();
    if (inv) {
      await supabase
        .from("inventory_items")
        .update({ quantity_on_hand: Number(inv.quantity_on_hand) + delta, updated_at: new Date().toISOString() })
        .eq("id", inv.id);
    } else if (delta > 0) {
      await supabase.from("inventory_items").insert({
        name: item?.description || pn,
        part_number: pn,
        unit: item?.unit || "ea",
        quantity_on_hand: delta,
        unit_cost: item?.unit_cost ?? null,
      });
    }
  }

  // Recompute status: received if every line is fully received, else partial.
  const { data: items } = await supabase
    .from("purchase_order_items")
    .select("quantity, received_qty")
    .eq("po_id", poId);

  if (items?.length) {
    const allReceived = items.every(
      (i: any) => Number(i.received_qty) >= Number(i.quantity),
    );
    const anyReceived = items.some((i: any) => Number(i.received_qty) > 0);
    const status = allReceived ? "received" : anyReceived ? "partial" : "sent";
    await supabase.from("purchase_orders").update({ status }).eq("id", poId);
  }

  revalidatePath(`/purchasing/${poId}`);
  revalidatePath("/purchasing");
  revalidatePath("/inventory"); // received goods flowed into stock — refresh the inventory board
  return { ok: true };
}

async function recalcPoTotals(supabase: any, poId: string) {
  const { data: items } = await supabase
    .from("purchase_order_items")
    .select("line_total")
    .eq("po_id", poId);
  // A PO carries no tax, so total == subtotal; the shared rollup still cents-rounds it
  // the same way an invoice/quote does, so PO dust can't diverge from the rest of the app.
  const { subtotal, total } = subtotalTaxTotal(
    (items ?? []).map((i: any) => Number(i.line_total ?? 0)),
    0,
  );
  await supabase
    .from("purchase_orders")
    .update({ subtotal, total })
    .eq("id", poId);
}
