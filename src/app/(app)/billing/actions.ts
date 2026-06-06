"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string; id?: string };

/** Convert an accepted (or any) quote into a draft invoice, copying line items. */
export async function createInvoiceFromQuote(quoteId: string): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();
  if (qErr || !quote) return { ok: false, error: "Quote not found." };

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: quote.customer_id,
      job_id: quote.job_id,
      quote_id: quote.id,
      title: quote.title,
      notes: quote.notes,
      tax_rate: quote.tax_rate,
      subtotal: quote.subtotal,
      tax: quote.tax,
      total: quote.total,
      status: "draft",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("description, quantity, unit, unit_price, sort_order")
    .eq("quote_id", quoteId)
    .order("sort_order");

  if (items?.length) {
    await supabase.from("invoice_items").insert(
      items.map((it: any) => ({
        invoice_id: invoice.id,
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        unit_price: it.unit_price,
        sort_order: it.sort_order,
      })),
    );
  }

  revalidatePath("/billing");
  return { ok: true, id: invoice.id };
}

export async function createBlankInvoice(input: {
  customer_id: string | null;
  title: string;
  tax_rate: number;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: input.customer_id,
      title: input.title || null,
      tax_rate: input.tax_rate || 0,
      status: "draft",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/billing");
  return { ok: true, id: data.id };
}

export async function addInvoiceItem(
  invoiceId: string,
  item: { description: string; quantity: number; unit: string; unit_price: number },
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("invoice_items").insert({
    invoice_id: invoiceId,
    description: item.description,
    quantity: item.quantity || 1,
    unit: item.unit || "ea",
    unit_price: item.unit_price || 0,
  });
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

export async function deleteInvoiceItem(
  itemId: string,
  invoiceId: string,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("invoice_items").delete().eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

export async function setInvoiceStatus(
  id: string,
  status: string,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("invoices").update({ status }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/billing");
  revalidatePath(`/billing/${id}`);
  return { ok: true };
}

export async function recordPayment(input: {
  invoice_id: string;
  amount: number;
  method: string;
  note: string;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "Enter a payment amount." };

  const { error } = await supabase.from("payments").insert({
    invoice_id: input.invoice_id,
    amount: input.amount,
    method: input.method || "check",
    note: input.note || null,
    recorded_by: user.id,
  });
  if (error) return { ok: false, error: error.message };

  await recalcInvoice(supabase, input.invoice_id);
  revalidatePath(`/billing/${input.invoice_id}`);
  revalidatePath("/billing");
  return { ok: true };
}

/** Recompute totals from items + payments, and auto-advance paid status. */
async function recalcInvoice(supabase: any, invoiceId: string) {
  const [{ data: items }, { data: pays }, { data: inv }] = await Promise.all([
    supabase.from("invoice_items").select("line_total").eq("invoice_id", invoiceId),
    supabase.from("payments").select("amount").eq("invoice_id", invoiceId),
    supabase.from("invoices").select("tax_rate, status").eq("id", invoiceId).single(),
  ]);

  const subtotal =
    items?.reduce((s: number, i: any) => s + Number(i.line_total ?? 0), 0) ?? 0;
  const taxRate = Number(inv?.tax_rate ?? 0);
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  const amountPaid =
    pays?.reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0) ?? 0;

  let status = inv?.status ?? "draft";
  if (status !== "void") {
    if (amountPaid >= total && total > 0) status = "paid";
    else if (amountPaid > 0) status = "partial";
    else if (status === "paid" || status === "partial") status = "sent";
  }

  await supabase
    .from("invoices")
    .update({ subtotal, tax, total, amount_paid: amountPaid, status })
    .eq("id", invoiceId);
}
