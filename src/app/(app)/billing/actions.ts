"use server";

import { revalidatePath } from "next/cache";
import { revalidateMoney } from "@/lib/revalidate-money";
import { createClient } from "@/lib/supabase/server";
import { deliverInvoiceEmail } from "@/lib/invoice-email";
import { sendSms } from "@/lib/sms";
import { pushInvoiceToQbo } from "@/lib/quickbooks";
import { getOrgSettings } from "@/lib/org-settings";
import { tzLocalHourUtc } from "@/lib/tz";
import { requireStaff } from "@/lib/staff-guard";
import { computeJobLaborBilling, fetchJobLaborRows } from "@/lib/labor-billing";
import { livePurchaseOrders } from "@/lib/job-progress-math";
import { resolveDrawCredit, shouldBlockStandardImport, invoiceBalance, DRAW_KINDS, isDrawKind } from "@/lib/invoice-math";
import { recalcInvoice } from "@/lib/invoice-recalc";
import { defaultDueDateIsoForOrg } from "@/lib/invoice-due";
import { standardBillingBlockerOnJob, standardBillingConflictError } from "@/lib/billing-guards";
import { scheduleStatus, contractTotalFromQuotes, type Milestone } from "@/lib/payment-schedule-math";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { formatCurrency } from "@/lib/utils";
import { reportError } from "@/lib/observe";

/** Post a credit/refund to the customer's account from an invoice. disposition
 *  "credit" keeps it on their account; "refund" flags accounting to pay it back. */
export async function createCustomerCredit(
  invoiceId: string,
  amount: number,
  disposition: "credit" | "refund",
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!(amount > 0)) return { ok: false, error: "Enter an amount." };

  // M2: bail if the invoice isn't visible to this org (cross-org id → null under
  // RLS) instead of inserting an orphan credit with customer_id:null.
  const { data: inv } = await supabase
    .from("invoices")
    .select("customer_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };

  const { error } = await supabase.from("customer_credits").insert({
    customer_id: inv.customer_id ?? null,
    invoice_id: invoiceId,
    amount,
    disposition,
    note: note?.trim() || null,
    created_by: ctx.userId,
  });
  if (error) return { ok: false, error: error.message };
  // C6: a credit on account reduces what the customer owes — fold it into amount_paid via
  // recalc so the balance + collected reflect it (recalcInvoice now sums open credits as
  // payments). A refund is a cash-OUT, tracked in `collected` already, so it doesn't recalc.
  if (disposition === "credit") await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  revalidateMoney();
  if (inv?.customer_id) revalidatePath(`/crm/${inv.customer_id}`);
  return { ok: true };
}

export async function sendInvoiceToQuickbooks(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff(); // was duplicated inline auth — use the one guard
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const res = await pushInvoiceToQbo(id);
  if (res.ok) revalidateMoney(id);
  return { ok: res.ok, error: res.error };
}

function publicInvoiceLink(token: string) {
  return `${process.env.NEXT_PUBLIC_SITE_URL || ""}/i/${token}`;
}

export async function textInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_number, total, amount_paid, status, public_token, customers(name, phone)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const customer = (invoice as any).customers;
  if (!customer?.phone)
    return { ok: false, error: "This customer has no phone number." };

  const { data: org } = await supabase.from("organizations").select("name, settings").maybeSingle();
  const balance = invoiceBalance(invoice.total, invoice.amount_paid);
  const link = publicInvoiceLink((invoice as any).public_token);
  const body = `${org?.name ?? "Your contractor"}: Invoice ${invoice.invoice_number}, balance $${balance.toFixed(2)}. View/pay: ${link}`;

  const sent = await sendSms(customer.phone, body, (org as any)?.settings?.sms_from_number);
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
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const res = await deliverInvoiceEmail(ctx.supabase, id);
  if (res.ok) revalidateMoney(id);
  return res;
}

export type Result = { ok: boolean; error?: string; id?: string };

/** Default invoice due date = today (in the org tz) + the org's net terms, stamped to
 *  NOON in the org tz (same convention as setInvoiceDueDate / payment dates). Without a
 *  due date the Overdue tracker never fires, so EVERY creation path stamps one. Net terms
 *  come from the org's invoice_due_days setting; if it's unset/0 we fall back to Net 30.
 *  (Body lifted to @/lib/invoice-due so the unattended recurring-invoice cron — which has
 *  no auth context and must name its org explicitly — stamps the SAME date.) */
async function defaultDueDateIso(supabase: { from: (t: string) => any }): Promise<string> {
  return defaultDueDateIsoForOrg(supabase); // user client: RLS scopes the org read
}

/** Convert an accepted (or any) quote into a draft invoice, copying line items. */
export async function createInvoiceFromQuote(quoteId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

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

  // H4: a job already on the draw path can't also be billed by a standard invoice
  // carrying the full quoted amount (no import step would ever credit the draws).
  const drawBlock = await blockStandardCreateOnDrawJob(supabase, quote.job_id);
  if (drawBlock) return drawBlock;

  const dueDate = await defaultDueDateIso(supabase);
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
      due_date: dueDate,
      status: "draft",
      created_by: ctx.userId,
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

  revalidateMoney();
  return { ok: true, id: invoice.id };
}

export async function createBlankInvoice(input: {
  customer_id: string | null;
  job_id?: string | null;
  title: string;
  description?: string | null;
  tax_rate: number;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // H4: a job already on the draw path is billed by draws, not a standard invoice.
  const drawBlock = await blockStandardCreateOnDrawJob(supabase, input.job_id);
  if (drawBlock) return drawBlock;

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

  const dueDate = await defaultDueDateIso(supabase);
  const { data, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: customerId,
      job_id: input.job_id || null,
      title: title || null,
      description: input.description ?? null,
      tax_rate: input.tax_rate || 0,
      due_date: dueDate,
      status: "draft",
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidateMoney();
  if (input.job_id) revalidatePath(`/jobs/${input.job_id}`);
  return { ok: true, id: data.id };
}

export async function addInvoiceItem(
  invoiceId: string,
  item: { description: string; quantity: number; unit: string; unit_price: number },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (Math.abs((item.quantity || 1) * (item.unit_price || 0)) > 9_999_999_999)
    return { ok: false, error: "That amount is too large." };
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind, status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (inv.status !== "draft") return NOT_DRAFT_LOCKED; // M1: only draft invoices accept line edits
  if (inv.job_id) {
    const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
    if (conflict) return conflict; // H4: can't add billable lines to a standard invoice on a draw job
  }
  const { error } = await supabase.from("invoice_items").insert({
    invoice_id: invoiceId,
    description: item.description,
    quantity: item.quantity || 1,
    unit: item.unit || "ea",
    unit_price: item.unit_price || 0,
  });
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
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

/** Replace this invoice's previously-imported rows for a given source with a
 *  fresh set, so re-importing REFRESHES the lines (current total) instead of
 *  duplicating them. Inserts the new rows before deleting the old ones, so a
 *  failed insert can't wipe them. Hand-entered rows (import_source null) are
 *  never touched. */
async function replaceImportedItems(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceId: string,
  source: string,
  rows: Array<{ description: string; quantity: number; unit: string; unit_price: number }>,
): Promise<{ error?: string }> {
  const { data: old } = await supabase
    .from("invoice_items")
    .select("id")
    .eq("invoice_id", invoiceId)
    .eq("import_source", source);
  const oldIds = ((old ?? []) as { id: string }[]).map((r) => r.id);
  let sort = await nextSortOrder(supabase, invoiceId);
  const { error } = await supabase.from("invoice_items").insert(
    rows.map((r) => ({ invoice_id: invoiceId, import_source: source, sort_order: sort++, ...r })),
  );
  if (error) return { error: error.message };
  if (oldIds.length) {
    // Insert-then-delete (so a failed insert can't wipe the old lines). But if THIS
    // delete fails, the old + new lines both remain — a double-billed import. Report
    // it so the duplicate is caught instead of silently inflating the invoice.
    const { error: delErr } = await supabase.from("invoice_items").delete().in("id", oldIds);
    if (delErr) reportError("replaceImportedItems-delete", delErr, { invoiceId, source });
  }
  return {};
}

/** Import the linked job's quote line items into this invoice (idempotent). */
export async function importQuoteItemsIntoInvoice(invoiceId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, quote_id, invoice_kind")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  const draftBlock = await requireDraftInvoice(supabase, invoiceId);
  if (draftBlock) return draftBlock; // M1: never re-inflate a sent/paid invoice (see importLaborIntoInvoice)
  if (inv.job_id) {
    const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
    if (conflict) return conflict; // H4: don't re-bill quoted scope onto a standard invoice on a draw job
  }

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

  const rep = await replaceImportedItems(
    supabase,
    invoiceId,
    "quote",
    items.map((it: any) => ({
      description: it.description,
      quantity: Number(it.quantity),
      unit: it.unit,
      unit_price: Number(it.unit_price),
    })),
  );
  if (rep.error) return { ok: false, error: rep.error };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

// ── H4: one billing path per job ────────────────────────────────────────────
// A job billed via progress draws (deposit/progress/final) must NOT also be billed
// on a standard invoice — that double-bills the work the draws already cover. The
// guard lives at every chokepoint that puts billable content on a standard invoice
// (import labor/materials/quote-items, manual line add, create-from-quote/blank), so
// no single door is left open. A draw invoice itself is never blocked: it IS the path.

/** The job's active draw (deposit/progress/final, non-void) if any — the signal that
 *  the job is on the draw path. Excludes `excludeInvoiceId` (the invoice being acted
 *  on, so a draw never blocks itself). Returns the row (id/status/invoice_number). */
async function activeDrawOnJob(supabase: any, jobId: string, excludeInvoiceId?: string): Promise<any | null> {
  let q = supabase
    .from("invoices")
    .select("id, status, invoice_number")
    .eq("job_id", jobId)
    .neq("status", "void")
    .in("invoice_kind", [...DRAW_KINDS])
    .limit(1);
  if (excludeInvoiceId) q = q.neq("id", excludeInvoiceId);
  const { data } = await q;
  return data && data.length ? data[0] : null;
}

/** The H4 block message, pointing at the correct next action: a DRAFT draw must be
 *  sent/deleted (a 2nd draft is itself blocked, so "add a draw" would be a dead-end);
 *  a sent draw means the user should add a draw rather than bill standard. */
function drawConflictError(draw: any): Result {
  if (draw && draw.status === "draft") {
    const label = draw.invoice_number ? `Draft ${draw.invoice_number}` : "A draft draw";
    return {
      ok: false,
      error: `${label} is still open on this job — send or delete that draw instead of billing on a standard invoice.`,
    };
  }
  return {
    ok: false,
    error: "This job is billed with progress draws — add a progress/final draw instead of billing on a standard invoice.",
  };
}

/** Guard the IMPORT / ADD-content paths: block when the target is a STANDARD invoice
 *  on a job that already has an active draw. Returns an error Result, else null. */
async function standardInvoiceOnDrawJob(supabase: any, inv: any, invoiceId: string): Promise<Result | null> {
  if ((inv?.invoice_kind ?? "standard") !== "standard") return null;
  const draw = await activeDrawOnJob(supabase, inv.job_id, invoiceId);
  return shouldBlockStandardImport(inv?.invoice_kind, !!draw) ? drawConflictError(draw) : null;
}

/** Guard standard-invoice CREATION for a job: block making a new standard invoice for
 *  a job already on the draw path (createInvoiceFromQuote embeds the full quoted amount
 *  at creation, so the content guards never see it). Returns an error Result, else null. */
async function blockStandardCreateOnDrawJob(supabase: any, jobId: string | null | undefined): Promise<Result | null> {
  if (!jobId) return null;
  const draw = await activeDrawOnJob(supabase, jobId);
  return draw ? drawConflictError(draw) : null;
}

/** Import labor from the job's closed time entries: one line per person,
 *  hours × their hourly rate (falls back to the org default labor rate). */

/**
 * GAP B — a job's labor (resp. materials) must live on exactly ONE non-draw invoice. Draws
 * (deposit/progress/final) re-itemize actuals BY DESIGN and net them with a "Less previous billings"
 * credit line, so they're exempt — only OTHER *standard* invoices count as a clash. Returns the
 * clashing invoice number, or null. THIS is what stops "finish the job" (or a second Create Invoice)
 * from re-billing hours already sitting on another invoice — the Tao chandelier double.
 */
async function billedOnAnotherStandardInvoice(
  supabase: any,
  jobId: string,
  thisInvoiceId: string,
  source: "labor" | "costs",
): Promise<string | null> {
  const { data } = await supabase
    .from("invoices")
    .select("invoice_number, invoice_items(import_source)")
    .eq("job_id", jobId)
    .eq("invoice_kind", "standard")
    .neq("status", "void")
    .neq("id", thisInvoiceId);
  for (const inv of (data ?? []) as any[]) {
    if (((inv.invoice_items ?? []) as any[]).some((it) => it.import_source === source)) return inv.invoice_number as string;
  }
  return null;
}

export async function importLaborIntoInvoice(invoiceId: string): Promise<Result & { empty?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv?.job_id) return { ok: false, error: "This invoice isn't linked to a job." };
  const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
  if (conflict) return conflict;
  // M1: imports BUILD a draft invoice — refuse to re-inflate a sent/paid one. Every other line
  // mutation (add/update/delete) is draft-locked; the importers were the outliers, which let
  // labor+materials get piled onto Tao J-002's already-partial deposit invoice AFTER a progress
  // draw had billed the same actuals — the double-charge. A draw imports into its own FRESH draft,
  // so this never blocks legitimate progress billing.
  const draftBlock = await requireDraftInvoice(supabase, invoiceId);
  if (draftBlock) return draftBlock;
  // GAP B: don't bill this job's labor on a SECOND standard invoice. Importing into a DRAW is exempt
  // (draws re-itemize + net via a credit line), so this only guards standard→standard.
  if (!isDrawKind((inv as any).invoice_kind)) {
    const clash = await billedOnAnotherStandardInvoice(supabase, inv.job_id, invoiceId, "labor");
    if (clash) return { ok: false, error: `This job's labor is already billed on ${clash}. Edit that invoice, or bill extra work as a progress payment.` };
  }

  // Bill the EXACT time on this job via the shared labor-billing helper (so the
  // billed lines reconcile to the penny with the progress-report "work to date").
  const [labor, { data: org }] = await Promise.all([
    fetchJobLaborRows(supabase, inv.job_id),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  const defaultRate = getOrgSettings((org as any)?.settings).default_labor_rate; // via the settings SSOT
  const { lines } = computeJobLaborBilling(labor.jobEntries, labor.jobAllocs, defaultRate);
  if (lines.length === 0) return { ok: false, error: "No billable hours on this job yet.", empty: true };

  const rep = await replaceImportedItems(
    supabase,
    invoiceId,
    "labor",
    lines.map((l) => ({
      description: `Labor — ${l.name}`,
      quantity: l.quantity,
      unit: "hr",
      unit_price: l.rate,
    })),
  );
  if (rep.error) return { ok: false, error: rep.error };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

/** Import materials from the job's costs: purchase orders + supplier bills,
 *  marked up by `markupPercent` (so they bill at sell price, not cost — the
 *  contractor doesn't do the math by hand). Each line stays editable after. */
export async function importCostsIntoInvoice(invoiceId: string, markupPercent = 0): Promise<Result & { empty?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv?.job_id) return { ok: false, error: "This invoice isn't linked to a job." };
  const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
  if (conflict) return conflict;
  const draftBlock = await requireDraftInvoice(supabase, invoiceId);
  if (draftBlock) return draftBlock; // M1: never re-inflate a sent/paid invoice (see importLaborIntoInvoice)
  if (!isDrawKind((inv as any).invoice_kind)) {
    const clash = await billedOnAnotherStandardInvoice(supabase, inv.job_id, invoiceId, "costs");
    if (clash) return { ok: false, error: `This job's materials are already billed on ${clash}. Edit that invoice, or bill extra on a progress payment.` }; // GAP B
  }

  const [{ data: pos }, { data: bills }] = await Promise.all([
    supabase.from("purchase_orders").select("id, po_number, vendor, total, status").eq("job_id", inv.job_id),
    supabase.from("bills").select("supplier, bill_number, amount, po_id").eq("job_id", inv.job_id),
  ]);

  // Mark up cost → sell price. Markup is NOT shown on the line (customers don't
  // see your margin); only the price reflects it.
  const mark = (cost: number) => Math.round(cost * (1 + (Number(markupPercent) || 0) / 100) * 100) / 100;
  const rows: { description: string; unit_price: number }[] = [];
  // Bill only LIVE purchase orders (the one shared rule): a draft/cancelled order was
  // never a real cost, and a PO whose supplier bill has arrived is superseded by that
  // bill — otherwise one CED delivery goes out on the invoice as two material charges.
  for (const p of livePurchaseOrders((pos ?? []) as any[], (bills ?? []) as any[])) {
    if (Number(p.total) > 0) rows.push({ description: `Materials — ${p.vendor} (PO ${p.po_number})`, unit_price: mark(Number(p.total)) });
  }
  for (const b of bills ?? []) {
    if (Number(b.amount) > 0)
      rows.push({ description: `Materials — ${b.supplier}${b.bill_number ? ` (bill #${b.bill_number})` : ""}`, unit_price: mark(Number(b.amount)) });
  }
  if (!rows.length) return { ok: false, error: "No purchase orders or bills on this job yet.", empty: true };

  const rep = await replaceImportedItems(
    supabase,
    invoiceId,
    "costs",
    rows.map((r) => ({ description: r.description, quantity: 1, unit: "lot", unit_price: r.unit_price })),
  );
  if (rep.error) return { ok: false, error: rep.error };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

/** Create a progress/final DRAW that doubles as a progress report: itemizes all
 *  actual labor (at bill rate) + materials (with markup) to date, then credits
 *  prior billings (deposit + earlier draws) so the balance due is just the new
 *  work since the last bill — the standard cumulative (AIA-style) progress format.
 *  The single invoice shows the customer the running tally AND the amount owed. */
export async function createProgressReportInvoice(
  jobId: string,
  kind: "progress" | "final",
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const [{ data: job }, { data: org }, { data: existingDraft }, { data: sched }] = await Promise.all([
    supabase.from("jobs").select("customer_id, name").eq("id", jobId).maybeSingle(),
    supabase.from("organizations").select("settings").maybeSingle(),
    supabase.from("invoices").select("invoice_number").eq("job_id", jobId).eq("status", "draft")
      .in("invoice_kind", [...DRAW_KINDS]).limit(1).maybeSingle(),
    supabase.from("payment_milestones").select("id").eq("job_id", jobId).limit(1).maybeSingle(),
  ]);
  if (!job) return { ok: false, error: "Job not found." };
  // Mutual exclusion: a job billing on a payment schedule must draw via "Request next
  // payment" (the milestone path), not this ad-hoc work-to-date draw.
  if (sched)
    return { ok: false, error: "This job bills on a payment schedule — use “Request next payment” from the schedule instead." };
  // H3/M6: at most one draft draw per job — a second would re-import and re-bill
  // the whole job, double-charging once both are sent.
  if (existingDraft) {
    return { ok: false, error: `Draft ${(existingDraft as any).invoice_number} is still open on this job — send or delete it before creating another draw.` };
  }
  // H4 (reverse): if a standard invoice already bills this job's labor/materials, a
  // draw here would re-import and double-bill the same work. Block before creating it.
  const stdBlocker = await standardBillingBlockerOnJob(supabase, jobId);
  if (stdBlocker) return standardBillingConflictError(stdBlocker);
  const settings = getOrgSettings((org as any)?.settings);
  const markup = settings.material_markup_percent;
  const dueDate = await defaultDueDateIso(supabase);

  const { data: inv, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: job.customer_id,
      job_id: jobId,
      status: "draft",
      title: kind === "final" ? "Final invoice" : "Progress payment",
      invoice_kind: kind,
      tax_rate: 0,
      subtotal: 0,
      tax: 0,
      total: 0,
      due_date: dueDate,
    })
    .select("id")
    .single();
  if (error) {
    if ((error as any).code === "23505")
      return { ok: false, error: "A draft draw is already open on this job — send or delete it before creating another." };
    return { ok: false, error: error.message };
  }

  // Itemize the actual work to date (labor at bill rate + materials with markup). A real import failure
  // here would silently understate the draw — log it instead of swallowing (empty:true = nothing to bill).
  const pLabor = await importLaborIntoInvoice(inv.id);
  if (!pLabor.ok && !pLabor.empty) reportError("createProgressReportInvoice.labor", pLabor.error, { jobId, invoiceId: inv.id });
  const pCosts = await importCostsIntoInvoice(inv.id, markup);
  if (!pCosts.ok && !pCosts.empty) reportError("createProgressReportInvoice.costs", pCosts.error, { jobId, invoiceId: inv.id });

  const { data: afterImport } = await supabase.from("invoices").select("total").eq("id", inv.id).maybeSingle();
  const importedTotal = Number(afterImport?.total ?? 0);

  // Prior billings actually SENT to the customer (deposit + earlier sent draws;
  // drafts and void excluded) so they only pay for work since the last bill.
  const { data: priorInvs } = await supabase
    .from("invoices")
    .select("total, status")
    .eq("job_id", jobId)
    .neq("id", inv.id);
  const priorBilled = (priorInvs ?? []).reduce(
    (s: number, i: any) => (i.status !== "void" && i.status !== "draft" ? s + Number(i.total ?? 0) : s),
    0,
  );

  // H1: a draw must never go negative. The pure, unit-tested resolveDrawCredit
  // decides whether to bail (nothing logged / prior billings already cover it) or
  // how much to credit (floored so the balance never drops below $0).
  const decision = resolveDrawCredit(importedTotal, priorBilled);
  if (!decision.ok) {
    await supabase.from("invoices").delete().eq("id", inv.id);
    return {
      ok: false,
      error:
        decision.reason === "no-work"
          ? "No labor or materials are logged on this job yet to bill."
          : "Prior billings already cover the work logged so far — nothing new to bill yet.",
    };
  }
  if (decision.credit > 0.005) {
    // Stamp it import_source:"draw_credit" so it's tamper-evident — deleting/editing
    // this negative line would wipe the prior-billings offset and re-bill the deposit,
    // so updateInvoiceItem/deleteInvoiceItem refuse to touch it. (org_id via trigger.)
    await supabase.from("invoice_items").insert({
      invoice_id: inv.id,
      description: "Less previous billings (deposit & prior draws)",
      quantity: 1,
      unit: "lot",
      unit_price: -decision.credit,
      import_source: "draw_credit",
    });
    await recalcInvoice(supabase, inv.id);
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidateMoney();
  return { ok: true, id: inv.id };
}

// ── Payment schedule (Fixed-Bid "payment structure") ────────────────────────────

/** Contract total for a job = the agreed amount (shared rule — see contractTotalFromQuotes). */
async function jobContractTotal(supabase: any, jobId: string): Promise<number> {
  const { data: quotes } = await supabase.from("quotes").select("total, status").eq("job_id", jobId);
  return contractTotalFromQuotes((quotes ?? []) as any);
}

/** Replace a job's payment schedule. Only allowed before any milestone has been
 *  billed (a draw drafted against it) — once billing starts the schedule is locked. */
export async function setPaymentSchedule(
  jobId: string,
  milestones: { label: string; percent?: number | null; amount?: number | null }[],
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // Org guard: the job must be visible to this caller (RLS) before we attach a schedule.
  const { data: job } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  // Mutual exclusion: a payment schedule and the ad-hoc draw path can't both bill a
  // job. Refuse to attach a schedule once ANY draw exists on the job.
  const { data: draw } = await supabase
    .from("invoices")
    .select("invoice_number")
    .eq("job_id", jobId)
    .neq("status", "void")
    .in("invoice_kind", [...DRAW_KINDS])
    .limit(1)
    .maybeSingle();
  if (draw)
    return { ok: false, error: "This job already has draws — a payment schedule can only be set before any billing starts." };

  const { data: existing } = await supabase
    .from("payment_milestones")
    .select("id, invoice_id")
    .eq("job_id", jobId);
  if ((existing ?? []).some((m: any) => m.invoice_id))
    return { ok: false, error: "Billing has already started on this schedule — manage the remaining draws from Billing." };

  if ((existing ?? []).length) await supabase.from("payment_milestones").delete().eq("job_id", jobId);

  const rows = (milestones ?? [])
    .map((m, i) => ({
      job_id: jobId,
      sort_order: i,
      label: (m.label || `Payment ${i + 1}`).slice(0, 80),
      percent: m.percent != null && Number(m.percent) > 0 ? Number(m.percent) : null,
      amount: m.amount != null && Number(m.amount) > 0 ? Number(m.amount) : null,
    }))
    .filter((m) => m.percent != null || m.amount != null);
  if (!rows.length) {
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  }

  // C5: a schedule partitions the contract — its draws (percent AND fixed-amount, each its
  // own invoice) can't sum past the contract or they silently over-bill. Cap the TOTAL
  // scheduled $ (so a MIXED percent+fixed schedule can't slip past a percent-only check),
  // and surface a percent schedule that sums UNDER 100% as a silent underbill.
  const contract = await jobContractTotal(supabase, jobId);
  const sched = scheduleStatus(rows as Milestone[], contract);
  if (sched.overContract)
    return {
      ok: false,
      error: `Those milestones total ${formatCurrency(sched.scheduledTotal)} — more than the ${formatCurrency(contract)} contract. Lower the percentages or amounts so they don't exceed it.`,
    };
  // Percent-only over-bill (no contract yet to price the dollars against): keep the 100% cap.
  if (sched.scheduledPct > 100.01)
    return { ok: false, error: `Those milestones add up to ${Math.round(sched.scheduledPct)}% — a draw schedule can't exceed 100% of the contract.` };
  if (sched.percentUnder)
    return {
      ok: false,
      error: `Those milestones add up to ${Math.round(sched.scheduledPct)}% — they don't cover the full contract. Add up to 100% so nothing goes unbilled.`,
    };

  const { error } = await supabase.from("payment_milestones").insert(rows); // org_id via trigger
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

/** Request the next payment per the job's structure:
 *  Fixed Bid with a schedule → draft the next milestone draw;
 *  otherwise (T&M, or fixed with no schedule) → bill the work logged since the last bill. */
export async function requestNextPayment(jobId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: job } = await supabase
    .from("jobs")
    .select("billing_type, customer_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  const { data: milestones } = await supabase
    .from("payment_milestones")
    .select("*")
    .eq("job_id", jobId)
    .order("sort_order");

  const isFixed = (job as any).billing_type !== "tm";
  if (isFixed && (milestones ?? []).length) {
    const contract = await jobContractTotal(supabase, jobId);
    const status = scheduleStatus((milestones ?? []) as Milestone[], contract);
    if (!status.next) return { ok: false, error: "Every scheduled payment has already been billed." };
    return createMilestoneDraw(supabase, jobId, (job as any).customer_id ?? null, status);
  }
  // T&M (or fixed without a schedule): bill the work logged since the last bill.
  return createProgressReportInvoice(jobId, "progress");
}

/** Internal: draft one milestone draw — a single fixed line at the milestone's $,
 *  linked back to the milestone. No prior-billings credit: milestones partition the
 *  contract, so each draw is its own slice (unlike the work-to-date progress draw). */
async function createMilestoneDraw(
  supabase: any,
  jobId: string,
  customerId: string | null,
  status: ReturnType<typeof scheduleStatus>,
): Promise<Result> {
  const next = status.next;
  if (!next) return { ok: false, error: "Every scheduled payment has already been billed." };
  if (!(next.dollars > 0))
    return { ok: false, error: "That payment is $0 — set the contract total (a quote) or a fixed amount on the schedule first." };

  // H3: at most one draft draw open per job.
  const { data: existingDraft } = await supabase
    .from("invoices")
    .select("invoice_number")
    .eq("job_id", jobId)
    .eq("status", "draft")
    .in("invoice_kind", [...DRAW_KINDS])
    .limit(1)
    .maybeSingle();
  if (existingDraft)
    return { ok: false, error: `Draft ${(existingDraft as any).invoice_number} is still open on this job — send or delete it before requesting the next payment.` };

  // H4 (reverse): a standard invoice already billing this job's work blocks a draw.
  const stdBlocker = await standardBillingBlockerOnJob(supabase, jobId);
  if (stdBlocker) return standardBillingConflictError(stdBlocker);

  const count = status.rows.length;
  const payNum = next.index + 1;
  const dueDate = await defaultDueDateIso(supabase);
  const { data: inv, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: customerId,
      job_id: jobId,
      status: "draft",
      title: next.label || (next.kind === "final" ? "Final payment" : next.kind === "deposit" ? "Deposit" : "Progress payment"),
      invoice_kind: next.kind,
      tax_rate: 0,
      subtotal: 0,
      tax: 0,
      total: 0,
      due_date: dueDate,
    })
    .select("id")
    .single();
  if (error) {
    // The partial unique index (one open draft draw per job) backstops a double-submit
    // race that slips past the SELECT above — surface the friendly message, not raw SQL.
    if ((error as any).code === "23505")
      return { ok: false, error: "A draft draw is already open on this job — send or delete it before requesting the next payment." };
    return { ok: false, error: error.message };
  }

  const pctNote = Number(next.percent) > 0 ? ` (${Number(next.percent)}% of contract)` : "";
  await supabase.from("invoice_items").insert({
    invoice_id: inv.id,
    description: `${next.label || "Payment"} — payment ${payNum} of ${count}${pctNote}`,
    quantity: 1,
    unit: "lot",
    unit_price: next.dollars,
    import_source: "milestone",
  });
  await recalcInvoice(supabase, inv.id);

  // Link the milestone to the draw (this is what marks it "billed"; deleting the draft
  // nulls the FK and re-offers it). Reported, never silently desynced.
  if (next.id) {
    const { data: claimed, error: mErr } = await supabase
      .from("payment_milestones")
      .update({ status: "billed", invoice_id: inv.id, billed_amount: next.dollars })
      .eq("id", next.id)
      .is("invoice_id", null) // CLAIM only if still unbilled — wins the race vs a concurrent draw
      .select("id");
    if (mErr) {
      reportError("createMilestoneDraw.link", mErr, { jobId, milestoneId: next.id });
    } else if (!claimed || !claimed.length) {
      // Another request already drafted this milestone (the partial unique index usually blocks the
      // second invoice first; this is the belt-and-suspenders for a delete-then-redraw race). Roll
      // back the draft we just created so we don't leave an orphaned invoice claiming the slot.
      await supabase.from("invoices").delete().eq("id", inv.id);
      return { ok: false, error: "That payment was just drafted by another request — refresh and request the next one." };
    }
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidateMoney();
  return { ok: true, id: inv.id };
}

export async function updateInvoiceItem(
  itemId: string,
  invoiceId: string,
  item: { description?: string; quantity?: number; unit_price?: number },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const block = await requireDraftInvoice(supabase, invoiceId);
  if (block) return block; // M1: draft-only edits
  if (await isProtectedCreditLine(supabase, itemId)) return CREDIT_LINE_LOCKED;
  // PATCH semantics (mirrors updateBill): write ONLY the keys the caller sent — an
  // omitted field never touches its column (it used to reset qty to 1 / price to $0).
  const clean: Record<string, unknown> = {};
  if (item.description !== undefined) {
    if (!item.description.trim()) return { ok: false, error: "Description is required." };
    clean.description = item.description.trim();
  }
  if (item.quantity !== undefined) clean.quantity = item.quantity || 1;
  if (item.unit_price !== undefined) clean.unit_price = item.unit_price || 0;
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };
  const { error } = await supabase
    .from("invoice_items")
    .update(clean)
    .eq("id", itemId)
    .eq("invoice_id", invoiceId); // L3: the item must belong to THIS invoice
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

export async function deleteInvoiceItem(
  itemId: string,
  invoiceId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const block = await requireDraftInvoice(supabase, invoiceId);
  if (block) return block; // M1: draft-only edits
  if (await isProtectedCreditLine(supabase, itemId)) return CREDIT_LINE_LOCKED;
  const { error } = await supabase
    .from("invoice_items")
    .delete()
    .eq("id", itemId)
    .eq("invoice_id", invoiceId); // L3: the item must belong to THIS invoice
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

/** The auto-calculated "less previous billings" draw credit is tamper-evident: it
 *  carries import_source:"draw_credit". Editing or deleting it would wipe the
 *  prior-billings offset and re-bill the customer for the deposit + earlier draws,
 *  so the item mutations refuse it. */
const CREDIT_LINE_LOCKED: Result = {
  ok: false,
  error:
    "That's the automatic “less previous billings” credit — it can't be edited or deleted, since it's what keeps this draw from re-billing the deposit and prior draws.",
};
// A draw's auto credit line AND its milestone line are tamper-evident: hand-editing either
// desyncs the prior-billings offset or payment_milestones. (M2 — lock milestone like draw_credit.)
async function isProtectedCreditLine(supabase: any, itemId: string): Promise<boolean> {
  const { data } = await supabase.from("invoice_items").select("import_source").eq("id", itemId).maybeSingle();
  return data?.import_source === "draw_credit" || data?.import_source === "milestone";
}

// Line edits are for DRAFTS only — once an invoice is sent/paid/void, its lines are locked so
// a voice/agent (or a stray UI tap) can't silently re-bill a customer or un-pay a paid invoice
// via recalc. (M1 — the "reversible draft only" guarantee the voice money-loop rests on.)
const NOT_DRAFT_LOCKED: Result = {
  ok: false,
  error:
    "This invoice has already been sent, so its lines are locked. Edit it while it's still a draft, or record an adjustment / new invoice instead.",
};
async function requireDraftInvoice(supabase: any, invoiceId: string): Promise<Result | null> {
  const { data: inv } = await supabase.from("invoices").select("status").eq("id", invoiceId).maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (inv.status !== "draft") return NOT_DRAFT_LOCKED;
  return null;
}

export async function setInvoiceStatus(
  id: string,
  status: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("invoices").update({ status }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  // Voiding a milestone draw re-opens its milestone — the FK only auto-clears on
  // delete, not void — so "Request next payment" offers that slice again and the
  // schedule's billed-to-date stops counting a cancelled draw.
  if (status === "void") {
    const { error: mErr } = await supabase
      .from("payment_milestones")
      .update({ status: "pending", invoice_id: null, billed_amount: null })
      .eq("invoice_id", id);
    if (mErr) reportError("setInvoiceStatus.unlinkMilestone", mErr, { invoiceId: id });
  }
  revalidateMoney();
  revalidateMoney(id);
  return { ok: true };
}

/** A "YYYY-MM-DD" payment date → a stable ISO timestamp at NOON IN THE ORG'S TZ. Delegates to the tz
 *  helper so it's deterministic across deploy environments — the old bare `new Date(`${d}T12:00:00`)`
 *  had no Z, so it was parsed in the SERVER's timezone (the exact trap tz.ts exists to replace). */
function dateToIso(d: string | null | undefined, tz: string): string | undefined {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  const t = tzLocalHourUtc(d, 12, tz);
  return isNaN(t.getTime()) ? undefined : t.toISOString();
}

/** The org's configured timezone (for stamping date-only inputs). Defaults to Pacific. */
async function orgTz(supabase: { from: (t: string) => any }): Promise<string> {
  const { data } = await supabase.from("organizations").select("settings").maybeSingle();
  return getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone || "America/Los_Angeles";
}

export async function recordPayment(input: {
  invoice_id: string;
  amount: number;
  method: string;
  note: string;
  paid_at?: string | null;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "Enter a payment amount." };
  if (input.amount > 9_999_999) return { ok: false, error: "That amount is too large." };

  // M2: confirm the invoice is visible to this org (a cross-org id returns null
  // under the org-scoped read policy) before recording a payment against it.
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, org_id, invoice_number, total, amount_paid, customers(name)")
    .eq("id", input.invoice_id)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };

  // M4: a misheard amount ("$30k" on a $3k invoice) shouldn't silently overpay + mark paid.
  // invoiceBalance already rounds to cents AND floors at 0 — the exact cap this guard wants.
  const cap = invoiceBalance(inv.total, inv.amount_paid);
  if (input.amount > cap + 0.01) {
    return {
      ok: false,
      error: `That's more than the $${cap.toLocaleString()} balance on invoice ${inv.invoice_number}. Enter up to the balance, or fix the invoice first.`,
    };
  }

  const paidAt = dateToIso(input.paid_at, await orgTz(supabase));
  // L2: a payment can't be dated into the future (wrong tax / reporting period).
  if (paidAt && Date.parse(paidAt) > Date.now() + 86_400_000) {
    return { ok: false, error: "That payment date is in the future." };
  }
  const { error } = await supabase.from("payments").insert({
    invoice_id: input.invoice_id,
    amount: input.amount,
    method: input.method || "check",
    note: input.note || null,
    recorded_by: ctx.userId,
    ...(paidAt ? { paid_at: paidAt } : {}),
  });
  if (error) return { ok: false, error: error.message };

  await recalcInvoice(supabase, input.invoice_id);
  // Cash-in ping to the OTHER office staff (the recorder already knows).
  const cust = (inv as any).customers?.name as string | undefined;
  void sendPushToProfiles(
    (await orgStaffIds(inv.org_id)).filter((id) => id !== ctx.userId),
    "invoice_paid",
    {
      title: "Payment recorded",
      body: `${formatCurrency(input.amount)} on ${inv.invoice_number || "an invoice"}${cust ? ` — ${cust}` : ""}`,
      url: `/billing/${input.invoice_id}`,
    },
  );
  revalidateMoney(input.invoice_id);
  revalidateMoney();
  return { ok: true };
}

/** Edit a recorded payment (amount / method / note) and recompute the invoice. */
export async function updatePayment(
  paymentId: string,
  invoiceId: string,
  patch: { amount: number; method: string; note: string; paid_at?: string | null },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!patch.amount || patch.amount <= 0) return { ok: false, error: "Enter a payment amount." };
  if (patch.amount > 9_999_999) return { ok: false, error: "That amount is too large." };
  const paidAt = dateToIso(patch.paid_at, await orgTz(supabase));
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
  revalidateMoney(invoiceId);
  revalidateMoney();
  return { ok: true };
}

/** Remove a recorded payment (typo'd entry etc.) and recompute the invoice. */
export async function deletePayment(paymentId: string, invoiceId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("payments").delete().eq("id", paymentId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  revalidateMoney();
  return { ok: true };
}

/** Delete an invoice — only while no payments are recorded against it
 *  (paid history must stay; void those instead). */
export async function deleteInvoice(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { count } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", id);
  if (count && count > 0) {
    return { ok: false, error: "This invoice has recorded payments — delete those first or mark the invoice void." };
  }
  // Keep the milestone reset symmetric with void: the FK nulls invoice_id on delete,
  // but clear the status/snapshot too so no stale 'billed' row lingers.
  await supabase
    .from("payment_milestones")
    .update({ status: "pending", billed_amount: null })
    .eq("invoice_id", id);
  const { error } = await supabase.from("invoices").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidateMoney();
  return { ok: true };
}

/** Set the invoice tax rate (percent in → stored as decimal) and recompute. */
export async function setInvoiceTaxRate(
  invoiceId: string,
  ratePercent: number,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const rate = Number.isFinite(ratePercent) ? ratePercent / 100 : 0;
  const { error } = await supabase.from("invoices").update({ tax_rate: rate }).eq("id", invoiceId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

/** Edit the invoice's description (the scope shown above the line items). */
export async function setInvoiceDescription(
  invoiceId: string,
  description: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase
    .from("invoices")
    .update({ description: description.trim() || null })
    .eq("id", invoiceId);
  if (error) return { ok: false, error: error.message };
  revalidateMoney(invoiceId);
  return { ok: true };
}

/** Edit the invoice's title (the short label shown in the header / lists). */
export async function setInvoiceTitle(
  invoiceId: string,
  title: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase
    .from("invoices")
    .update({ title: title.trim() || null })
    .eq("id", invoiceId);
  if (error) return { ok: false, error: error.message };
  revalidateMoney(invoiceId);
  revalidateMoney();
  return { ok: true };
}

/** Set (or clear) the invoice due date — the field the Overdue tracker reads.
 *  Stamps a "YYYY-MM-DD" input to noon in the org tz, same as payment dates. */
export async function setInvoiceDueDate(
  invoiceId: string,
  date: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const dueDate = date ? dateToIso(date, await orgTz(supabase)) ?? null : null;
  const { error } = await supabase
    .from("invoices")
    .update({ due_date: dueDate })
    .eq("id", invoiceId);
  if (error) return { ok: false, error: error.message };
  revalidateMoney(invoiceId);
  revalidateMoney();
  return { ok: true };
}

/** Correct the customer/job link on a DRAFT invoice. Draft-only: once sent, the
 *  billing relationship is locked (a draw job is also blocked — its draw is itemized
 *  at creation). Any chosen ids must be visible to this org (RLS filters the lookup,
 *  so an id from another tenant resolves to null and is rejected).
 *  PATCH semantics: only the keys the caller sent are written — an omitted link is
 *  left alone (it used to unlink BOTH); an explicit null clears it. */
export async function setInvoiceCustomerJob(
  invoiceId: string,
  link: { customer_id?: string | null; job_id?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (link.customer_id === undefined && link.job_id === undefined)
    return { ok: false, error: "Nothing to update." };

  // Header edits to the billing relationship are only safe while it's a draft.
  const draftBlock = await requireDraftInvoice(supabase, invoiceId);
  if (draftBlock) return draftBlock;

  // H4: don't re-point a draft onto a job already on the draw path.
  const drawBlock = await blockStandardCreateOnDrawJob(supabase, link.job_id ?? null);
  if (drawBlock) return drawBlock;

  const clean: Record<string, unknown> = {};

  // Validate any chosen ids are visible to this org (RLS scopes the read).
  let customerId = link.customer_id || null;
  const jobId = link.job_id || null;
  if (jobId) {
    const { data: job } = await supabase
      .from("jobs")
      .select("id, customer_id")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return { ok: false, error: "That job isn't available." };
    // Keep the invoice attached to the job's customer so revenue/costs roll up.
    if (!customerId) customerId = job.customer_id ?? null;
  }
  if (customerId) {
    const { data: cust } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customerId)
      .maybeSingle();
    if (!cust) return { ok: false, error: "That customer isn't available." };
  }
  if (link.job_id !== undefined) clean.job_id = jobId;
  // The customer also moves when a re-pointed job carries its own customer along.
  if (link.customer_id !== undefined || (jobId && customerId)) clean.customer_id = customerId;

  // Grab the OLD job first so re-pointing the invoice refreshes BOTH job pages — else the
  // old job keeps showing the moved invoice in its billing/financials.
  const { data: prevInv } = await supabase.from("invoices").select("job_id").eq("id", invoiceId).maybeSingle();
  const oldJobId = (prevInv as { job_id: string | null } | null)?.job_id ?? null;

  const { error } = await supabase
    .from("invoices")
    .update(clean)
    .eq("id", invoiceId);
  if (error) return { ok: false, error: error.message };
  revalidateMoney(invoiceId);
  for (const jid of new Set([oldJobId, jobId].filter(Boolean) as string[])) revalidatePath(`/jobs/${jid}`);
  return { ok: true };
}

/* recalcInvoice now lives in @/lib/invoice-recalc (imported above) — the Stripe webhook
 * is a route handler and can't import a private helper out of a "use server" module, so
 * it carried a second, credit-blind copy of the amount_paid math. One definition now. */
