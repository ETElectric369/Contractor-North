"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string; id?: string };

/** Create a PO. If sourceListId is given, seed its items from a material list. */
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

  const { data: po, error } = await supabase
    .from("purchase_orders")
    .insert({
      vendor: input.vendor.trim() || "CED",
      job_id: input.job_id,
      status: "draft",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  if (input.source_list_id) {
    const { data: items } = await supabase
      .from("material_list_items")
      .select("description, part_number, quantity, unit, est_cost")
      .eq("list_id", input.source_list_id)
      .order("sort_order");

    if (items?.length) {
      const rows = items.map((it: any, idx: number) => ({
        po_id: po.id,
        description: it.description,
        part_number: it.part_number,
        quantity: it.quantity,
        unit: it.unit ?? "ea",
        unit_cost: Number(it.est_cost) || 0,
        sort_order: idx,
      }));
      await supabase.from("purchase_order_items").insert(rows);
      await recalcTotals(supabase, po.id);
    }
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
  await recalcTotals(supabase, poId);
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
  await recalcTotals(supabase, poId);
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
  const { error } = await supabase
    .from("purchase_order_items")
    .update({ received_qty: Math.max(0, receivedQty) })
    .eq("id", itemId);
  if (error) return { ok: false, error: error.message };

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
  return { ok: true };
}

async function recalcTotals(supabase: any, poId: string) {
  const { data: items } = await supabase
    .from("purchase_order_items")
    .select("line_total")
    .eq("po_id", poId);
  const subtotal =
    items?.reduce((s: number, i: any) => s + Number(i.line_total ?? 0), 0) ?? 0;
  await supabase
    .from("purchase_orders")
    .update({ subtotal, total: subtotal })
    .eq("id", poId);
}
