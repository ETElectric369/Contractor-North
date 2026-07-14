"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { visibleJobIdOrNull } from "@/lib/job-visibility";

export interface DraftMaterial {
  description: string;
  part_number: string | null;
  quantity: number;
  unit: string;
  vendor: string | null;
  est_cost: number | null;
  is_tool?: boolean;
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
      is_tool: it.is_tool ?? false,
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
  const { data: last } = await supabase
    .from("material_list_items")
    .select("sort_order")
    .eq("list_id", listId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error } = await supabase.from("material_list_items").insert({
    list_id: listId,
    description: item.description,
    part_number: item.part_number,
    quantity: item.quantity,
    unit: item.unit || "ea",
    vendor: item.vendor,
    est_cost: item.est_cost,
    is_tool: item.is_tool ?? false,
    sort_order: ((last?.sort_order as number) ?? -1) + 1,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/materials/${listId}`);
  return { ok: true };
}

export async function updateMaterialItem(
  itemId: string,
  listId: string,
  patch: Partial<DraftMaterial>,
): Promise<Result> {
  const supabase = await createClient();
  const clean: Record<string, unknown> = {};
  if (patch.description !== undefined) clean.description = patch.description.trim();
  if (patch.part_number !== undefined) clean.part_number = patch.part_number || null;
  if (patch.quantity !== undefined) clean.quantity = patch.quantity || 1;
  if (patch.unit !== undefined) clean.unit = patch.unit || "ea";
  if (patch.vendor !== undefined) clean.vendor = patch.vendor || null;
  if (patch.est_cost !== undefined) clean.est_cost = patch.est_cost ?? null;
  if (patch.is_tool !== undefined) clean.is_tool = patch.is_tool;
  const { error } = await supabase.from("material_list_items").update(clean).eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/materials/${listId}`);
  return { ok: true };
}

export async function setMaterialItemPurchased(
  itemId: string,
  listId: string,
  purchased: boolean,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("material_list_items")
    .update({ purchased, purchased_at: purchased ? new Date().toISOString() : null })
    .eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/materials/${listId}`);
  return { ok: true };
}

/** Flag/unflag an item as a TOOL — tools sort above consumable materials so the
 *  crew loads what they own first, then shops for the rest. */
export async function setMaterialItemTool(
  itemId: string,
  listId: string,
  isTool: boolean,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("material_list_items").update({ is_tool: isTool }).eq("id", itemId);
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

/** Edit a list's name AND its job link in one shot — so a list saved to the
 *  wrong job (or unlinked) can be re-pointed or detached, not just renamed.
 *  Guard is RLS-only for the row itself, but validates the job_id is
 *  visible to the caller (visibleJobIdOrNull) so a foreign/crafted job id can
 *  never persist as a cross-org dangling FK. Pass job_id: null to detach. */
export async function updateMaterialList(
  listId: string,
  patch: { name?: string; job_id?: string | null },
): Promise<Result> {
  const supabase = await createClient();
  const clean: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return { ok: false, error: "Name is required." };
    clean.name = name;
  }
  if (patch.job_id !== undefined) {
    clean.job_id = await visibleJobIdOrNull(supabase, patch.job_id);
  }
  const { error } = await supabase.from("material_lists").update(clean).eq("id", listId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/materials/${listId}`);
  revalidatePath("/materials");
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
 *  to the quote's job. A material list is an ORDER sheet, so it: DROPS labor lines,
 *  pulls each item's real BUY cost + catalog # + vendor from the price book (not the
 *  marked-up estimate price), and reads the catalog # from a "…[CODE]" tag in the
 *  description when present. Unmatched lines keep the estimate price as a fallback.
 *  Returns the new list id. */
export async function createMaterialListFromQuote(quoteId: string): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("id, quote_number, job_id, title, customer_id")
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

  // The price book (RLS-scoped to this org) → resolve each material line to its REAL buy cost,
  // catalog #, and vendor. Match on the "[CODE]" tag in the description first, then on the
  // normalized description. Tools are archived, so they never land on an order sheet.
  const { data: book } = await supabase
    .from("price_list_items")
    .select("code, description, supplier, buy_price, unit")
    .eq("archived", false);
  const normDesc = (s: string) => (s ?? "").toLowerCase().replace(/\[[^\]]*\]/g, "").replace(/[^a-z0-9]/g, "");
  const byCode = new Map<string, any>();
  const byDesc = new Map<string, any>();
  for (const b of (book ?? []) as any[]) {
    if (b.code) byCode.set(String(b.code).toUpperCase(), b);
    const k = normDesc(b.description);
    if (k && !byDesc.has(k)) byDesc.set(k, b);
  }
  // An order sheet is a BUY list. Lines that don't match the price book carry the estimate's SELL
  // price, so back the markup out (the customer's pricing level, else the org default) to get cost.
  const { data: orgS } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  let markup = getOrgSettings((orgS as any)?.settings).material_markup_percent ?? 0;
  if (quote.customer_id) {
    const { data: cust } = await supabase
      .from("customers")
      .select("pricing_levels(markup_pct)")
      .eq("id", quote.customer_id)
      .maybeSingle();
    const lvl = (cust as any)?.pricing_levels?.markup_pct;
    if (lvl != null) markup = Number(lvl);
  }
  const costFromSell = (p: number) => Math.round((p / (1 + markup / 100)) * 100) / 100;

  const CODE_RE = /\[([^\]]+)\]/;
  const isLabor = (it: any) =>
    String(it.unit ?? "").toLowerCase() === "hr" || /^\s*labor\b/i.test(String(it.description ?? ""));
  // Match "[CODE]" exactly, then its last token ("[RACO 936]" → "936"), then the cleaned description.
  const findPl = (code: string | null, cleanDesc: string): any => {
    if (code) {
      const up = code.toUpperCase();
      if (byCode.has(up)) return byCode.get(up);
      const last = up.split(/\s+/).pop();
      if (last && byCode.has(last)) return byCode.get(last);
    }
    return byDesc.get(normDesc(cleanDesc)) ?? null;
  };

  const rows = (items as any[])
    .filter((it) => !isLabor(it)) // an order sheet carries materials, never labor
    .map((it, idx) => {
      const m = String(it.description ?? "").match(CODE_RE);
      const code = m ? m[1].trim() : null;
      const cleanDesc = String(it.description ?? "").replace(CODE_RE, "").trim();
      const pl = findPl(code, cleanDesc);
      return {
        list_id: list.id,
        description: cleanDesc || it.description,
        part_number: pl?.code ?? code ?? null,
        quantity: Number(it.quantity) || 1,
        unit: it.unit || pl?.unit || "ea",
        vendor: pl?.supplier ?? null,
        // matched → the book's real buy price; unmatched → estimate price with the markup removed
        est_cost: pl ? Number(pl.buy_price) : it.unit_price != null ? costFromSell(Number(it.unit_price)) : null,
        sort_order: it.sort_order ?? idx,
      };
    });

  // Catalog orgs (Tahoe Deck): the granular MATERIAL kits (Framing, Hardware, Decking…) are
  // the POST-ACCEPTANCE purchasing breakdown — deliberately kept OFF the estimate, seeded onto
  // the job's materials list here so the crew has the buy-list grouped by scope. Prefixed with
  // the kit name (material_list_items has no group column). Only on first creation (idempotent
  // return above), so re-running never duplicates the groups. RLS scopes kits to this org.
  const { data: orgRow } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  if (getOrgSettings((orgRow as any)?.settings).estimating_mode === "catalog") {
    const { data: matKits } = await supabase
      .from("kits")
      .select("name, kit_items(description, quantity, unit, unit_price, sort_order)")
      .not("name", "in", '("Decks","Remodels")')
      .order("name");
    let so = rows.length;
    for (const k of (matKits ?? []) as any[]) {
      const kitItems = [...(k.kit_items ?? [])].sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      for (const it of kitItems) {
        rows.push({
          list_id: list.id,
          description: `${k.name} — ${it.description}`,
          part_number: null,
          quantity: Number(it.quantity) || 1,
          unit: it.unit || "ea",
          vendor: null,
          est_cost: it.unit_price != null ? Number(it.unit_price) : null,
          sort_order: so++,
        });
      }
    }
  }

  if (rows.length) {
    const { error: itemsErr } = await supabase.from("material_list_items").insert(rows);
    if (itemsErr) return { ok: false, error: itemsErr.message };
  }

  revalidatePath("/materials");
  if (quote.job_id) revalidatePath(`/jobs/${quote.job_id}`);
  return { ok: true, id: list.id };
}

/** Tolerant parse of a JSON array the model emitted: strips any code fences,
 *  isolates the outermost [...], and — if the model was cut off by the token
 *  limit mid-array — salvages the rows it did finish rather than failing whole. */
function parseDraftArray(raw: string): unknown[] {
  let s = raw.replace(/```(?:json)?/gi, "").trim();
  const start = s.indexOf("[");
  if (start === -1) throw new Error("No items in response.");
  const end = s.lastIndexOf("]");
  if (end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      /* fall through to salvage */
    }
  }
  // Salvage: take everything up to the last complete object and close the array.
  s = s.slice(start);
  const lastObj = s.lastIndexOf("}");
  if (lastObj === -1) throw new Error("Couldn't read the material list — try again.");
  try {
    return JSON.parse(s.slice(0, lastObj + 1) + "]");
  } catch {
    throw new Error("Couldn't read the material list — try again.");
  }
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
        'You are a material estimator for an electrical contractor (CED supply). Given a scope of work, output a JSON array of material take-off items. Each item: {"description": string, "part_number": string|null, "quantity": number, "unit": string (ea/ft/box/roll/lot), "vendor": string|null, "est_cost": number|null (per-unit USD, rough)}. Include wire, conduit, fittings, breakers, devices, boxes, etc. as appropriate. Respond with ONLY the JSON array — no prose, no code fences.',
      // Prefill the assistant turn with "[" so the model is forced to begin the
      // JSON array immediately (no preamble, no ```json fence). We prepend it back
      // before parsing. This eliminates the "No JSON array in response" failures.
      messages: [
        { role: "user", content: scope },
        { role: "assistant", content: "[" },
      ],
    });

    const block = msg.content.find((b) => b.type === "text") as
      | { text: string }
      | undefined;
    const raw = "[" + (block?.text ?? "");
    const items = (parseDraftArray(raw) as DraftMaterial[]).map(
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
