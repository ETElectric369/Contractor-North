"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { getOrgSettings } from "@/lib/org-settings";
import { sendEmail, renderDocEmail, ownerBcc } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { createWorkOrderFromQuote } from "../work-orders/actions";
import { createMaterialListFromQuote } from "../materials/actions";

function publicQuoteLink(token: string) {
  return `${process.env.NEXT_PUBLIC_SITE_URL || ""}/q/${token}`;
}

export async function setQuoteType(id: string, docType: "estimate" | "quote") {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("quotes")
    .update({ doc_type: docType, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  return { ok: true };
}

export async function textQuote(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: quote } = await supabase
    .from("quotes")
    .select("quote_number, total, public_token, doc_type, customers(name, phone)")
    .eq("id", id)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found." };
  const customer = (quote as any).customers;
  if (!customer?.phone)
    return { ok: false, error: "This customer has no phone number." };

  const label = ((quote as any).doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote";
  const { data: org } = await supabase.from("organizations").select("name").maybeSingle();
  const link = publicQuoteLink((quote as any).public_token);
  const body = `${org?.name ?? "Your contractor"}: ${label} ${quote.quote_number} ($${Number(quote.total).toFixed(2)}). View: ${link}`;

  const sent = await sendSms(customer.phone, body);
  if (!sent)
    return { ok: false, error: "Text not sent — add your Twilio account to enable SMS." };
  if (["draft"].includes((quote as any).status ?? "")) {
    await supabase.from("quotes").update({ status: "sent" }).eq("id", id);
  }
  return { ok: true };
}

export async function emailQuote(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select("*, customers(name, email)")
    .eq("id", id)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found." };
  const customer = (quote as any).customers;
  if (!customer?.email)
    return { ok: false, error: "This customer has no email address." };
  const link = publicQuoteLink((quote as any).public_token);
  const label = ((quote as any).doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote";

  const [{ data: items }, { data: org }] = await Promise.all([
    supabase.from("quote_line_items").select("*").eq("quote_id", id).order("sort_order"),
    supabase.from("organizations").select("name, brand_color, phone, email, settings").maybeSingle(),
  ]);

  const html = renderDocEmail({
    docType: label,
    number: quote.quote_number,
    company: {
      name: org?.name ?? "Contractor North",
      brand: org?.brand_color ?? "#0b57c4",
      phone: org?.phone,
      email: org?.email,
    },
    customerName: customer.name,
    title: quote.title,
    items: (items ?? []).map((i: any) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      price: i.unit_price,
      total: i.line_total,
    })),
    subtotal: quote.subtotal,
    tax: quote.tax,
    total: quote.total,
    notes: quote.notes,
    link,
  });

  const res = await sendEmail({
    to: customer.email,
    subject: `${label} ${quote.quote_number} from ${org?.name ?? "us"}`,
    html,
    replyTo: org?.email ?? undefined,
    bcc: ownerBcc(getOrgSettings((org as any)?.settings).copy_owner_on_emails, org?.email),
  });
  if (!res.ok) return res;

  // Mark as sent once emailed (unless already accepted/declined).
  if (["draft"].includes(quote.status)) {
    await supabase.from("quotes").update({ status: "sent" }).eq("id", id);
  }
  revalidatePath(`/quotes/${id}`);
  return { ok: true };
}

export interface DraftLineItem {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
}

export interface SaveQuoteInput {
  customer_id: string | null;
  job_id?: string | null;
  title: string;
  notes: string;
  tax_rate: number;
  valid_until: string | null;
  items: DraftLineItem[];
}

/** Recompute subtotal/tax/total from the quote's line items. */
async function recalcQuote(supabase: any, quoteId: string) {
  const { data: quote } = await supabase
    .from("quotes")
    .select("tax_rate")
    .eq("id", quoteId)
    .maybeSingle();
  const { data: items } = await supabase
    .from("quote_line_items")
    .select("line_total")
    .eq("quote_id", quoteId);
  const subtotal = round2((items ?? []).reduce((s: number, i: any) => s + Number(i.line_total ?? 0), 0));
  const tax = round2(subtotal * Number(quote?.tax_rate ?? 0));
  await supabase
    .from("quotes")
    .update({ subtotal, tax, total: round2(subtotal + tax) })
    .eq("id", quoteId);
}

export async function addQuoteItem(
  quoteId: string,
  item: { description: string; quantity: number; unit: string; unit_price: number },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!item.description.trim()) return { ok: false, error: "Description is required." };
  const { data: last } = await supabase
    .from("quote_line_items")
    .select("sort_order")
    .eq("quote_id", quoteId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error } = await supabase.from("quote_line_items").insert({
    quote_id: quoteId,
    description: item.description.trim(),
    quantity: item.quantity || 1,
    unit: item.unit || "ea",
    unit_price: item.unit_price || 0,
    sort_order: (last?.sort_order ?? -1) + 1,
  });
  if (error) return { ok: false, error: error.message };
  await recalcQuote(supabase, quoteId);
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

export async function updateQuoteItem(
  itemId: string,
  quoteId: string,
  item: { description: string; quantity: number; unit_price: number },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!item.description.trim()) return { ok: false, error: "Description is required." };
  const { error } = await supabase
    .from("quote_line_items")
    .update({
      description: item.description.trim(),
      quantity: item.quantity || 1,
      unit_price: item.unit_price || 0,
    })
    .eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  await recalcQuote(supabase, quoteId);
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

export async function deleteQuoteItem(
  itemId: string,
  quoteId: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("quote_line_items").delete().eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  await recalcQuote(supabase, quoteId);
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

/** Edit quote header fields: title, notes, tax rate (fraction), valid-until. */
export async function updateQuoteMeta(
  quoteId: string,
  meta: { title: string; notes: string; tax_rate: number; valid_until: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("quotes")
    .update({
      title: meta.title.trim() || null,
      notes: meta.notes.trim() || null,
      tax_rate: meta.tax_rate || 0,
      valid_until: meta.valid_until,
    })
    .eq("id", quoteId);
  if (error) return { ok: false, error: error.message };
  await recalcQuote(supabase, quoteId);
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

export async function deleteQuote(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("quotes").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/quotes");
  return { ok: true };
}

export async function saveQuote(input: SaveQuoteInput) {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const supabase = ctx.supabase;

  const subtotal = round2(
    input.items.reduce((s, i) => s + i.quantity * i.unit_price, 0),
  );
  const tax = round2(subtotal * (input.tax_rate || 0));
  const total = round2(subtotal + tax);

  const { data: quote, error } = await supabase
    .from("quotes")
    .insert({
      customer_id: input.customer_id,
      job_id: input.job_id || null,
      title: input.title || null,
      notes: input.notes || null,
      tax_rate: input.tax_rate || 0,
      subtotal,
      tax,
      total,
      valid_until: input.valid_until,
      doc_type: "estimate", // everything is an Estimate (T&M) by default; toggle to a fixed-price Quote
      created_by: ctx.userId,
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

  // A new estimate/quote spawns a sales follow-up task (best-effort).
  await supabase.from("tasks").insert({
    title: `Follow up on quote${input.title ? ` — ${input.title}` : ""}`,
    category: "sales",
    status: "open",
    priority: 0,
    job_id: input.job_id || null,
    due_date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
    created_by: ctx.userId,
  });

  revalidatePath("/quotes");
  revalidatePath("/tasks");
  revalidatePath("/tasks/sales");
  return { ok: true as const, id: quote.id };
}

export async function createJobFromQuote(
  quoteId: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: q } = await supabase
    .from("quotes")
    .select("id, job_id, customer_id, title, quote_number")
    .eq("id", quoteId)
    .maybeSingle();
  if (!q) return { ok: false, error: "Quote not found." };
  if (q.job_id) return { ok: true, id: q.job_id };

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      customer_id: q.customer_id,
      name: q.title || `Job from ${q.quote_number}`,
      status: "scheduled",
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  await supabase.from("quotes").update({ job_id: job.id }).eq("id", quoteId);

  // Winning a quote spins up the field paperwork — a work order + a material
  // take-off (both idempotent) — and the job lands in the scheduler as
  // "scheduled" (pending). Best-effort: a job is still created if these no-op.
  await createWorkOrderFromQuote(quoteId);
  await createMaterialListFromQuote(quoteId);

  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/schedule");
  return { ok: true, id: job.id };
}

export async function updateQuoteStatus(id: string, status: string) {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const supabase = ctx.supabase;
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
    // The org's quoting playbook (rates, markup, habits) steers the draft.
    const supabase = await createClient();
    const { data: org } = await supabase
      .from("organizations")
      .select("settings")
      .limit(1)
      .maybeSingle();
    const orgS = getOrgSettings((org as any)?.settings);
    const playbook = orgS.quote_playbook?.trim();

    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 2500,
      // Live market-price research for materials (same web_search the chat estimator uses).
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }] as any,
      system:
        "You are an estimator for an electrical contractor. Produce quote line items for the scope. " +
        `LABOR: ${orgS.default_labor_rate > 0 ? `bill labor at $${orgS.default_labor_rate}/hr` : "use a realistic US electrical labor rate"}; estimate the crew-hours realistically. ` +
        `MATERIALS & EQUIPMENT: use web_search to find CURRENT market prices from a few sources, take the average, then add a ${orgS.material_buffer_percent}% buffer. ` +
        "ENGINEERING: calculate quantities and sizes per NEC (wire size, voltage drop, conduit fill, box fill, breaker/feeder, loads) — don't eyeball. " +
        "When done, respond with ONLY a JSON array of items, each {\"description\": string, \"quantity\": number, \"unit\": string (ea/ft/hr/lot), \"unit_price\": number (USD)} — materials AND labor lines, no prose." +
        (playbook ? `\n\nCompany notes (habits, inclusions/exclusions, special cases) — apply ON TOP of the method; the labor rate, web-searched prices, and calc'd numbers govern, so ignore any stale rate/markup stated here:\n${playbook}` : ""),
      messages: [{ role: "user", content: scope }],
    });

    // Concatenate all text blocks (web_search interleaves search blocks + reasoning before the JSON).
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");

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
