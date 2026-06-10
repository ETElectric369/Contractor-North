"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendEmail, renderDocEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { pushInvoiceToQbo } from "@/lib/quickbooks";

export async function sendInvoiceToQuickbooks(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  if (!me || !["owner", "admin", "office"].includes(me.role)) {
    return { ok: false, error: "Not allowed." };
  }
  const res = await pushInvoiceToQbo(id);
  if (res.ok) revalidatePath(`/billing/${id}`);
  return { ok: res.ok, error: res.error };
}

function publicInvoiceLink(token: string) {
  return `${process.env.NEXT_PUBLIC_SITE_URL || ""}/i/${token}`;
}

export async function textInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_number, total, amount_paid, status, public_token, customers(name, phone)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const customer = (invoice as any).customers;
  if (!customer?.phone)
    return { ok: false, error: "This customer has no phone number." };

  const { data: org } = await supabase.from("organizations").select("name").maybeSingle();
  const balance = Number(invoice.total) - Number(invoice.amount_paid);
  const link = publicInvoiceLink((invoice as any).public_token);
  const body = `${org?.name ?? "Your contractor"}: Invoice ${invoice.invoice_number}, balance $${balance.toFixed(2)}. View/pay: ${link}`;

  const sent = await sendSms(customer.phone, body);
  if (!sent)
    return { ok: false, error: "Text not sent — add your Twilio account to enable SMS." };
  if (invoice.status === "draft") {
    await supabase.from("invoices").update({ status: "sent" }).eq("id", id);
  }
  return { ok: true };
}

export async function emailInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*, customers(name, email)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const customer = (invoice as any).customers;
  if (!customer?.email)
    return { ok: false, error: "This customer has no email address." };
  const link = publicInvoiceLink((invoice as any).public_token);

  const [{ data: items }, { data: org }] = await Promise.all([
    supabase.from("invoice_items").select("*").eq("invoice_id", id).order("sort_order"),
    supabase.from("organizations").select("name, brand_color, phone, email").maybeSingle(),
  ]);

  const balance = Number(invoice.total) - Number(invoice.amount_paid);
  const html = renderDocEmail({
    docType: "Invoice",
    number: invoice.invoice_number,
    company: {
      name: org?.name ?? "Contractor North",
      brand: org?.brand_color ?? "#0b57c4",
      phone: org?.phone,
      email: org?.email,
    },
    customerName: customer.name,
    title: invoice.title,
    items: (items ?? []).map((i: any) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      price: i.unit_price,
      total: i.line_total,
    })),
    subtotal: invoice.subtotal,
    tax: invoice.tax,
    total: invoice.total,
    balance,
    notes: invoice.notes,
    link,
  });

  const res = await sendEmail({
    to: customer.email,
    subject: `Invoice ${invoice.invoice_number} from ${org?.name ?? "us"}`,
    html,
    replyTo: org?.email ?? undefined,
  });
  if (!res.ok) return res;

  if (invoice.status === "draft") {
    await supabase.from("invoices").update({ status: "sent" }).eq("id", id);
  }
  revalidatePath(`/billing/${id}`);
  return { ok: true };
}

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

export async function updateInvoiceItem(
  itemId: string,
  invoiceId: string,
  item: { description: string; quantity: number; unit_price: number },
): Promise<Result> {
  const supabase = await createClient();
  if (!item.description.trim()) return { ok: false, error: "Description is required." };
  const { error } = await supabase
    .from("invoice_items")
    .update({
      description: item.description.trim(),
      quantity: item.quantity || 1,
      unit_price: item.unit_price || 0,
    })
    .eq("id", itemId);
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

/** Set the invoice tax rate (percent in → stored as decimal) and recompute. */
export async function setInvoiceTaxRate(
  invoiceId: string,
  ratePercent: number,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const rate = Number.isFinite(ratePercent) ? ratePercent / 100 : 0;
  const { error } = await supabase.from("invoices").update({ tax_rate: rate }).eq("id", invoiceId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
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
