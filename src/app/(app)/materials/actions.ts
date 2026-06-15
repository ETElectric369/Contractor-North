"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";

export interface DraftMaterial {
  description: string;
  part_number: string | null;
  quantity: number;
  unit: string;
  vendor: string | null;
  est_cost: number | null;
}

export type Result = { ok: boolean; error?: string; id?: string };

/** Create a list and (optionally) seed it with items in one shot. */
export async function createMaterialList(input: {
  name: string;
  job_id: string | null;
  items: DraftMaterial[];
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "List name is required." };

  const { data: list, error } = await supabase
    .from("material_lists")
    .insert({ name, job_id: input.job_id, created_by: user.id })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  if (input.items.length) {
    const rows = input.items.map((it, idx) => ({
      list_id: list.id,
      description: it.description,
      part_number: it.part_number,
      quantity: it.quantity,
      unit: it.unit || "ea",
      vendor: it.vendor,
      est_cost: it.est_cost,
      sort_order: idx,
    }));
    const { error: itemsErr } = await supabase
      .from("material_list_items")
      .insert(rows);
    if (itemsErr) return { ok: false, error: itemsErr.message };
  }

  revalidatePath("/materials");
  return { ok: true, id: list.id };
}

export async function addMaterialItem(
  listId: string,
  item: DraftMaterial,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("material_list_items").insert({
    list_id: listId,
    description: item.description,
    part_number: item.part_number,
    quantity: item.quantity,
    unit: item.unit || "ea",
    vendor: item.vendor,
    est_cost: item.est_cost,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/materials/${listId}`);
  return { ok: true };
}

export async function deleteMaterialItem(
  itemId: string,
  listId: string,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("material_list_items")
    .delete()
    .eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/materials/${listId}`);
  return { ok: true };
}

export async function deleteMaterialList(listId: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("material_lists")
    .delete()
    .eq("id", listId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/materials");
  return { ok: true };
}

/** Build a material take-off list straight from a quote's line items, attached
 *  to the quote's job. Maps each line: description → description, qty → qty,
 *  unit → unit, unit_price → est_cost. Returns the new list id. */
export async function createMaterialListFromQuote(quoteId: string): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("id, quote_number, job_id, title")
    .eq("id", quoteId)
    .maybeSingle();
  if (qErr) return { ok: false, error: qErr.message };
  if (!quote) return { ok: false, error: "Quote not found." };

  // Idempotent: one material list per quote — re-running opens the existing one.
  const { data: existingList } = await supabase
    .from("material_lists")
    .select("id")
    .eq("quote_id", quoteId)
    .limit(1)
    .maybeSingle();
  if (existingList) return { ok: true, id: existingList.id };

  const { data: items, error: iErr } = await supabase
    .from("quote_line_items")
    .select("description, quantity, unit, unit_price, sort_order")
    .eq("quote_id", quoteId)
    .order("sort_order");
  if (iErr) return { ok: false, error: iErr.message };
  if (!items || items.length === 0)
    return { ok: false, error: "This quote has no line items to build from." };

  const { data: list, error } = await supabase
    .from("material_lists")
    .insert({
      name: `Materials — ${quote.quote_number}`,
      job_id: quote.job_id,
      quote_id: quote.id,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  const rows = items.map((it: any, idx: number) => ({
    list_id: list.id,
    description: it.description,
    part_number: null,
    quantity: Number(it.quantity) || 1,
    unit: it.unit || "ea",
    vendor: null,
    est_cost: it.unit_price != null ? Number(it.unit_price) : null,
    sort_order: it.sort_order ?? idx,
  }));
  const { error: itemsErr } = await supabase.from("material_list_items").insert(rows);
  if (itemsErr) return { ok: false, error: itemsErr.message };

  revalidatePath("/materials");
  if (quote.job_id) revalidatePath(`/jobs/${quote.job_id}`);
  return { ok: true, id: list.id };
}

/** Ask Claude to build an electrical material take-off from a scope of work. */
export async function generateMaterialDraft(
  scope: string,
): Promise<{ ok: true; items: DraftMaterial[] } | { ok: false; error: string }> {
  if (!scope.trim()) return { ok: false, error: "Describe the work first." };

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 2000,
      system:
        'You are a material estimator for an electrical contractor (CED supply). Given a scope of work, output a JSON array of material take-off items. Each item: {"description": string, "part_number": string|null, "quantity": number, "unit": string (ea/ft/box/roll/lot), "vendor": string|null, "est_cost": number|null (per-unit USD, rough)}. Include wire, conduit, fittings, breakers, devices, boxes, etc. as appropriate. Respond with ONLY the JSON array.',
      messages: [{ role: "user", content: scope }],
    });

    const block = msg.content.find((b) => b.type === "text") as
      | { text: string }
      | undefined;
    const text = block?.text ?? "";
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("No JSON array in response.");

    const items = (JSON.parse(text.slice(start, end + 1)) as DraftMaterial[]).map(
      (i) => ({
        description: String(i.description ?? ""),
        part_number: i.part_number ? String(i.part_number) : null,
        quantity: Number(i.quantity) || 1,
        unit: String(i.unit ?? "ea"),
        vendor: i.vendor ? String(i.vendor) : null,
        est_cost: i.est_cost != null ? Number(i.est_cost) : null,
      }),
    );
    return { ok: true, items };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message?.includes("ANTHROPIC_API_KEY")
        ? "Add your ANTHROPIC_API_KEY to enable AI generation."
        : `AI generation failed: ${e?.message ?? "unknown error"}`,
    };
  }
}
