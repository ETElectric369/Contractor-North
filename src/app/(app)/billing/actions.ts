"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendEmail, renderDocEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { pushInvoiceToQbo } from "@/lib/quickbooks";

/** Post a credit/refund to the customer's account from an invoice. disposition
 *  "credit" keeps it on their account; "refund" flags accounting to pay it back. */
export async function createCustomerCredit(
  invoiceId: string,
  amount: number,
  disposition: "credit" | "refund",
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!(amount > 0)) return { ok: false, error: "Enter an amount." };

  const { data: inv } = await supabase
    .from("invoices")
    .select("customer_id")
    .eq("id", invoiceId)
    .maybeSingle();

  const { error } = await supabase.from("customer_credits").insert({
    customer_id: inv?.customer_id ?? null,
    invoice_id: invoiceId,
    amount,
    disposition,
    note: note?.trim() || null,
    created_by: user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/billing/${invoiceId}`);
  if (inv?.customer_id) revalidatePath(`/crm/${inv.customer_id}`);
  return { ok: true };
}

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

  // Idempotent: a quote maps to one invoice. Re-tapping "Create invoice" returns
  // the existing one instead of billing the customer twice.
  const { data: existingInv } = await supabase
    .from("invoices")
    .select("id")
    .eq("quote_id", quoteId)
    .limit(1)
    .maybeSingle();
  if (existingInv) return { ok: true, id: existingInv.id };

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
  job_id?: string | null;
  title: string;
  tax_rate: number;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // If a job is chosen, inherit its customer (and a title) so the invoice is
  // never orphaned from the job it belongs to — this is what makes the payment
  // show up on the job's revenue/costs.
  let customerId = input.customer_id;
  let title = input.title;
  if (input.job_id) {
    const { data: job } = await supabase
      .from("jobs")
      .select("customer_id, name, job_number")
      .eq("id", input.job_id)
      .single();
    if (job) {
      if (!customerId) customerId = job.customer_id ?? null;
      if (!title) title = job.name || job.job_number || "";
    }
  }

  const { data, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: customerId,
      job_id: input.job_id || null,
      title: title || null,
      tax_rate: input.tax_rate || 0,
      status: "draft",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/billing");
  if (input.job_id) revalidatePath(`/jobs/${input.job_id}`);
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

/** Next sort_order after the invoice's current items. */
async function nextSortOrder(supabase: any, invoiceId: string): Promise<number> {
  const { data } = await supabase
    .from("invoice_items")
    .select("sort_order")
    .eq("invoice_id", invoiceId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.sort_order ?? -1) + 1;
}

/** Import the linked job's quote line items into this invoice (appends). */
export async function importQuoteItemsIntoInvoice(invoiceId: string): Promise<Result> {
  const supabase = await createClient();
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, quote_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };

  let quoteId = inv.quote_id;
  if (!quoteId && inv.job_id) {
    const { data: q } = await supabase
      .from("quotes")
      .select("id")
      .eq("job_id", inv.job_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    quoteId = q?.id ?? null;
  }
  if (!quoteId) return { ok: false, error: "No quote found on this invoice's job." };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("description, quantity, unit, unit_price")
    .eq("quote_id", quoteId)
    .order("sort_order");
  if (!items?.length) return { ok: false, error: "The quote has no line items." };

  let sort = await nextSortOrder(supabase, invoiceId);
  const { error } = await supabase.from("invoice_items").insert(
    items.map((it: any) => ({
      invoice_id: invoiceId,
      description: it.description,
      quantity: it.quantity,
      unit: it.unit,
      unit_price: it.unit_price,
      sort_order: sort++,
    })),
  );
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

/** Import labor from the job's closed time entries: one line per person,
 *  hours × their hourly rate (falls back to the org default labor rate). */
export async function importLaborIntoInvoice(invoiceId: string): Promise<Result> {
  const supabase = await createClient();
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv?.job_id) return { ok: false, error: "This invoice isn't linked to a job." };

  const [{ data: entries }, { data: org }] = await Promise.all([
    supabase
      .from("time_entries")
      .select("clock_in, clock_out, lunch_minutes, status, profiles(id, full_name, hourly_rate)")
      .eq("job_id", inv.job_id)
      .eq("status", "closed"),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  if (!entries?.length) return { ok: false, error: "No closed time entries on this job yet." };

  const defaultRate = Number(((org as any)?.settings ?? {}).default_labor_rate ?? 0);
  const perPerson = new Map<string, { name: string; rate: number; hours: number }>();
  for (const e of entries as any[]) {
    if (!e.clock_out) continue;
    const hrs =
      (new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 3_600_000 -
      (e.lunch_minutes ?? 0) / 60;
    if (hrs <= 0) continue;
    const key = e.profiles?.id ?? "unknown";
    const cur = perPerson.get(key) ?? {
      name: e.profiles?.full_name ?? "Crew",
      rate: Number(e.profiles?.hourly_rate ?? 0) || defaultRate,
      hours: 0,
    };
    cur.hours += hrs;
    perPerson.set(key, cur);
  }
  if (perPerson.size === 0) return { ok: false, error: "No billable hours found." };

  let sort = await nextSortOrder(supabase, invoiceId);
  const rows = [...perPerson.values()].map((p) => ({
    invoice_id: invoiceId,
    description: `Labor — ${p.name}`,
    quantity: Math.round(p.hours * 4) / 4, // quarter-hour rounding
    unit: "hr",
    unit_price: p.rate,
    sort_order: sort++,
  }));
  const { error } = await supabase.from("invoice_items").insert(rows);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

/** Import materials from the job's costs: purchase orders + supplier bills
 *  (at cost — adjust pricing on the lines afterwards). */
export async function importCostsIntoInvoice(invoiceId: string): Promise<Result> {
  const supabase = await createClient();
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv?.job_id) return { ok: false, error: "This invoice isn't linked to a job." };

  const [{ data: pos }, { data: bills }] = await Promise.all([
    supabase.from("purchase_orders").select("po_number, vendor, total").eq("job_id", inv.job_id),
    supabase.from("bills").select("supplier, bill_number, amount").eq("job_id", inv.job_id),
  ]);

  const rows: { description: string; unit_price: number }[] = [];
  for (const p of pos ?? []) {
    if (Number(p.total) > 0) rows.push({ description: `Materials — ${p.vendor} (PO ${p.po_number})`, unit_price: Number(p.total) });
  }
  for (const b of bills ?? []) {
    if (Number(b.amount) > 0)
      rows.push({ description: `Materials — ${b.supplier}${b.bill_number ? ` (bill #${b.bill_number})` : ""}`, unit_price: Number(b.amount) });
  }
  if (!rows.length) return { ok: false, error: "No purchase orders or bills on this job yet." };

  let sort = await nextSortOrder(supabase, invoiceId);
  const { error } = await supabase.from("invoice_items").insert(
    rows.map((r) => ({
      invoice_id: invoiceId,
      description: r.description,
      quantity: 1,
      unit: "lot",
      unit_price: r.unit_price,
      sort_order: sort++,
    })),
  );
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

/** A "YYYY-MM-DD" date → an ISO timestamp at local noon (stable across tz). */
function dateToIso(d?: string | null): string | undefined {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  const t = new Date(`${d}T12:00:00`);
  return isNaN(t.getTime()) ? undefined : t.toISOString();
}

export async function recordPayment(input: {
  invoice_id: string;
  amount: number;
  method: string;
  note: string;
  paid_at?: string | null;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "Enter a payment amount." };

  const paidAt = dateToIso(input.paid_at);
  const { error } = await supabase.from("payments").insert({
    invoice_id: input.invoice_id,
    amount: input.amount,
    method: input.method || "check",
    note: input.note || null,
    recorded_by: user.id,
    ...(paidAt ? { paid_at: paidAt } : {}),
  });
  if (error) return { ok: false, error: error.message };

  await recalcInvoice(supabase, input.invoice_id);
  revalidatePath(`/billing/${input.invoice_id}`);
  revalidatePath("/billing");
  return { ok: true };
}

/** Edit a recorded payment (amount / method / note) and recompute the invoice. */
export async function updatePayment(
  paymentId: string,
  invoiceId: string,
  patch: { amount: number; method: string; note: string; paid_at?: string | null },
): Promise<Result> {
  const supabase = await createClient();
  if (!patch.amount || patch.amount <= 0) return { ok: false, error: "Enter a payment amount." };
  const paidAt = dateToIso(patch.paid_at);
  const { error } = await supabase
    .from("payments")
    .update({
      amount: patch.amount,
      method: patch.method || "check",
      note: patch.note || null,
      ...(paidAt ? { paid_at: paidAt } : {}),
    })
    .eq("id", paymentId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  revalidatePath("/billing");
  return { ok: true };
}

/** Remove a recorded payment (typo'd entry etc.) and recompute the invoice. */
export async function deletePayment(paymentId: string, invoiceId: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("payments").delete().eq("id", paymentId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  revalidatePath("/billing");
  return { ok: true };
}

/** Delete an invoice — only while no payments are recorded against it
 *  (paid history must stay; void those instead). */
export async function deleteInvoice(id: string): Promise<Result> {
  const supabase = await createClient();
  const { count } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", id);
  if (count && count > 0) {
    return { ok: false, error: "This invoice has recorded payments — delete those first or mark the invoice void." };
  }
  const { error } = await supabase.from("invoices").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
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
