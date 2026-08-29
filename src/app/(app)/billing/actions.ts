"use server";
import { dbError } from "@/lib/db-error";
import QRCode from "qrcode";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { customerForInquiry } from "@/lib/actions/win-customer";
import { changeOrderLines, noChangeOrdersReason, type ChangeOrderRow } from "@/lib/change-order-billing";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { headers } from "next/headers";
import { bustDocPdf, warmDocPdf } from "@/lib/pdf-cache";
import { revalidateMoney } from "@/lib/revalidate-money";
import { createClient } from "@/lib/supabase/server";
import { deliverInvoiceEmail } from "@/lib/invoice-email";
import { sendSms } from "@/lib/sms";
import { pushInvoiceToQbo } from "@/lib/quickbooks";
import { getOrgSettings, orgPublicBaseUrl } from "@/lib/org-settings";
import { tzLocalHourUtc } from "@/lib/tz";
import { requireStaff } from "@/lib/staff-guard";
import { computeJobLaborBilling, customerLaborRateForJob, customerMaterialMarkupForJob, fetchJobLaborRows } from "@/lib/labor-billing";
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
  if (error) return { ok: false, error: dbError(error) };
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
  // ctx.orgId was resolved and then DISCARDED here, which is what let a staff member of any tenant
  // push an invoice belonging to another one straight into that tenant's QuickBooks. It is
  // nullable on the guard's type, and a null org must REFUSE rather than fall through to an
  // unscoped read — that is the exact shape of the hole this closes.
  if (!ctx.orgId) return { ok: false, error: "No organization on your account." };
  const res = await pushInvoiceToQbo(id, ctx.orgId);
  if (res.ok) revalidateMoney(id);
  return { ok: res.ok, error: res.error };
}

/**
 * The customer-facing link for an invoice, on the CONTRACTOR'S OWN domain.
 *
 * This used to be built from NEXT_PUBLIC_SITE_URL — the platform's host — so a texted invoice
 * sent the customer to the software vendor's domain while the same invoice emailed from
 * lib/invoice-email.ts (which uses orgPublicBaseUrl) sent them to the contractor's. Two links to
 * the same document on two different domains, and the wrong one is the one that doesn't look
 * like the business the customer just hired.
 */
async function publicInvoiceLink(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string | null | undefined,
  token: string,
): Promise<string> {
  const { data: org } = orgId
    ? await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle()
    : { data: null };
  const base = orgPublicBaseUrl(getOrgSettings((org as { settings?: unknown } | null)?.settings));
  return `${base}/i/${token}`;
}

/**
 * SHARE SHEET payload for an invoice — the thing that was missing entirely.
 *
 * Erik went to send Jackie an invoice, found no Share button, and fell back to the iOS share
 * sheet from /print/pdf-preview. iOS shares the PAGE, so she received the root layout's metadata:
 * the title "Contractor North", the description "AI-powered field service platform for
 * contractors — CRM, quoting, scheduling…", and a link to app.contractornorth.com that is not in
 * PUBLIC_PATHS and therefore shows her a login screen. His software vendor's sales pitch and a
 * door she can't open. Nothing of hers leaked — but nothing useful arrived either.
 *
 * So the app has to own the payload rather than letting the OS guess it. Same wording as the SMS
 * (textInvoice, below) on purpose: one message, whichever way it goes out.
 */
export async function invoiceShareText(
  id: string,
): Promise<{ ok: boolean; error?: string; title?: string; text?: string; url?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: invoice } = await ctx.supabase
    .from("invoices")
    .select("invoice_number, status, total, amount_paid, public_token, org_id, organizations(name)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const token = (invoice as { public_token?: string | null }).public_token;
  if (!token) return { ok: false, error: "This invoice has no customer link yet." };

  // A DRAFT'S LINK IS A 404, SO REFUSE RATHER THAN HAND IT OVER (cn-v700).
  //
  // Every invoice is born `draft`, and migration 0187 narrowed public_invoice to
  // ('sent','partial','paid','overdue') to stop unsent pricing being readable. Every OTHER way a
  // link leaves the building flips draft→sent on the way past — textInvoice below,
  // deliverInvoiceEmail. The share sheet has no send step to hang that on, so it was the one
  // egress that handed out a link to a page the customer cannot open.
  //
  // It refuses instead of silently sending, because the failure is invisible from this side: the
  // OS share sheet reports success, the text goes, and the first anyone hears is a customer
  // saying the link is broken. It does NOT flip the status by itself — sharing is not sending,
  // and a status change nobody asked for is how an unfinished price becomes a debt.
  if (String((invoice as { status?: string | null }).status ?? "") === "draft")
    return { ok: false, error: "This invoice is still a draft — send it first, then share the link." };

  const who = (invoice as { organizations?: { name?: string } }).organizations?.name ?? "Your contractor";
  const balance = invoiceBalance(invoice.total, invoice.amount_paid);
  const url = await publicInvoiceLink(ctx.supabase, (invoice as { org_id?: string }).org_id, token);
  return {
    ok: true,
    title: `Invoice ${invoice.invoice_number} — ${who}`,
    text: `${who}: Invoice ${invoice.invoice_number}, balance ${formatCurrency(balance)}. View/pay:`,
    url,
  };
}

export async function textInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_number, total, amount_paid, status, public_token, org_id, customers(name, phone)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const customer = (invoice as any).customers;
  if (!customer?.phone)
    return { ok: false, error: "This customer has no phone number." };

  const { data: org } = await supabase.from("organizations").select("name, settings").maybeSingle();
  const balance = invoiceBalance(invoice.total, invoice.amount_paid);
  const link = await publicInvoiceLink(supabase, (invoice as any).org_id, (invoice as any).public_token);
  const body = `${org?.name ?? "Your contractor"}: Invoice ${invoice.invoice_number}, balance $${balance.toFixed(2)}. View/pay: ${link}`;

  const sent = await sendSms(customer.phone, body, (org as any)?.settings?.sms_from_number);
  if (!sent)
    return { ok: false, error: "Text not sent — add your Twilio account to enable SMS." };
  if (invoice.status === "draft") {
    await supabase.from("invoices").update({ status: "sent" }).eq("id", id);
    // Same reason as setInvoiceStatus: a prepaid draft must land on paid/partial, not 'sent'.
    await recalcInvoice(supabase, id);
  }
  // Warm the stored PDF (0198) post-response so the customer's Download button works from
  // the first minute — after() never slows the send; the render carries the sender's cookies.
  const h = await headers();
  const warmHost = h.get("x-forwarded-host") ?? h.get("host");
  const warmProto = h.get("x-forwarded-proto") ?? "https";
  const warmCookie = h.get("cookie");
  // Headers are read BEFORE after() — request APIs inside the callback are on borrowed time.
  after(async () => {
    if (warmHost) await warmDocPdf("invoice", id, `${warmProto}://${warmHost}`, warmCookie);
  });
  return { ok: true };
}

export async function emailInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const res = await deliverInvoiceEmail(ctx.supabase, id);
  if (res.ok) {
    revalidateMoney(id);
    // Warm the stored PDF (0198) post-response so the customer's Download button works from
    // the first minute — after() never slows the send; the render carries the sender's cookies.
    const h = await headers();
    const warmHost = h.get("x-forwarded-host") ?? h.get("host");
    const warmProto = h.get("x-forwarded-proto") ?? "https";
    const warmCookie = h.get("cookie");
    // Headers are read BEFORE after() — request APIs inside the callback are on borrowed time.
    after(async () => {
      if (warmHost) await warmDocPdf("invoice", id, `${warmProto}://${warmHost}`, warmCookie);
    });
  }
  return res;
}

export type Result = { ok: boolean; error?: string; id?: string };

/** What an import actually did (migration 0175), so the UI can say it plainly instead of
 *  "imported" — the ambiguity of that one word is most of why the old behaviour felt like
 *  force-feeding. `kept_edited` is the number the office cares about: their negotiated prices. */
export type ImportStats = { inserted: number; updated: number; kept_edited: number; removed: number };
type ImportResult = Result & { empty?: boolean; stats?: ImportStats };

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
      /**
       * THE ESTIMATE'S NOTES DO NOT BECOME THE BILL'S (Erik, 8/18: "dont forget about all the
       * notes at the bottom from the estimate that shouldnt be there").
       *
       * A quote's notes describe an OFFER — "OPTIONS — not included in the total above",
       * A/B upgrades the customer didn't take, "this estimate is based on the assumption
       * that no obstacles arise". Copied onto an invoice they read as things being billed,
       * on a document that bills work already finished. Badger Lane's invoice carried its
       * estimate's options block verbatim, three weeks after the work was done.
       *
       * The invoice starts with its own empty notes. The work narrative has its own field
       * (description, printed above the line items) and the payment wording comes from the
       * org's invoice terms — neither is touched here.
       */
      notes: null,
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
  if (error) return { ok: false, error: dbError(error) };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("id, description, quantity, unit, unit_price, sort_order")
    .eq("quote_id", quoteId)
    .order("sort_order");

  if (items?.length) {
    // STAMP THE COPIES WITH THE IMPORTER'S OWN IDENTITY (audit v800). These rows used to land
    // with import_source NULL — indistinguishable from hand-typed lines — so a later tap of
    // "From Estimate" matched nothing, inserted the whole estimate a SECOND time, and doubled
    // the invoice total with no warning (the confirm counts rows by import_source, so it read
    // "0 replacing" and never fired). Keyed identically to importQuoteItemsIntoInvoice, a
    // re-import now refreshes these rows in place.
    const { error: itemsErr } = await supabase.from("invoice_items").insert(
      items.map((it: any) => ({
        invoice_id: invoice.id,
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        unit_price: it.unit_price,
        sort_order: it.sort_order,
        import_source: "quote",
        import_key: `quote:${it.id}`,
      })),
    );
    if (itemsErr) return { ok: false, error: dbError(itemsErr) };
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
  if (error) return { ok: false, error: dbError(error) };

  revalidateMoney();
  if (input.job_id) revalidatePath(`/jobs/${input.job_id}`);
  return { ok: true, id: data.id };
}

/**
 * PUT THE LINES IN THE ORDER HE READS THEM IN (Erik, 8/18).
 *
 * "id really like to be able to move line items up and down just like the playbook so … if i
 * delete something and realize i want it i dont need to reimport", and "id like to be able to
 * group the labor together since itll be showing up at the bottom of the list."
 *
 * An invoice is a document a customer reads top to bottom, and until now its order was an
 * accident of when each line was imported or typed. sort_order existed and nothing could change
 * it. This writes the whole sequence in one call — the same shape the playbook's reorder uses —
 * so a move is atomic and can't leave two lines fighting over one position.
 *
 * Draft-only (the customer's copy is fixed once sent) and every id must belong to THIS invoice:
 * a crafted list can neither reach another tenant's line nor drag one invoice's item onto
 * another's. Ordering is presentation — it never touches an amount, so nothing here recalcs.
 */
/**
 * PARK A DRAFT (0206) — the ending that doesn't destroy anything.
 *
 * A draft waiting on a change order or the customer's go-ahead had only two exits: Void (which
 * unlinks the payment milestones) or Delete (which throws away the line items). Both record
 * something false about a bill that is simply not ready. This sets a date the office chooses;
 * the invoice leaves Needs action and comes BACK when the date passes — because "parked
 * forever" is how a real bill gets forgotten, which is the failure the feeder exists to prevent.
 */
export async function parkInvoice(invoiceId: string, until: string | null, reason?: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Parking is a DRAFTING decision — a sent invoice is the customer's, and it owes money.
  const block = await requireDraftInvoice(supabase, invoiceId);
  if (block) return block;
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, error: "Pick a date." };

  const { data: wrote, error } = await supabase
    .from("invoices")
    .update({ hold_until: until, hold_reason: until ? (reason?.trim() || null) : null })
    .eq("id", invoiceId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That didn't save — check your access and try again." };
  revalidateMoney(invoiceId);
  revalidatePath("/planner");
  return { ok: true };
}

export async function reorderInvoiceItems(invoiceId: string, orderedIds: string[]): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const block = await requireDraftInvoice(supabase, invoiceId);
  if (block) return block;

  const { data: mine } = await supabase.from("invoice_items").select("id").eq("invoice_id", invoiceId);
  const own = new Set(((mine ?? []) as { id: string }[]).map((r) => r.id));
  const ids = (orderedIds ?? []).filter((id) => own.has(id));
  // Any line the caller didn't name keeps its place at the end, so a stale tab can never
  // silently drop a row out of the document.
  const rest = [...own].filter((id) => !ids.includes(id));
  const finalOrder = [...ids, ...rest];
  if (!finalOrder.length) return { ok: true };

  for (let i = 0; i < finalOrder.length; i++) {
    const { data: wrote, error } = await supabase
      .from("invoice_items")
      .update({ sort_order: i })
      .eq("id", finalOrder[i])
      .eq("invoice_id", invoiceId)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    // Silent-write law: an RLS-refused reorder must not report success.
    if (!wrote?.length) return { ok: false, error: "That didn't save — check your access and try again." };
  }
  revalidateMoney(invoiceId);
  return { ok: true };
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
  /**
   * A NEW LINE GOES AT THE END (Erik, 8/18: "i just added a line item for labor - brian and it
   * automatically sent it to the top").
   *
   * The insert never set sort_order, so the column default of 0 applied — and 0 sorts ABOVE
   * every imported line (the importer numbers them as it goes). So every line typed by hand
   * jumped to the top of the customer's document, which reads as the app rearranging his
   * invoice behind his back. Append, then let him move it with the arrows.
   */
  const { data: last } = await supabase
    .from("invoice_items")
    .select("sort_order")
    .eq("invoice_id", invoiceId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = Number((last as { sort_order?: number } | null)?.sort_order ?? -1) + 1;

  const { error } = await supabase.from("invoice_items").insert({
    invoice_id: invoiceId,
    description: item.description,
    quantity: item.quantity || 1,
    unit: item.unit || "ea",
    unit_price: item.unit_price || 0,
    sort_order: nextSort,
  });
  if (error) return { ok: false, error: dbError(error) };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

/** Replace this invoice's previously-imported rows for a given source with a fresh set, so
 *  re-importing REFRESHES the lines (current total) instead of duplicating them. Delegates
 *  to the atomic, advisory-locked RPC (0156) so two overlapping imports can't both land.
 *  Hand-entered rows (import_source null) and other sources are never touched. */
/** An imported line, carrying the stable identity of the thing it represents. */
type ImportRow = { import_key: string; description: string; quantity: number; unit: string; unit_price: number };

/**
 * ADDITIVE import (migration 0175). Matches incoming rows against what is already on the
 * invoice BY KEY, so one call can refresh, append and leave-alone independently:
 *
 *   new key                       -> appended   (the work that accrued since — the whole point)
 *   existing key, never edited    -> refreshed in place, keeping its sort_order
 *   existing key, edited by hand  -> LEFT ALONE (a negotiated price is not the importer's to touch)
 *   key deleted from this invoice -> never comes back (tombstoned in dismissed_import_keys)
 *   key gone from the source      -> removed, unless it was edited
 *
 * This replaces a delete-and-rebuild that had no key at all, so "import only the new time and
 * materials" was not merely unimplemented — there was nothing to match on. Still advisory-locked
 * per (invoice, source) and still SECURITY INVOKER, so RLS governs the writes exactly as before.
 */
async function upsertImportedItems(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceId: string,
  source: string,
  rows: ImportRow[],
): Promise<{ error?: string; stats?: { inserted: number; updated: number; kept_edited: number; removed: number } }> {
  const { data, error } = await supabase.rpc("upsert_imported_invoice_items", {
    p_invoice_id: invoiceId,
    p_source: source,
    p_rows: rows,
  });
  if (error) return { error: dbError(error) };
  return { stats: (data ?? undefined) as never };
}

/** Import the linked job's quote line items into this invoice (idempotent). */
export async function importQuoteItemsIntoInvoice(invoiceId: string): Promise<ImportResult> {
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
    .select("id, description, quantity, unit, unit_price")
    .eq("quote_id", quoteId)
    .order("sort_order");
  if (!items?.length) return { ok: false, error: "The quote has no line items." };

  const rep = await upsertImportedItems(
    supabase,
    invoiceId,
    "quote",
    items.map((it: any) => ({
      import_key: `quote:${it.id}`,
      description: it.description,
      quantity: Number(it.quantity),
      unit: it.unit,
      unit_price: Number(it.unit_price),
    })),
  );
  if (rep.error) return { ok: false, error: rep.error };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  // Report what actually happened. "3 added, 2 updated, 5 of your edited lines left alone" is a
  // different sentence from "Materials imported", and it is the one that tells the office whether
  // their negotiated prices survived.
  return { ok: true, stats: rep.stats };
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
  source: "labor" | "costs" | "change_orders",
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

/**
 * START ONE IMPORT SOURCE OVER (0204) — the release for 0175's three protections.
 *
 * Erik: "i tried to reimport the timcard entries so i could get the order right … but its not
 * working." Every guard was doing its job: the crew member's line he deleted was TOMBSTONED so
 * no import would resurrect it, and the lines that survived were `edited`, which an import must
 * never overwrite. So the import ran, changed nothing, and said so in numbers nobody reads as a
 * refusal. Deleting a line to re-import it in a different order is an ordinary thing to want;
 * without this there was no way back at all.
 *
 * Draft-only and staff-only (the RPC re-checks both), scoped to ONE source, and it drops the
 * lines as the IMPORTER so they aren't tombstoned again on the way out. The caller then runs
 * the importer, which rebuilds the source from scratch, in source order.
 */
export async function reimportFromScratch(
  invoiceId: string,
  source: "labor" | "costs" | "quote" | "change_orders",
  /** The % showing in the card's markup box. "Start it over" sits directly under "Materials
   *  From Costs" and must price identically (audit v800 verification): without this the two
   *  buttons in one card produced different money — the box's number for one, the customer's
   *  resolved default for the other — and neither the confirm nor the toast names a percent. */
  markupPercent?: number,
): Promise<ImportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.rpc("reset_import_source", { p_invoice_id: invoiceId, p_source: source });
  if (error) return { ok: false, error: dbError(error) };
  const run =
    source === "labor"
      ? importLaborIntoInvoice(invoiceId)
      : source === "costs"
        ? importCostsIntoInvoice(invoiceId, markupPercent)
        : source === "change_orders"
          ? importChangeOrdersIntoInvoice(invoiceId)
          : importQuoteItemsIntoInvoice(invoiceId);
  return run;
}

export async function importLaborIntoInvoice(invoiceId: string): Promise<ImportResult> {
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
  const [labor, { data: org }, levelRate] = await Promise.all([
    fetchJobLaborRows(supabase, inv.job_id),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    customerLaborRateForJob(supabase, inv.job_id),
  ]);
  const defaultRate = getOrgSettings((org as any)?.settings).default_labor_rate; // via the settings SSOT
  const { lines } = computeJobLaborBilling(labor.jobEntries, labor.jobAllocs, defaultRate, levelRate, labor.nonBillableCodes);
  if (lines.length === 0) return { ok: false, error: "No billable hours on this job yet.", empty: true };

  const rep = await upsertImportedItems(
    supabase,
    invoiceId,
    "labor",
    lines.map((l) => ({
      // Keyed by PERSON: the importer aggregates a job's time per head, so "Erik" is one
      // line whose hours grow. Re-importing refreshes it — unless the office negotiated
      // the number, in which case `edited` protects it and a NEW person still appends.
      import_key: `labor:${l.personId}`,
      // THE RATE'S PROVENANCE, ON THE LINE. Erik, staring at an import: "still importing at 150"
      // — the number was his tech's own bill_rate doing exactly its job, and nothing said so, so
      // it read as a bug. A line that names its source explains itself; one that doesn't becomes
      // a report.
      description: `Labor — ${l.name}${levelRate && levelRate > 0 ? " (customer rate)" : l.rate !== defaultRate ? ` (${l.name}'s bill rate)` : ""}`,
      quantity: l.quantity,
      unit: "hr",
      unit_price: l.rate,
    })),
  );
  if (rep.error) return { ok: false, error: rep.error };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  // Report what actually happened. "3 added, 2 updated, 5 of your edited lines left alone" is a
  // different sentence from "Materials imported", and it is the one that tells the office whether
  // their negotiated prices survived.
  return { ok: true, stats: rep.stats };
}

/**
 * AN APPROVED CHANGE ORDER BECOMES MONEY (audit v800 wave B).
 *
 * `change_orders` has a `co_number`, a `description`, an `amount` and an approve/reject control.
 * The amount was read by NOTHING. Not by any invoice, not by the contract total, not by job
 * profitability, not by analytics — verified by grepping every reader in the codebase. You could
 * raise a change order, print it, walk it to the customer, have them approve it, mark it
 * approved, and the money simply never existed anywhere in the app. On a deck build that is not
 * an edge case; change orders are how the job actually gets priced.
 *
 * THROUGH THE ONE BILLING PATH, not beside it. This is an importer with the same shape as labour
 * and costs — same draft lock, same draw-job conflict check, same idempotent upsert, same
 * `edited` protection — because a second way to put a line on an invoice is how Tao Zhu got
 * charged twice. Nothing here writes an invoice total; recalcInvoice does, as it does for
 * everything else.
 *
 * ONE LINE PER CHANGE ORDER, keyed `co:<id>`. Re-importing after the office revises an amount
 * updates that line rather than appending a second one, and a change order approved later
 * appends without disturbing what is already there. A line the office has since negotiated by
 * hand is `edited` and the importer leaves it alone — same contract as every other import.
 *
 * APPROVED ONLY. A pending change order is a proposal and a rejected one is a decision; billing
 * either would be inventing an agreement. This is also why nothing needs a "billed" flag on the
 * change order itself: the invoice line IS the record, and the double-bill guard below is what
 * stops the same approval landing on two standard invoices.
 */
export async function importChangeOrdersIntoInvoice(invoiceId: string): Promise<ImportResult> {
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
  if (draftBlock) return draftBlock;
  if (!isDrawKind((inv as { invoice_kind?: string }).invoice_kind)) {
    const clash = await billedOnAnotherStandardInvoice(supabase, inv.job_id, invoiceId, "change_orders");
    if (clash)
      return {
        ok: false,
        error: `This job's change orders are already billed on ${clash}. Edit that invoice, or bill new work as a progress payment.`,
      };
  }

  const { data: cos, error: readErr } = await supabase
    .from("change_orders")
    .select("id, co_number, description, amount")
    .eq("job_id", inv.job_id)
    .eq("status", "approved")
    .order("created_at", { ascending: true });
  // A FAILED READ IS NOT AN EMPTY LIST (the recalcQuote lesson). supabase-js returns data:null on
  // error, and treating that as "no change orders" would tell the office there is nothing to bill
  // on a job that has thousands of dollars of approved extras.
  if (readErr) return { ok: false, error: dbError(readErr) };
  // The two decisions worth pinning — which ones count as money, and what the customer reads —
  // live in lib/change-order-billing where they are unit-tested. A credit (negative amount) is a
  // real change order and passes straight through; only $0 is dropped.
  const rows = (cos ?? []) as ChangeOrderRow[];
  const lines = changeOrderLines(rows);
  if (!lines.length) return { ok: false, error: noChangeOrdersReason(rows), empty: true };

  const rep = await upsertImportedItems(supabase, invoiceId, "change_orders", lines);
  if (rep.error) return { ok: false, error: rep.error };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  revalidatePath("/change-orders");
  return { ok: true, stats: rep.stats };
}

/** Import materials from the job's costs: purchase orders + supplier bills,
 *  marked up by `markupPercent` (so they bill at sell price, not cost — the
 *  contractor doesn't do the math by hand). Each line stays editable after. */
/** `markupPercent` is OPTIONAL, not defaulted to zero (audit v800). The old `= 0` default meant
 *  a caller that forgot it billed the customer at raw COST — and `reimportFromScratch`, the
 *  amber "Start it over" button that is the ONLY way forward on any invoice built before 0175,
 *  forgot it. When it is absent we resolve the customer's real markup here, so the mistake is
 *  no longer reachable from any call site, present or future. */
export async function importCostsIntoInvoice(invoiceId: string, markupPercent?: number): Promise<ImportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv?.job_id) return { ok: false, error: "This invoice isn't linked to a job." };
  // Resolve the markup when the caller did not state one — same resolver the manual import box
  // and the progress-draw path use, so every door prices a level customer's materials alike.
  let markup = markupPercent;
  if (markup === undefined) {
    const { data: orgRow } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
    markup = await customerMaterialMarkupForJob(
      supabase,
      inv.job_id,
      getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).material_markup_percent,
    );
  }
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
    supabase.from("bills").select("id, supplier, bill_number, amount, po_id").eq("job_id", inv.job_id),
  ]);
  // The itemized lines behind each bill (the receipt-reader stores every receipt line).
  // A bill WITH lines goes onto the invoice item-by-item — real descriptions, quantities,
  // and per-item prices — instead of one opaque "vendor · 1 lot" lump (Erik, 7/24). A bill
  // without lines (hand-entered) still imports as its lump.
  const billIds = ((bills ?? []) as any[]).map((b) => b.id);
  const { data: blis } = billIds.length
    ? await supabase
        .from("bill_line_items")
        .select("id, bill_id, description, quantity, unit_price, amount, category, sort_order")
        .in("bill_id", billIds)
        .order("sort_order")
    : { data: [] as any[] };
  const linesByBill = new Map<string, any[]>();
  for (const l of (blis ?? []) as any[]) {
    if (!linesByBill.has(l.bill_id)) linesByBill.set(l.bill_id, []);
    linesByBill.get(l.bill_id)!.push(l);
  }

  // Mark up cost → sell price. Markup is NOT shown on the line (customers don't
  // see your margin); only the price reflects it.
  const mark = (cost: number) => Math.round(cost * (1 + (Number(markup) || 0) / 100) * 100) / 100;
  const rows: ImportRow[] = [];
  // Bill only LIVE purchase orders (the one shared rule): a draft/cancelled order was
  // never a real cost, and a PO whose supplier bill has arrived is superseded by that
  // bill — otherwise one CED delivery goes out on the invoice as two material charges.
  for (const p of livePurchaseOrders((pos ?? []) as any[], (bills ?? []) as any[])) {
    if (Number(p.total) > 0) rows.push({ import_key: `po:${p.id}`, description: `Materials — ${p.vendor} (PO ${p.po_number})`, quantity: 1, unit: "lot", unit_price: mark(Number(p.total)) });
  }
  // ── THE ANCHOR INVARIANT (adversarial-review fix, 7/24) ──────────────────────────────
  // Each bill's itemized rows must sum to EXACTLY mark(bill.amount) — the same figure the
  // lump path bills, computeJobProgress reports, and livePurchaseOrders' PO-supersede math
  // subtracts. Itemization changes PRESENTATION, never the total. Mechanically:
  //  • line sell = round(signed line AMOUNT × (1+m)) — never per-unit rounding × qty
  //    (a 1000-count $25 line billed $30 that way); qty×unit renders only when it
  //    reproduces the exact sell, else the qty folds into the description.
  //  • negatives (discounts/returns) stay negative rows — dropping or abs()ing them
  //    overbilled above the bill's net.
  //  • receipt tax lines aren't itemized as fake marked-up "Sales Tax" rows; they land in
  //    the per-bill remainder row ("Supplies & tax"), same opacity as the lump always had.
  //  • the remainder row absorbs tax + rounding + unreadable/unpriced lines, so a bill
  //    whose lines are junk still bills its full amount (never $0), and a corrected
  //    bill.amount always wins over stale lines.
  for (const b of (bills ?? []) as any[]) {
    if (!(Number(b.amount) > 0)) continue;
    const target = mark(Number(b.amount));
    const lines = (linesByBill.get(b.id) ?? []).filter((l) => !/tax/i.test(String(l.category ?? "")));
    const billRows: typeof rows = [];
    let emitted = 0;
    for (const l of lines) {
      const qty = Number(l.quantity) || 0;
      const rawAmt =
        l.amount != null && Number(l.amount) !== 0 && !isNaN(Number(l.amount))
          ? Number(l.amount)
          : (Number(l.unit_price) || 0) * (qty || 1);
      if (!rawAmt) continue; // unpriced line → its cost stays in the remainder row
      const sell = Math.round(rawAmt * (1 + (Number(markup) || 0) / 100) * 100) / 100;
      if (!sell) continue;
      const desc = String(l.description || "Materials").slice(0, 300);
      const unitExact = qty > 0 ? Math.round((sell / qty) * 100) / 100 : sell;
      if (qty > 0 && Number.isInteger(qty) && Math.round(unitExact * qty * 100) / 100 === sell) {
        billRows.push({ import_key: `bli:${l.id}`, description: desc, quantity: qty, unit: "ea", unit_price: unitExact });
        emitted = Math.round((emitted + unitExact * qty) * 100) / 100;
      } else {
        billRows.push({ import_key: `bli:${l.id}`, description: qty > 1 ? `${desc} (${qty} ea)` : desc, quantity: 1, unit: "ea", unit_price: sell });
        emitted = Math.round((emitted + sell) * 100) / 100;
      }
    }
    const remainder = Math.round((target - emitted) * 100) / 100;
    if (!billRows.length) {
      rows.push({ import_key: `bill:${b.id}`, description: `Materials — ${b.supplier}${b.bill_number ? ` (bill #${b.bill_number})` : ""}`, quantity: 1, unit: "lot", unit_price: target });
      continue;
    }
    if (Math.abs(remainder) >= 0.01) {
      billRows.push({ import_key: `bill:${b.id}:remainder`, description: `Supplies & tax — ${b.supplier}`, quantity: 1, unit: "ea", unit_price: remainder });
    }
    rows.push(...billRows);
  }
  if (!rows.length) return { ok: false, error: "No purchase orders or bills on this job yet.", empty: true };

  const rep = await upsertImportedItems(supabase, invoiceId, "costs", rows);
  if (rep.error) return { ok: false, error: rep.error };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  // Report what actually happened. "3 added, 2 updated, 5 of your edited lines left alone" is a
  // different sentence from "Materials imported", and it is the one that tells the office whether
  // their negotiated prices survived.
  return { ok: true, stats: rep.stats };
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
  // Seed from the customer's pricing level (falling back to the org default) — the same
  // resolver the manual import box and the work-to-date panel use, so a draw can't bill a
  // level customer's materials at a different rate than a standard invoice would.
  const markup = await customerMaterialMarkupForJob(supabase, jobId, settings.material_markup_percent);
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
    return { ok: false, error: dbError(error) };
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
    .select("subtotal, status")
    .eq("job_id", jobId)
    .neq("id", inv.id);
  // SUBTOTAL, not total (audit 8): the credit line is inserted INSIDE this draw's subtotal, so
  // netting a tax-INCLUSIVE prior against pre-tax work credited the customer their own tax and
  // then taxed the inflated remainder — the draw came out over the true cumulative bill.
  const priorBilled = (priorInvs ?? []).reduce(
    (s: number, i: any) => (i.status !== "void" && i.status !== "draft" ? s + Number(i.subtotal ?? 0) : s),
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
  const { data: quotes } = await supabase.from("quotes").select("total, status, created_at").eq("job_id", jobId);
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
  if (error) return { ok: false, error: dbError(error) };
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
    return { ok: false, error: dbError(error) };
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
  item: { description?: string; quantity?: number; unit?: string; unit_price?: number },
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
  // The UNIT is the contractor's own word for what he sold — hrs, lot, ea, ft, days (Erik,
  // 8/18: "when i add a new line item i dont have a choice to label it differently"). It was
  // writable only by the importers, so every hand-added line said "ea" forever.
  if (item.unit !== undefined) clean.unit = String(item.unit).trim().slice(0, 12) || "ea";
  if (item.unit_price !== undefined) clean.unit_price = item.unit_price || 0;
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };
  const { data: touched, error } = await supabase
    .from("invoice_items")
    .update(clean)
    .eq("id", itemId)
    .eq("invoice_id", invoiceId) // L3: the item must belong to THIS invoice
    .select("id"); // audit v800: a zero-row write is a failure, not a quiet success
  if (error) return { ok: false, error: dbError(error) };
  if (!touched?.length) return { ok: false, error: "That line isn't on this invoice." };
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
  const { data: gone, error } = await supabase
    .from("invoice_items")
    .delete()
    .eq("id", itemId)
    .eq("invoice_id", invoiceId) // L3: the item must belong to THIS invoice
    .select("id"); // audit v800: a zero-row delete is a failure, not a quiet success
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length) return { ok: false, error: "That line isn't on this invoice." };
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
  if (error) return { ok: false, error: dbError(error) };
  // A DRAFT never auto-advances on payment (cn-v549), so a draft that was fully prepaid
  // (Jackie's Venmo before the invoice went out) leaves this call marked 'sent' and stays
  // there forever — never 'paid', permanently on the AR list. Recompute once the row is no
  // longer a draft; recalcInvoice re-derives status from total vs amount_paid.
  if (status !== "draft" && status !== "void") await recalcInvoice(supabase, id);
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
  if (error) return { ok: false, error: dbError(error) };

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
  // EDIT must obey the same two rules as recording (M4 overpay cap, L2 future date) — an
  // edit is just a second way to write the same number, and the typo it fixes is as likely
  // as the typo it introduces. Cap against the balance the OTHER payments leave, i.e. the
  // current balance plus whatever this payment is contributing today.
  const [{ data: inv }, { data: cur }] = await Promise.all([
    supabase.from("invoices").select("total, amount_paid, invoice_number").eq("id", invoiceId).maybeSingle(),
    supabase.from("payments").select("amount").eq("id", paymentId).maybeSingle(),
  ]);
  if (!inv) return { ok: false, error: "Invoice not found." };
  const cap =
    invoiceBalance((inv as any).total, (inv as any).amount_paid) + Number((cur as any)?.amount ?? 0);
  if (patch.amount > cap + 0.01) {
    return {
      ok: false,
      error: `That's more than the $${cap.toLocaleString()} this invoice can take. Enter up to that, or fix the invoice first.`,
    };
  }
  const paidAt = dateToIso(patch.paid_at, await orgTz(supabase));
  if (paidAt && Date.parse(paidAt) > Date.now() + 86_400_000) {
    return { ok: false, error: "That payment date is in the future." };
  }
  const { error } = await supabase
    .from("payments")
    .update({
      amount: patch.amount,
      method: patch.method || "check",
      note: patch.note || null,
      ...(paidAt ? { paid_at: paidAt } : {}),
    })
    .eq("id", paymentId);
  if (error) return { ok: false, error: dbError(error) };
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
  if (error) return { ok: false, error: dbError(error) };
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
  const { count, error: countErr } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", id);
  // FAIL CLOSED (audit 8): a transient error made `count` undefined, the guard fell through,
  // and the CASCADE took the payment rows with the invoice — the money simply vanished from
  // the books with nothing to reconcile against.
  if (countErr) return { ok: false, error: dbError(countErr) };
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
  if (error) return { ok: false, error: dbError(error) };
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
  // THE ONE MONEY MUTATION THAT HAD NO DRAFT LOCK (audit 8): every item edit and importer
  // refuses a sent invoice, but the tax dropdown stayed live — so a mis-tap on a PAID invoice
  // silently re-totalled it, flipped it back to partial, and put a different number on the
  // document the customer already holds.
  const draftBlock = await requireDraftInvoice(supabase, invoiceId);
  if (draftBlock) return draftBlock;
  const rate = Number.isFinite(ratePercent) ? ratePercent / 100 : 0;
  const { error } = await supabase.from("invoices").update({ tax_rate: rate }).eq("id", invoiceId);
  if (error) return { ok: false, error: dbError(error) };
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
  if (error) return { ok: false, error: dbError(error) };
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
  if (error) return { ok: false, error: dbError(error) };
  await bustDocPdf("invoice", invoiceId); // the title renders on the PDF (audit 7)
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
  if (error) return { ok: false, error: dbError(error) };
  await bustDocPdf("invoice", invoiceId); // the due date renders on the PDF (audit 7)
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
  if (error) return { ok: false, error: dbError(error) };
  revalidateMoney(invoiceId);
  for (const jid of new Set([oldJobId, jobId].filter(Boolean) as string[])) revalidatePath(`/jobs/${jid}`);
  return { ok: true };
}

/* recalcInvoice now lives in @/lib/invoice-recalc (imported above) — the Stripe webhook
 * is a route handler and can't import a private helper out of a "use server" module, so
 * it carried a second, credit-blind copy of the amount_paid math. One definition now. */

/**
 * DONE & PAID — the whole critical path in one motion.
 *
 * Erik, the finding this exists for: "Nora & Fermin, i was there for an hour and some change they
 * paid me 150 cash and i was out — and from the lead or calendar i had to go through the ringer of
 * step to even get to anything useful and i gave up... i had to fill out the inspection to then
 * have to fill out the estimate to then find the invoice somewhere to then mark done and then
 * input the payment."
 *
 * Five artifacts demanded for a job that was ALREADY DONE with cash ALREADY IN HAND. Every one of
 * those stages exists for work that hasn't happened yet — an inspection informs an estimate, an
 * estimate seeks a yes — and the yes was in his pocket. Forcing the pipeline backwards through
 * finished work is exactly "the way the rest of the softwares are", the thing this app exists not
 * to be.
 *
 * So: one action, from the record he is already looking at. It composes the EXISTING writers
 * rather than inventing a parallel money path (ONE BILLING PATH):
 *
 *   invoice (the same shape createBlankInvoice writes)
 *   → one line for the work
 *   → recalcInvoice        (totals from the one math)
 *   → status "sent"        (paidStatus REFUSES to advance a draft — deliberate, Erik 7/24; this
 *                           invoice has genuinely left draft: the work is delivered and settled)
 *   → recordPayment        (the exported action — balance cap, org check, cash-in push, recalc
 *                           to "paid" — all inherited, not copied)
 *   → the visit marked completed, the lead stamped WON via the same customer-minting rule the
 *     accepted-estimate path uses. Cash in hand is the hardest possible win.
 *
 * Partial failure is reported honestly: once the invoice exists, later stumbles return its id and
 * say exactly what is left to do — never a bare error that hides the money record it created.
 */
export async function settleUp(input: {
  source: "appointment" | "job";
  id: string;
  amount: number;
  method: string; // cash | check | card | venmo | other
  note?: string;
  /** "record" (default) books the payment here and now — cash in hand. "later" builds and sends
   *  the invoice and completes the visit but leaves the balance open: the Venmo QR or the Stripe
   *  checkout on the customer's phone is about to settle it, and recording it twice would be the
   *  double-payment this action exists to prevent. */
  collect?: "record" | "later";
}): Promise<Result & { invoiceId?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter what they paid." };
  if (amount > 9_999_999) return { ok: false, error: "That amount is too large." };

  // ── What was the work, and who pays for it ─────────────────────────────────────────────────
  let title = "";
  let jobId: string | null = null;
  let customerId: string | null = null;
  let inquiryId: string | null = null;
  let apptId: string | null = null;

  if (input.source === "appointment") {
    const { data: a } = await supabase
      .from("appointments")
      .select("id, title, status, customer_id, inquiry_id, job_id")
      .eq("id", input.id)
      .maybeSingle();
    if (!a) return { ok: false, error: "That visit isn't available." };
    if (a.status === "cancelled") return { ok: false, error: "This visit was cancelled — un-cancel it first." };
    apptId = a.id;
    title = String(a.title ?? "Work completed");
    jobId = a.job_id ?? null;
    customerId = a.customer_id ?? null;
    inquiryId = a.inquiry_id ?? null;
  } else {
    const { data: j } = await supabase
      .from("jobs")
      .select("id, name, job_number, customer_id, inquiry_id")
      .eq("id", input.id)
      .maybeSingle();
    if (!j) return { ok: false, error: "That job isn't available." };
    jobId = j.id;
    title = String(j.name ?? j.job_number ?? "Work completed");
    customerId = j.customer_id ?? null;
    inquiryId = j.inquiry_id ?? null;
  }

  /* TAPPED TWICE IS SETTLED ONCE — BUT ONLY WHEN IT ACTUALLY SETTLED.
     The audit's worst finding lived here: this guard used to bare-return ok on ANY live anchored
     invoice, and the button toasts "Paid — Done" on ok. So the real sequence — show the Venmo QR
     (collect "later", invoice sent, balance open), customer never pays, hands cash days later, tap
     Pay now → cash — announced success and recorded NOTHING: cash in the pocket, an open invoice
     aging into overdue, and a customer who paid getting dunned. Same shape after any partial
     failure between the insert and the payment.
     The honest rule: an existing invoice short-circuits only when its balance is already zero.
     Otherwise the collection lands ON that invoice — the second tap becomes the payment it is —
     and the visit gets the completed stamp the first, interrupted call never wrote. */
  const settleExisting = async (
    invoiceId: string,
    total: number,
    amountPaid: number,
  ): Promise<Result & { invoiceId?: string }> => {
    const balance = invoiceBalance(total, amountPaid);
    if (balance > 0.005 && input.collect !== "later") {
      const paid = await recordPayment({
        invoice_id: invoiceId,
        // Never overpay the existing bill from a re-tap — its cap would refuse and the money
        // would bounce; the collection is whatever is actually still owed, up to what they gave.
        amount: Math.min(amount, balance),
        method: input.method || "cash",
        note: input.note?.trim() || "",
      });
      if (!paid.ok) return { ok: false, invoiceId, error: paid.error ?? "The payment didn't record — try it from the invoice." };
    }
    if (apptId) {
      await supabase
        .from("appointments")
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("id", apptId)
        .in("status", ["scheduled", "proposed"]);
      revalidatePath("/schedule");
      revalidatePath("/planner");
      revalidatePath(`/appointments/${apptId}`);
    }
    revalidateMoney(invoiceId);
    revalidateMoney();
    return { ok: true, invoiceId };
  };

  if (apptId) {
    const { data: existing } = await supabase
      .from("invoices")
      .select("id, total, amount_paid")
      .eq("appointment_id", apptId)
      .neq("status", "void")
      .limit(1)
      .maybeSingle();
    if (existing) return settleExisting(existing.id, Number(existing.total ?? 0), Number(existing.amount_paid ?? 0));
  } else if (jobId) {
    const { data: recent } = await supabase
      .from("invoices")
      .select("id, created_at, total, amount_paid")
      .eq("job_id", jobId)
      .eq("total", amount)
      .is("appointment_id", null) // never trip on another visit's settle-up bill
      .neq("status", "void")
      .neq("status", "draft") // a coincidental same-total DRAFT from another door is not this tap
      .gte("created_at", new Date(Date.now() - 5 * 60_000).toISOString())
      .limit(1)
      .maybeSingle();
    if (recent) return settleExisting(recent.id, Number(recent.total ?? 0), Number(recent.amount_paid ?? 0));
  }

  // A job on the draw path is billed by draws — same guard as every standard-invoice creator.
  const drawBlock = await blockStandardCreateOnDrawJob(supabase, jobId);
  if (drawBlock) return drawBlock;

  // Getting PAID is the win, so the lead's contact materializes here — through the ONE rule the
  // accepted-estimate path uses (dedup by the CRM's keys, the person's address not the site's,
  // lead stamped won). Best-effort: a contact-less invoice still records the money.
  if (!customerId && inquiryId) {
    customerId = await customerForInquiry(supabase, inquiryId, ctx.userId);
  }

  // ── The invoice, its one line, its real totals ─────────────────────────────────────────────
  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .insert({
      customer_id: customerId,
      job_id: jobId,
      title,
      description: input.note?.trim() || null,
      tax_rate: 0, // a flat settled amount — what they paid is what the record says
      appointment_id: apptId, // 0233: the anchor — idempotency AND "was this visit billed?"
      due_date: await defaultDueDateIso(supabase),
      status: "draft",
      created_by: ctx.userId,
    })
    .select("id, invoice_number")
    .single();
  if (invErr || !inv) {
    /* THE 0233 INDEX DID ITS JOB. Two taps on flaky truck LTE both pass the existence check
       above; the loser's insert trips invoices_one_per_appointment — and the loser is holding
       the SAME cash. Reroute it onto the winner's bill instead of surfacing "something with
       that value already exists", which points at a user mistake that doesn't exist.
       apptId-only: a 23505 on the job path is a number collision, and dbError's retry
       sentence is already right for that. */
    if ((invErr as { code?: string } | null)?.code === "23505" && apptId) {
      const { data: won } = await supabase
        .from("invoices")
        .select("id, total, amount_paid")
        .eq("appointment_id", apptId)
        .neq("status", "void")
        .limit(1)
        .maybeSingle();
      if (won) return settleExisting(won.id, Number(won.total ?? 0), Number(won.amount_paid ?? 0));
    }
    return { ok: false, error: dbError(invErr) };
  }

  const { error: itemErr } = await supabase.from("invoice_items").insert({
    invoice_id: inv.id,
    description: title,
    quantity: 1,
    unit: "EA",
    unit_price: amount,
    sort_order: 0,
  });
  if (itemErr) {
    return { ok: false, invoiceId: inv.id, error: `The invoice was created but its line didn't save — open it and add one. (${dbError(itemErr)})` };
  }
  await recalcInvoice(supabase, inv.id);

  // Sent, not draft: paidStatus deliberately never advances a DRAFT (a prepayment must not lock
  // an unsent bill's lines) — but this bill has left draft in the real world: delivered, settled,
  // on the doorstep. Without this step the payment below would record and the invoice would sit
  // "draft" forever, never reading as paid anywhere.
  await supabase.from("invoices").update({ status: "sent" }).eq("id", inv.id);

  // The one payment path — balance cap, org check, recalc-to-paid, cash-in push all inherited.
  // "later" leaves the balance open on purpose: Venmo/Stripe settles it in the customer's hands.
  if (input.collect !== "later") {
    const paid = await recordPayment({
      invoice_id: inv.id,
      amount,
      method: input.method || "cash",
      note: input.note?.trim() || "",
    });
    if (!paid.ok) {
      return { ok: false, invoiceId: inv.id, error: `The invoice was created but the payment didn't record — ${paid.error ?? "try it from the invoice."}` };
    }
  }

  // The deed happened; the calendar should say so. Guarded to live statuses so a completed visit
  // isn't re-stamped and a cancelled one can't be resurrected by a money write.
  if (apptId) {
    await supabase
      .from("appointments")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("id", apptId)
      .in("status", ["scheduled", "proposed"]);
    revalidatePath("/schedule");
    revalidatePath("/planner");
    revalidatePath("/inspections");
    revalidatePath(`/appointments/${apptId}`);
  }
  revalidateMoney(inv.id);
  revalidateMoney();
  return { ok: true, invoiceId: inv.id };
}

/**
 * WHAT TO PUT IN FRONT OF THE CUSTOMER, RIGHT NOW.
 *
 * Erik: "a pay now button is what we are missing and that can trigger the cc processing or if i
 * choose the others like cash then it closes, if i choose venmo then it gives me my venmo qr to
 * show the customer on the spot."
 *
 * This builds the on-the-spot artifacts for one invoice:
 *   CARD  → a QR of the invoice's own /api/pay/<token> door — the customer scans it and lands in
 *           Stripe Checkout ON THEIR PHONE (card, Apple Pay, Google Pay), and the webhook records
 *           the payment itself. Nothing to type, nothing to trust to memory.
 *   VENMO → a QR of the org's Venmo pay link with the amount and invoice number filled in. Venmo
 *           can't tell the app when it lands, so the button beside the QR records it by hand.
 *
 * QRs are data URLs (the same `qrcode` the share door uses) — nothing external, works offline
 * once rendered, which matters in a driveway with one bar of LTE.
 */
export async function collectArtifacts(invoiceId: string, collectAmount?: number): Promise<{
  ok: boolean;
  error?: string;
  balance?: number;
  invoiceNumber?: string | null;
  /** Stripe door — present only when the org can actually accept card payments. */
  payQr?: string;
  payUrl?: string;
  /** Venmo door — present only when Settings carries a handle. */
  venmoQr?: string;
  venmoHandle?: string;
}> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: inv } = await supabase
    .from("invoices")
    .select("id, invoice_number, total, amount_paid, public_token, org_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };

  const balance = invoiceBalance(inv.total, inv.amount_paid);
  const out: Awaited<ReturnType<typeof collectArtifacts>> = {
    ok: true,
    balance,
    invoiceNumber: inv.invoice_number ?? null,
  };

  const { data: org } = await supabase
    .from("organizations")
    .select("settings, stripe_account_id, stripe_charges_enabled, stripe_details_submitted")
    .eq("id", inv.org_id)
    .maybeSingle();

  // CARD — only when the door actually opens. A QR to a checkout that will 503 is worse than no QR.
  const token = (inv as { public_token?: string | null }).public_token;
  if (token && org && canAcceptPayments(connectStateFromOrg(org as never))) {
    const base = orgPublicBaseUrl(getOrgSettings((org as { settings?: unknown }).settings));
    const payUrl = `${base}/api/pay/${token}`;
    out.payUrl = payUrl;
    out.payQr = await QRCode.toDataURL(payUrl, { margin: 1, width: 480, color: { dark: "#0f172a" } });
  }

  // VENMO — the handle comes from Settings → Payment methods.
  // THE QR ASKS FOR WHAT WILL BE RECORDED. It used to encode the full balance while the "They
  // paid" button recorded the TYPED amount — a $100 partial against a $250 balance sent the
  // customer a $250 request and wrote $100 in the ledger: chased for money already sent.
  const asking = Math.min(Math.max(Number(collectAmount ?? balance), 0.01), balance);
  const handle = getOrgSettings((org as { settings?: unknown } | null)?.settings).venmo_handle?.trim();
  if (handle) {
    const note = encodeURIComponent(inv.invoice_number ? `Invoice ${inv.invoice_number}` : "Work completed");
    const venmoUrl = `https://venmo.com/u/${encodeURIComponent(handle)}?txn=pay&amount=${asking.toFixed(2)}&note=${note}`;
    out.venmoHandle = handle;
    out.venmoQr = await QRCode.toDataURL(venmoUrl, { margin: 1, width: 480, color: { dark: "#0f172a" } });
  }

  return out;
}
