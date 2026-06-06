"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";

export interface DraftLineItem {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
}

export interface SaveQuoteInput {
  customer_id: string | null;
  title: string;
  notes: string;
  tax_rate: number;
  valid_until: string | null;
  items: DraftLineItem[];
}

export async function saveQuote(input: SaveQuoteInput) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const subtotal = round2(
    input.items.reduce((s, i) => s + i.quantity * i.unit_price, 0),
  );
  const tax = round2(subtotal * (input.tax_rate || 0));
  const total = round2(subtotal + tax);

  const { data: quote, error } = await supabase
    .from("quotes")
    .insert({
      customer_id: input.customer_id,
      title: input.title || null,
      notes: input.notes || null,
      tax_rate: input.tax_rate || 0,
      subtotal,
      tax,
      total,
      valid_until: input.valid_until,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false as const, error: error.message };

  if (input.items.length) {
    const rows = input.items.map((it, idx) => ({
      quote_id: quote.id,
      description: it.description,
      quantity: it.quantity,
      unit: it.unit || "ea",
      unit_price: it.unit_price,
      sort_order: idx,
    }));
    const { error: itemsErr } = await supabase
      .from("quote_line_items")
      .insert(rows);
    if (itemsErr) return { ok: false as const, error: itemsErr.message };
  }

  revalidatePath("/quotes");
  return { ok: true as const, id: quote.id };
}

export async function updateQuoteStatus(id: string, status: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("quotes")
    .update({ status })
    .eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  return { ok: true as const };
}

/**
 * Ask Claude to draft electrical quote line items from a free-text scope.
 * Returns structured items the user can edit before saving.
 */
export async function generateQuoteDraft(
  scope: string,
): Promise<{ ok: true; items: DraftLineItem[] } | { ok: false; error: string }> {
  if (!scope.trim()) return { ok: false, error: "Describe the work first." };

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1500,
      system:
        "You are an estimator for an electrical contractor. Given a scope of work, produce a JSON array of quote line items. Each item: {\"description\": string, \"quantity\": number, \"unit\": string (ea/ft/hr/lot), \"unit_price\": number (USD, rough but realistic for US electrical work)}. Include both materials and labor lines. Respond with ONLY the JSON array, no prose.",
      messages: [{ role: "user", content: scope }],
    });

    const text =
      msg.content.find((b) => b.type === "text")?.type === "text"
        ? (msg.content.find((b) => b.type === "text") as { text: string }).text
        : "";

    const json = extractJsonArray(text);
    const items = (JSON.parse(json) as DraftLineItem[]).map((i) => ({
      description: String(i.description ?? ""),
      quantity: Number(i.quantity) || 1,
      unit: String(i.unit ?? "ea"),
      unit_price: Number(i.unit_price) || 0,
    }));
    return { ok: true, items };
  } catch (e: any) {
    return {
      ok: false,
      error:
        e?.message?.includes("ANTHROPIC_API_KEY")
          ? "Add your ANTHROPIC_API_KEY to enable AI drafting."
          : `AI draft failed: ${e?.message ?? "unknown error"}`,
    };
  }
}

function extractJsonArray(text: string) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON array in response.");
  return text.slice(start, end + 1);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
