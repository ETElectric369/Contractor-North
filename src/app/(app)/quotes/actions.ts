"use server";
import { reportError } from "@/lib/observe";
import { customerAddressFrom } from "@/lib/inquiries/lead-address";
import { dbError } from "@/lib/db-error";
import { parseAiJson } from "@/lib/ai-json";
import { statedLaborRate } from "@/lib/estimate/stated-rate";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { headers } from "next/headers";
import { bustDocPdf, warmDocPdf } from "@/lib/pdf-cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { INTAKE_BUCKET, extOf, intakePaths, isOwnIntakePath, uploadDisplayName } from "@/lib/playbook/uploads";
import { pickReadablePlans } from "@/lib/plan-brief";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { createNotifications } from "@/lib/notifications";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import { QUOTE_STATUSES } from "@/lib/statuses";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { effectiveMarkupPct } from "@/lib/pricing/markup";
import { reviewAgainstBook, type BookReview } from "@/lib/pricing/book-review";
import { CALC_TOOLS, runCalc } from "@/lib/electrical-calc";
import { recordAiUsage, aiSpendExceeded, currentOrgId } from "@/lib/ai-cost";
import { rateLimited } from "@/lib/rate-limit";
import type Anthropic from "@anthropic-ai/sdk";
import { getOrgSettings, accentHex, orgDocUrl } from "@/lib/org-settings";
import { mapEstimatorLine, type DraftLineItem, type BookRow, type LadderPrice } from "@/lib/estimate/line-map";
import { priceMaterial } from "@/lib/pricing/price-material";
import { sendEmail, renderQuoteNoticeEmail, ownerBcc } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { createWorkOrderFromQuote } from "../work-orders/actions";
import { createMaterialListFromQuote } from "../materials/actions";
import { findMatchingCustomerId, type DupCustomer } from "@/lib/crm/duplicates";
import { visibleCustomerIdOrNull } from "@/lib/job-visibility";
import { docLabel, type QuoteDocType } from "@/lib/doc-label";
import type { QuoteCircuit } from "@/lib/types";

/* Built from the ORG's settings, not NEXT_PUBLIC_SITE_URL — see orgDocUrl in lib/org-settings.
   Both callers below already fetch the org row, so this costs no extra query. */

export async function setQuoteType(id: string, docType: "estimate" | "quote") {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("quotes")
    .update({ doc_type: docType, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
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
    .select("quote_number, total, public_token, doc_type, status, customers(name, phone)")
    .eq("id", id)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found." };
  const customer = (quote as any).customers;
  if (!customer?.phone)
    return { ok: false, error: "This customer has no phone number." };

  const label = docLabel(quote as { doc_type?: string | null });
  const { data: org } = await supabase.from("organizations").select("name, settings").maybeSingle();
  const link = orgDocUrl(getOrgSettings((org as any)?.settings), "q", (quote as any).public_token);
  const body = `${org?.name ?? "Your contractor"}: ${label} ${quote.quote_number} ($${Number(quote.total).toFixed(2)}). View: ${link}`;

  const sent = await sendSms(customer.phone, body, (org as any)?.settings?.sms_from_number);
  if (!sent)
    return { ok: false, error: "Text not sent — add your Twilio account to enable SMS." };
  // Mark as sent once texted (unless already accepted/declined) — mirrors emailQuote.
  if (["draft"].includes((quote as any).status ?? "")) {
    await supabase.from("quotes").update({ status: "sent" }).eq("id", id);
  }
  // Warm the stored PDF (0198) post-response so the customer's Download button works from the
  // first minute — after() never slows the send, and the render carries this sender's cookies.
  const h = await headers();
  const warmHost = h.get("x-forwarded-host") ?? h.get("host");
  const warmProto = h.get("x-forwarded-proto") ?? "https";
  const warmCookie = h.get("cookie");
  // Headers are read BEFORE after() — request APIs inside the callback are on borrowed time.
  after(async () => {
    if (warmHost) await warmDocPdf("quote", id, `${warmProto}://${warmHost}`, warmCookie);
  });
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
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
  const label = docLabel(quote as { doc_type?: string | null });

  const { data: org } = await supabase
    .from("organizations")
    .select("name, phone, email, settings")
    .maybeSingle();
  // After the org fetch, because the link is built from the org's own domain now.
  const link = orgDocUrl(getOrgSettings((org as any)?.settings), "q", (quote as any).public_token);

  // Link-only notice (no re-rendered line-item table): the canonical document
  // lives at the /q link, so the email can never drift from the print/portal
  // view — mirrors the renderInvoiceNoticeEmail decision.
  const html = renderQuoteNoticeEmail({
    docType: label,
    number: quote.quote_number,
    company: {
      name: org?.name ?? "Contractor North",
      brand: accentHex(getOrgSettings((org as any)?.settings).glass_tint),
      phone: org?.phone,
      email: org?.email,
    },
    customerName: customer.name,
    title: quote.title,
    total: quote.total,
    quoteLink: link,
  });

  const res = await sendEmail({
    to: customer.email,
    subject: `${label} ${quote.quote_number} from ${org?.name ?? "us"}`,
    fromName: org?.name ?? undefined,
    html,
    replyTo: org?.email ?? undefined,
    bcc: ownerBcc(getOrgSettings((org as any)?.settings).copy_owner_on_emails, org?.email),
  });
  if (!res.ok) return res;

  // Mark as sent once emailed (unless already accepted/declined).
  if (["draft"].includes(quote.status)) {
    await supabase.from("quotes").update({ status: "sent" }).eq("id", id);
  }
  // Warm the stored PDF (0198) post-response so the customer's Download button works from the
  // first minute — after() never slows the send, and the render carries this sender's cookies.
  const h = await headers();
  const warmHost = h.get("x-forwarded-host") ?? h.get("host");
  const warmProto = h.get("x-forwarded-proto") ?? "https";
  const warmCookie = h.get("cookie");
  // Headers are read BEFORE after() — request APIs inside the callback are on borrowed time.
  after(async () => {
    if (warmHost) await warmDocPdf("quote", id, `${warmProto}://${warmHost}`, warmCookie);
  });
  revalidatePath(`/quotes/${id}`);
  return { ok: true };
}

/** Re-exported so the existing importers (quote builder, kit picker, deck panel) don't move.
 *  The definition lives with the pricing rules in @/lib/estimate/line-map. */
export type { DraftLineItem } from "@/lib/estimate/line-map";

export interface SaveQuoteInput {
  /** An existing DRAFT to update in place — the builder's autosave (Andrew's 45 accepted
      plan lines lived only in client state and vanished; a draft row is the fix). Absent =
      insert a new quote. Update is draft-locked: sent/accepted rows refuse it. */
  id?: string | null;
  customer_id: string | null;
  job_id?: string | null;
  /** The lead this estimate was seeded from (provenance backlink) — set when a lead is
      converted to a quote; null for quotes started from scratch. */
  inquiry_id?: string | null;
  /** The inspection appointment this estimate writes up (/quotes/new?capture=<id>) — on save
      the quote id is stamped onto that appointment's capture jsonb so the Inspections tab can
      file a LEAD-LESS "Inspect now" row (no inquiry/job to match otherwise). */
  capture_appointment_id?: string | null;
  title: string;
  description?: string | null;
  notes: string;
  tax_rate: number;
  valid_until: string | null;
  /** The customer-facing document word (builder toggle) — omitted = 'estimate',
   *  matching the app's estimate-first default (migration 0086). */
  doc_type?: QuoteDocType;
  items: DraftLineItem[];
}

/** The accepted-quote lock — the quote-side twin of requireDraftInvoice.
 *
 *  An accepted quote IS the contract, and `contractTotalFromQuotes` reads its live total.
 *  A partially-drawn payment schedule prices already-billed milestones off their FROZEN
 *  billed_amount but recomputes pending ones as `percent × the CURRENT contract` — so
 *  editing an accepted quote after the deposit is drawn silently re-bases the rest of the
 *  schedule. Drop a $10,000 quote to $8,000 after a $3,000 deposit and the remaining 40/30
 *  draws come to $5,600, billing $8,600 against an $8,000 contract; edit it upward and the
 *  difference is never billed. setPaymentSchedule's over-contract check only ever runs at
 *  schedule-creation time, so nothing downstream catches the drift.
 *
 *  A scope change after acceptance is a legitimate business event, so this is NOT a freeze
 *  on every accepted quote — only on one whose schedule has already drawn real money. The
 *  escape hatch is to revise: duplicate the quote (or void the draw), don't mutate the
 *  contract under a customer who already paid against it. */
async function requireEditableQuote(
  supabase: any,
  quoteId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: quote } = await supabase
    .from("quotes")
    .select("status, job_id, quote_number, doc_type")
    .eq("id", quoteId)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found." };
  if ((quote as any).status !== "accepted") return { ok: true };
  const jobId = (quote as any).job_id as string | null;
  if (!jobId) return { ok: true }; // accepted but no job yet → no schedule to shift

  // "Drawn" = a milestone linked to an invoice that still stands. A deleted/void draw
  // releases the lock (deleting a draft draw nulls the FK, the same signal the schedule
  // itself uses for billed-vs-pending), so a mistaken draw doesn't wedge the quote.
  const { data: drawn } = await supabase
    .from("payment_milestones")
    .select("invoice_id, invoices(status)")
    .eq("job_id", jobId)
    .not("invoice_id", "is", null);
  const live = ((drawn ?? []) as any[]).filter((m) => (m.invoices?.status ?? "") !== "void");
  if (!live.length) return { ok: true };

  const label = docLabel(quote as { doc_type?: string | null });
  return {
    ok: false,
    error: `${(quote as any).quote_number || `This ${label.toLowerCase()}`} is accepted and ${live.length} scheduled payment${live.length === 1 ? " has" : "s have"} already been billed against it — changing it now would re-price the remaining draws. Duplicate it as a revision (or void the draw) instead.`,
  };
}

/** Recompute subtotal/tax/total from the quote's line items. */
async function recalcQuote(supabase: any, quoteId: string) {
  // A FAILED READ IS NOT AN EMPTY QUOTE (audit v800 — the audit-8 guard that already protects
  // recalcInvoice, finally ported here). supabase-js returns data:null on any error, and
  // `(items ?? [])` turned one transient timeout into subtotal/tax/total = 0 written straight
  // over a real estimate — with the PDF busted so the customer's copy showed $0 too.
  const [quoteRes, itemsRes] = await Promise.all([
    supabase.from("quotes").select("tax_rate").eq("id", quoteId).maybeSingle(),
    supabase.from("quote_line_items").select("line_total").eq("quote_id", quoteId),
  ]);
  if (quoteRes.error || itemsRes.error || !itemsRes.data) {
    reportError("recalcQuote:read", quoteRes.error ?? itemsRes.error ?? new Error("no rows object"), { quoteId });
    // Leave the stored TOTALS alone — a failed read is not an empty quote. But the caller only
    // reaches recalc after CHANGING a line, so the stored PDF is stale no matter what happened
    // here: bust it anyway, or the customer's Download button keeps handing out a document that
    // shows neither the new line nor the old total (v800 verification).
    await bustDocPdf("quote", quoteId);
    return;
  }
  const { subtotal, tax, total } = subtotalTaxTotal(
    itemsRes.data.map((i: any) => Number(i.line_total ?? 0)),
    Number(quoteRes.data?.tax_rate ?? 0),
  );
  const { data: upd, error: updErr } = await supabase
    .from("quotes")
    .update({ subtotal, tax, total })
    .eq("id", quoteId)
    .select("id");
  if (updErr || !upd?.length) reportError("recalcQuote:write", updErr ?? new Error("zero rows"), { quoteId });
  // A sent quote stays editable (unlike an invoice), so every content write funnels here —
  // drop the stored PDF (0198) or the customer's Download button would hand out old numbers.
  await bustDocPdf("quote", quoteId);
}

export async function addQuoteItem(
  quoteId: string,
  item: { description: string; quantity: number; unit?: string; unit_price: number },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!item.description.trim()) return { ok: false, error: "Description is required." };
  const editable = await requireEditableQuote(supabase, quoteId);
  if (!editable.ok) return editable;
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
  if (error) return { ok: false, error: dbError(error) };
  await recalcQuote(supabase, quoteId);
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

export async function updateQuoteItem(
  itemId: string,
  quoteId: string,
  item: { description?: string; quantity?: number; unit?: string; unit_price?: number },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // PATCH semantics (mirrors updateBill): write ONLY the keys the caller sent — an
  // omitted field never touches its column (it used to reset unit to "ea", qty to 1…).
  const clean: Record<string, unknown> = {};
  if (item.description !== undefined) {
    if (!item.description.trim()) return { ok: false, error: "Description is required." };
    clean.description = item.description.trim();
  }
  if (item.quantity !== undefined) clean.quantity = item.quantity || 1;
  if (item.unit !== undefined) clean.unit = item.unit.trim() || "ea";
  if (item.unit_price !== undefined) clean.unit_price = item.unit_price || 0;
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };
  const editable = await requireEditableQuote(supabase, quoteId);
  if (!editable.ok) return editable;
  // SCOPE THE WRITE TO THE DOCUMENT WE AUTHORIZED (audit v800). The editable check ran against
  // quoteId, but the update matched on itemId ALONE — so a caller (Nort included) could pass a
  // draft's id to pass the lock and an itemId belonging to a DIFFERENT quote, and rewrite a line
  // on an accepted, already-billed document. Zero rows is now an error, not a quiet success.
  const { data: touched, error } = await supabase
    .from("quote_line_items")
    .update(clean)
    .eq("id", itemId)
    .eq("quote_id", quoteId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!touched?.length) return { ok: false, error: "That line isn't on this estimate." };
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
  const editable = await requireEditableQuote(supabase, quoteId);
  if (!editable.ok) return editable;
  // Same scoping law as updateQuoteItem (audit v800): the delete must belong to the document
  // the editable check authorized, and a zero-row delete is a failure, not a success.
  const { data: gone, error } = await supabase
    .from("quote_line_items")
    .delete()
    .eq("id", itemId)
    .eq("quote_id", quoteId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length) return { ok: false, error: "That line isn't on this estimate." };
  await recalcQuote(supabase, quoteId);
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

/** Edit quote header fields: title, notes, tax rate (fraction), valid-until.
 *  PATCH semantics (mirrors updateBill): only the keys the caller sent are written —
 *  an omitted field never touches its column. An explicit "" / null clears. */
export async function updateQuoteMeta(
  quoteId: string,
  meta: { title?: string; description?: string; notes?: string; tax_rate?: number; valid_until?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const clean: Record<string, unknown> = {};
  if (meta.title !== undefined) clean.title = meta.title.trim() || null;
  if (meta.description !== undefined) clean.description = meta.description.trim() || null;
  if (meta.notes !== undefined) clean.notes = meta.notes.trim() || null;
  if (meta.tax_rate !== undefined) clean.tax_rate = meta.tax_rate || 0;
  if (meta.valid_until !== undefined) clean.valid_until = meta.valid_until;
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };
  // Only the tax rate moves `total` (through recalcQuote) — so only a tax-rate change on a
  // drawn contract trips the accepted-lock. Re-titling or re-noting an accepted quote is
  // harmless and stays allowed.
  if (meta.tax_rate !== undefined) {
    const editable = await requireEditableQuote(supabase, quoteId);
    if (!editable.ok) return editable;
  }
  const { error } = await supabase
    .from("quotes")
    .update(clean)
    .eq("id", quoteId);
  if (error) return { ok: false, error: dbError(error) };
  await recalcQuote(supabase, quoteId);
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

/**
 * Change a saved quote's customer. Mirrors the visibleJobIdOrNull guard:
 * a customerId the caller's RLS-scoped client can't see resolves to null,
 * so a crafted/foreign id can never persist as a cross-org dangling FK.
 */
export async function setQuoteCustomer(
  quoteId: string,
  customerId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  let safeCustomerId: string | null = null;
  if (customerId) {
    safeCustomerId = await visibleCustomerIdOrNull(supabase, customerId);
    if (!safeCustomerId) return { ok: false, error: "That customer isn't available." };
  }

  const { error } = await supabase
    .from("quotes")
    .update({ customer_id: safeCustomerId, updated_at: new Date().toISOString() })
    .eq("id", quoteId);
  if (error) return { ok: false, error: dbError(error) };
  await bustDocPdf("quote", quoteId); // bill-to renders on the PDF (audit 7)
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  return { ok: true };
}

/**
 * Pin a saved quote to a job (or null to unpin) — "leave the estimate with the job".
 * Same RLS-visibility guard as setQuoteCustomer: a job id the caller can't see is
 * rejected, so a crafted/foreign id can never persist as a cross-org dangling FK.
 */
export async function setQuoteJob(
  quoteId: string,
  jobId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  if (jobId) {
    const { data } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
    if (!data) return { ok: false, error: "That job isn't available." };
  }

  const { error } = await supabase
    .from("quotes")
    .update({ job_id: jobId, updated_at: new Date().toISOString() })
    .eq("id", quoteId);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

/**
 * Agent dedupe guard: a recent DRAFT with the same title for the same (or an
 * unattached) customer is the same document being saved twice — one Nort
 * conversation minted E-009/E-010/E-011 for one estimate this way. Returns the
 * existing draft so quote.create can refuse and steer to editing it instead.
 */
export async function findRecentDraftQuote(
  customerId: string | null,
  title: string,
): Promise<{ id: string; quote_number: string | null; title: string | null } | null> {
  const ctx = await requireStaff();
  if ("error" in ctx) return null;
  const norm = title.trim().toLowerCase();
  if (!norm) return null;
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data } = await ctx.supabase
    .from("quotes")
    .select("id, quote_number, title, customer_id")
    .eq("status", "draft")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(25);
  const hit = (data ?? []).find(
    (q) =>
      (q.title ?? "").trim().toLowerCase() === norm &&
      (customerId == null || q.customer_id == null || q.customer_id === customerId),
  );
  return hit ? { id: hit.id, quote_number: hit.quote_number, title: hit.title } : null;
}

export async function deleteQuote(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // THE STAMP FOLLOWS THE DEED, IN REVERSE (review of cn-v796): autosave stamps a lead
  // 'quoted' the moment a draft exists — so deleting that draft must un-stamp it when no
  // other quote remains, or the lead leaves the inbox pointing at nothing (the exact
  // Andrew-orphan class the stamp was moved to prevent).
  const { data: victim } = await supabase.from("quotes").select("id, inquiry_id").eq("id", id).maybeSingle();
  const { error } = await supabase.from("quotes").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  if (victim?.inquiry_id) {
    // BOTH deeds, not just this one (v800 wave B caught my own v801 regression): widening the
    // un-stamp to every converted_to value meant deleting a lead's QUOTE reopened it even when
    // the JOB born from that lead was alive and well — stamp-follows-deed, inverted.
    const [{ count }, { count: jobsLeft }] = await Promise.all([
      supabase.from("quotes").select("id", { count: "exact", head: true }).eq("inquiry_id", victim.inquiry_id),
      supabase.from("jobs").select("id", { count: "exact", head: true }).eq("inquiry_id", victim.inquiry_id),
    ]);
    if (!count && !jobsLeft) {
      await supabase
        .from("inquiries")
        // "new", not "open": INQUIRY_STATUSES is new/contacted/quoted/won/lost, and a lead
        // released back to the inbox is a fresh one again. "open" is not in that vocabulary and
        // rendered as an unknown chip (v800 verification).
        .update({ converted_to: null, converted_at: null, status: "new", updated_at: new Date().toISOString() })
        .eq("id", victim.inquiry_id)
        // NOT .eq("converted_to","quote"): convertInquiry writes 'estimate' or 'job', so that
        // filter silently skipped the very rows this un-stamp exists for (audit v800).
        .not("converted_at", "is", null);
      revalidatePath("/leads");
    }
  }
  revalidatePath("/quotes");
  return { ok: true };
}

/**
 * Duplicate-draft cleanup: keep one draft, delete the losers in one tap.
 * Erik: "made many copies then not being able to correct them, merge them or
 * delete them." A draft carries no children (no job/invoice/WO re-point needed),
 * so "merge" here IS keep-one-delete-the-rest. Guards hard before deleting:
 * every id (keep + losers) must resolve — under RLS scoping — to a DRAFT of the
 * SAME customer, so a stray non-draft or foreign-org row can never be swept up.
 */
export async function resolveDuplicateDrafts(
  keepId: string,
  deleteIds: string[],
): Promise<{ ok: boolean; error?: string; deleted?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const losers = deleteIds.filter((id) => id && id !== keepId);
  if (losers.length === 0) return { ok: false, error: "Nothing to delete." };

  // Fetch the whole cluster (keep + losers) under RLS — foreign rows drop out.
  const ids = [keepId, ...losers];
  const { data: rows, error: readErr } = await supabase
    .from("quotes")
    .select("id, status, customer_id")
    .in("id", ids);
  if (readErr) return { ok: false, error: readErr.message };

  const found = rows ?? [];
  // Every id must have resolved (RLS didn't hide any) — else refuse the batch.
  if (found.length !== ids.length)
    return { ok: false, error: "One of these drafts isn't available." };
  // All must be drafts — never delete a sent/accepted quote through this path.
  if (found.some((r) => r.status !== "draft"))
    return { ok: false, error: "Only draft estimates can be cleaned up here." };
  // All must share the keep's customer — the dedupe signal we grouped on.
  const keepRow = found.find((r) => r.id === keepId);
  if (!keepRow) return { ok: false, error: "That draft isn't available." };
  if (found.some((r) => (r.customer_id ?? null) !== (keepRow.customer_id ?? null)))
    return { ok: false, error: "These drafts belong to different customers." };

  const { error } = await supabase.from("quotes").delete().in("id", losers);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/quotes");
  return { ok: true, deleted: losers.length };
}

export async function saveQuote(input: SaveQuoteInput) {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const supabase = ctx.supabase;

  const { subtotal, tax, total } = subtotalTaxTotal(
    input.items.map((i) => i.quantity * i.unit_price),
    input.tax_rate || 0,
  );

  // Defense-in-depth: only stamp inquiry_id if it resolves to a lead THIS caller can see (the
  // select is RLS-bound, so a foreign-org id resolves to null). The FK check itself bypasses RLS,
  // so without this a hand-crafted server-action POST could plant a cross-org pointer. Cheap —
  // only runs on the rare lead-seeded quote (input.inquiry_id is otherwise null).
  let inquiryId = input.inquiry_id || null;
  if (inquiryId) {
    const { data: inq } = await supabase.from("inquiries").select("id").eq("id", inquiryId).maybeSingle();
    if (!inq) inquiryId = null;
  }

  const fields = {
    customer_id: input.customer_id,
    job_id: input.job_id || null,
    inquiry_id: inquiryId,
    title: input.title || null,
    description: input.description || null,
    notes: input.notes || null,
    tax_rate: input.tax_rate || 0,
    subtotal,
    tax,
    total,
    valid_until: input.valid_until,
    // The builder's Estimate|Quote toggle; absent (Nort, duplicates of old rows) = Estimate (T&M).
    doc_type: input.doc_type === "quote" ? "quote" : "estimate",
  };
  let quote: { id: string; quote_number?: string | null } | null = null;
  let updateItemsDone = false;
  if (input.id) {
    // AUTOSAVE UPDATE — one TRANSACTION via save_quote_draft (0211): row-locked,
    // draft-locked, header + wholesale line replace atomically. The old three-REST-call
    // shape let two writers interleave into doubled lines under a single-set total, and a
    // failed insert left a zero-line draft (review of cn-v796, 3 confirmed HIGHs).
    const { data: rpc, error: rpcErr } = await supabase.rpc("save_quote_draft", {
      p_id: input.id,
      p_fields: { ...fields, subtotal, tax, total },
      p_items: input.items.map((it, idx) => ({
        description: it.description,
        quantity: it.quantity,
        unit: it.unit || "ea",
        unit_price: it.unit_price,
        category: it.group ?? null,
        sort_order: idx,
      })),
    });
    if (rpcErr) {
      const msg = rpcErr.message ?? "";
      if (msg.includes("QUOTE_NOT_DRAFT")) {
        // Sent/accepted: the builder must stop and say so — never rewrite a live document.
        return { ok: false as const, code: "not_editable" as const, error: "That draft was sent — it can't be edited from the builder anymore." };
      }
      if (msg.includes("EMPTY_REPLACE")) {
        return {
          ok: false as const,
          code: "empty_replace" as const,
          error: "Refused: this would wipe the draft's line items. Reload the estimate to pick up its saved lines, or delete the draft if you meant to start over.",
        };
      }
      if (msg.includes("QUOTE_GONE")) {
        // Deleted (or never ours): fall through and mint a fresh draft — a stale restored
        // quoteId must not brick the session (review: "permanent no-save black hole").
      } else {
        return { ok: false as const, error: dbError(rpcErr) };
      }
    } else {
      const row = Array.isArray(rpc) ? rpc[0] : rpc;
      quote = row as { id: string; quote_number?: string | null };
      updateItemsDone = true;
    }
  }
  if (!quote) {
    const { data: ins, error } = await supabase
      .from("quotes")
      .insert({ ...fields, created_by: ctx.userId })
      // quote_number is stamped by the BEFORE-INSERT trigger (0004 next_doc_number),
      // so insert-returning carries the real document number.
      .select("id, quote_number")
      .single();
    if (error) return { ok: false as const, error: dbError(error) };
    quote = ins as { id: string; quote_number?: string | null };
  }
  if (!quote) return { ok: false as const, error: "The save didn't land." };

  if (input.items.length && !updateItemsDone) {
    const rows = input.items.map((it, idx) => ({
      quote_id: quote.id,
      description: it.description,
      quantity: it.quantity,
      unit: it.unit || "ea",
      unit_price: it.unit_price,
      // The scope group (Framing, Decking, Electrical…) — persists the grouped-view groups
      // so they survive a save/reload, and forms the estimate's per-category budget buckets.
      category: it.group ?? null,
      sort_order: idx,
    }));
    const { error: itemsErr } = await supabase
      .from("quote_line_items")
      .insert(rows);
    if (itemsErr) return { ok: false as const, error: itemsErr.message };
  }

  // No auto follow-up task here: the "awaiting reply" inbox item on My Day IS
  // the follow-up, and it self-clears when the quote is answered — one intent,
  // one surface (the old per-quote task factory just piled up orphans).

  // Write-up backlink: stamp the new quote's id onto the source inspection's capture jsonb
  // so /inspections can file the row (the lead-less Inspect-now path has no inquiry/job link).
  // RLS-scoped read → a bad/cross-org id is a clean no-op; best-effort, never fails the save.
  if (input.capture_appointment_id) {
    const { data: appt } = await supabase
      .from("appointments")
      .select("id, capture")
      .eq("id", input.capture_appointment_id)
      .maybeSingle();
    if (appt) {
      const existing =
        appt.capture && typeof appt.capture === "object" ? (appt.capture as Record<string, unknown>) : {};
      // Stamp ONCE: autosave calls this every ~2s — a read-modify-write of the capture jsonb
      // on every tick would clobber concurrent inspector writes (review) and churn revalidates.
      if (existing.quote_id !== quote.id) {
        await supabase
          .from("appointments")
          .update({ capture: { ...existing, quote_id: quote.id }, updated_at: new Date().toISOString() })
          .eq("id", appt.id);
        revalidatePath("/inspections");
      }
    }
  }

  // THE DEED STAMPS THE RECORD (Andrew's orphaned lead). Converting a lead to a BLANK builder
  // used to stamp it 'quoted' at click time — abandon the builder and the lead left the inbox
  // with no quote existing, taking its intake attachments with it. The lead now converts at the
  // moment an estimate for it actually lands, whichever door built it (seeded conversion, blank
  // builder, walk-through write-up). `.is(converted_at, null)` keeps it first-deed-only: the
  // zero-row update on an already-converted lead is the intended no-op, not a silent failure.
  if (inquiryId) {
    await supabase
      .from("inquiries")
      .update({
        converted_to: "quote",
        converted_at: new Date().toISOString(),
        status: "quoted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", inquiryId)
      .is("converted_at", null);
    // The customer link attaches separately, attach-once — the first-deed-only stamp used to
    // carry it, so a customer picked AFTER the first autosave never reached the lead (review).
    if (input.customer_id) {
      await supabase
        .from("inquiries")
        .update({ customer_id: input.customer_id, updated_at: new Date().toISOString() })
        .eq("id", inquiryId)
        .is("customer_id", null);
    }
    revalidatePath("/leads");
  }

  revalidatePath("/quotes");
  // Return the SAVED money figures (the subtotalTaxTotal rollup that was written) +
  // the trigger-assigned number, so every caller — Nort's quote.create especially —
  // reads the real total back instead of re-deriving it. The announce-vs-save drift:
  // Nort told Erik "~$2,560" then saved E-014 at $2,620, because the announced figure
  // was mental math over the lines while THIS function computed the persisted total.
  return {
    ok: true as const,
    id: quote.id,
    quote_number: (quote as { quote_number?: string }).quote_number ?? null,
    subtotal,
    tax,
    total,
  };
}

/**
 * Clone a quote (header fields + all line items) into a fresh draft titled
 * "… (copy)". Reuses the existing saveQuote insert path so totals and
 * revalidation all behave exactly like a new estimate.
 * RLS-scoped reads mean a foreign-org quote resolves to nothing here.
 */
export async function duplicateQuote(
  id: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: quote } = await supabase
    .from("quotes")
    .select("customer_id, title, notes, tax_rate, valid_until, doc_type")
    .eq("id", id)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found." };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("description, quantity, unit, unit_price, category")
    .eq("quote_id", id)
    .order("sort_order");

  const res = await saveQuote({
    customer_id: quote.customer_id ?? null,
    job_id: null, // a copy stands on its own — it isn't tied to the original's job
    title: `${quote.title ?? "Quote"} (copy)`,
    notes: quote.notes ?? "",
    tax_rate: Number(quote.tax_rate) || 0,
    valid_until: quote.valid_until ?? null,
    // A copy keeps the customer-facing word — a fixed-price Quote doesn't revert to Estimate.
    doc_type: quote.doc_type === "quote" ? "quote" : "estimate",
    items: (items ?? []).map((it: any) => ({
      description: it.description,
      quantity: Number(it.quantity) || 1,
      unit: it.unit || "ea",
      unit_price: Number(it.unit_price) || 0,
      group: it.category ?? undefined, // keep the scope group on a duplicate
    })),
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, id: res.id };
}

/**
 * The moment a deferred-customer estimate is WON, materialize its Contact — Erik's flow: a lead
 * becomes a saved customer only on approval. If the quote already has a customer, this is a no-op.
 * Otherwise, from the linked inquiry we CROSSCHECK the existing book (same phone/email/name → link
 * that customer, never duplicate — the "naturally Nort should pick that up" ask) and only create a
 * fresh Contact when the person is genuinely new. Auto-filled from the inquiry. Returns the resolved
 * customer id (or null if there's nothing to materialize from). RLS-scoped via the passed client.
 */
async function materializeQuoteCustomer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  q: { id: string; customer_id: string | null; inquiry_id: string | null },
  userId: string,
): Promise<string | null> {
  if (q.customer_id) return q.customer_id; // already has a contact
  if (!q.inquiry_id) return null; // standalone estimate, nothing to materialize from

  const { data: inq } = await supabase.from("inquiries").select("*").eq("id", q.inquiry_id).maybeSingle();
  if (!inq) return null;

  // Crosscheck the book first — link an existing customer if this lead is already one (same
  // phone / email / normalized name), using the exact keys the CRM's duplicate finder uses.
  const { data: book } = await supabase
    .from("customers")
    .select("id, name, company_name, email, phone");
  let customerId = findMatchingCustomerId(
    { name: inq.name, email: inq.email, phone: inq.phone },
    (book ?? []) as DupCustomer[],
  );

  if (!customerId) {
    // Genuinely new → auto-fill a Contact from the estimate's lead.
    const { data: cust, error: cErr } = await supabase
      .from("customers")
      .insert({
        name: inq.name,
        company_name: inq.company_name,
        type: inq.type ?? "residential",
        status: "active", // a won estimate = a real, active customer
        email: inq.email,
        phone: inq.phone,
        // WHERE THE PERSON IS, not where the work is (audit 6). `inq.address` is THE SITE — 0189
        // said so out loud — and writing it here made a lead who lives at 12 Elm St into a
        // customer who lives on the bare lot they are building on. customerAddressFrom is the one
        // rule, shared with the lead-conversion path and with the SQL twin in migration 0192, so
        // the three cannot drift into disagreeing about which address a customer record holds.
        ...customerAddressFrom(inq),
        notes: inq.message ? `From inquiry: ${inq.message}` : inq.notes,
        created_by: userId,
      })
      .select("id")
      .single();
    if (cErr || !cust) return null; // best-effort: the job still gets created customer-less
    customerId = cust.id;
  }

  await supabase.from("quotes").update({ customer_id: customerId }).eq("id", q.id);
  // Stamp the lead as won + attach the contact (idempotent — leaves the open leads list either way).
  await supabase
    .from("inquiries")
    .update({ customer_id: customerId, status: "won", converted_at: inq.converted_at ?? new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", q.inquiry_id);
  return customerId;
}

export async function createJobFromQuote(
  quoteId: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: q } = await supabase
    .from("quotes")
    // address/city/state/zip (0177) so the job can inherit the site typed on the ESTIMATE. A
    // column you don't select is a column you can't inherit — the specific way the address kept
    // dying at every stage, and it is a `select` list every time, never a missing column.
    .select("id, job_id, customer_id, title, quote_number, inquiry_id, address, city, state, zip")
    .eq("id", quoteId)
    .maybeSingle();
  if (!q) return { ok: false, error: "Quote not found." };
  if (q.job_id) return { ok: true, id: q.job_id };

  // Deferred-customer estimate won → create/link the Contact now, before the job (so the job gets it).
  const resolvedCustomerId = await materializeQuoteCustomer(supabase, q, ctx.userId);

  /**
   * THE JOB INHERITS ITS ADDRESS. It used to be born with none — this insert named five fields and
   * address was not one of them, even though materializeQuoteCustomer had just run one line above
   * holding the customer's full address. Thirteen of twenty jobs in production have a NULL city.
   *
   * Erik: "nothing collected the pertinent initial data like address which names the everything
   * from lead to invoice." This is the far end of that: the address is captured properly exactly
   * once, on the lead, and then every stage downstream re-derives it or does without.
   *
   * ORDER MATTERS — most specific first. The LEAD's address is the one somebody typed about THIS
   * job (and it is Places-resolved into four real columns). The customer's is their address on
   * file, which for a landlord or a property manager is very often not where the work is. Falling
   * back to it is right; preferring it would be how a crew gets sent to the wrong house.
   */
  const inheritedAddress = await (async () => {
    // THE ESTIMATE'S OWN SITE ADDRESS WINS. 0177 gave quotes the four columns; this function was
    // written one migration earlier and still started at the lead, so an address typed on the
    // ESTIMATE would have been silently outranked by the lead's older one. Nothing writes
    // quotes.address yet, which is the only reason it isn't already a live bug — and exactly why
    // it is worth closing before the field appears on the form rather than after.
    //
    // Precedence is most-specific-first throughout: the estimate is about THIS job, the lead was
    // about this job, the customer is a person who may own several buildings.
    if (q.address) return { address: q.address, city: q.city, state: q.state, zip: q.zip };
    if (q.inquiry_id) {
      const { data: inq } = await supabase
        .from("inquiries")
        .select("address, city, state, zip")
        .eq("id", q.inquiry_id)
        .maybeSingle();
      if (inq?.address) return inq;
    }
    const custId = resolvedCustomerId ?? q.customer_id;
    if (custId) {
      const { data: cust } = await supabase
        .from("customers")
        .select("address, city, state, zip")
        .eq("id", custId)
        .maybeSingle();
      if (cust?.address) return cust;
    }
    return null;
  })();

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      customer_id: resolvedCustomerId ?? q.customer_id,
      inquiry_id: q.inquiry_id ?? null, // carry the lead provenance forward: lead → quote → job
      name: q.title || `Job from ${q.quote_number}`,
      ...(inheritedAddress
        ? {
            address: inheritedAddress.address,
            city: inheritedAddress.city,
            state: inheritedAddress.state,
            zip: inheritedAddress.zip,
          }
        : {}),
      // Born to_be_scheduled (lifecycle rework): the estimate is won but no dates exist yet —
      // the schedule promotion (advanceToScheduled) flips it to scheduled when a date lands.
      // The public accept path (accept_public_quote, migration 0127) does the same.
      status: "to_be_scheduled",
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

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

/**
 * Fire-and-forget: push the office that an estimate was accepted. Deep-links to the
 * JOB (schedule it right there) when one exists. The in-app My Day "Accepted — schedule
 * it" feeder is the always-works fallback for when push is off. Never throws.
 */
async function pushQuoteAccepted(id: string): Promise<void> {
  try {
    const sb = createServiceClient();
    const { data: q } = await sb
      .from("quotes")
      .select("quote_number, org_id, job_id, customers(name)")
      .eq("id", id)
      .maybeSingle();
    if (!q?.org_id) return;
    const name = (q as { customers?: { name?: string } }).customers?.name;
    const staff = await orgStaffIds(q.org_id);
    const payload = {
      title: "Estimate accepted",
      body: `${q.quote_number || "An estimate"} was accepted${name ? ` by ${name}` : ""} — schedule the job.`,
      url: q.job_id ? `/jobs/${q.job_id}` : "/quotes",
    };
    await createNotifications(q.org_id, staff, { type: "quote_accepted", ...payload }); // the bell — always works
    await sendPushToProfiles(staff, "quote_accepted", payload); // + push if the recipient enabled it
  } catch {
    /* best-effort */
  }
}

export async function updateQuoteStatus(id: string, status: string) {
  if (!(QUOTE_STATUSES as readonly string[]).includes(status))
    return { ok: false as const, error: `Status must be one of: ${QUOTE_STATUSES.join(", ")}.` };
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false as const, error: ctx.error };
  const supabase = ctx.supabase;

  // Acceptance is the moment work is won. The office "Accepted" dropdown used to just
  // flip the status — no job, no signal — so an accepted estimate vanished (the bug Erik
  // hit). Now it stamps accepted_at, ensures the job exists + linked (idempotent), and
  // alerts the office in-app (the My Day feeder catches status='accepted') AND by push.
  const patch: Record<string, unknown> =
    status === "accepted" ? { status, accepted_at: new Date().toISOString() } : { status };
  const { error } = await supabase.from("quotes").update(patch).eq("id", id);
  if (error) return { ok: false as const, error: dbError(error) };

  /**
   * ONE DECISION, RECORDED WHEREVER IT IS MADE (Erik, 8/19: "it would be the one in the same
   * with the estimate acceptance").
   *
   * The walk-through behind this estimate is asking the same question the status dropdown just
   * answered — so answer it there too (0205). Best-effort: the estimate's own status is the
   * fact that matters, and a missing appointment link must never fail the save.
   */
  try {
    const outcome = status === "accepted" ? "won" : status === "declined" || status === "expired" ? "lost" : null;
    if (outcome) {
      const { data: q } = await supabase.from("quotes").select("inquiry_id, job_id").eq("id", id).maybeSingle();
      const links = q as { inquiry_id?: string | null; job_id?: string | null } | null;
      if (links?.inquiry_id || links?.job_id) {
        let upd = supabase.from("appointments").update({ outcome, outcome_at: new Date().toISOString() }).is("outcome", null);
        upd = links.inquiry_id && links.job_id
          ? upd.or(`inquiry_id.eq.${links.inquiry_id},job_id.eq.${links.job_id}`)
          : links.inquiry_id
            ? upd.eq("inquiry_id", links.inquiry_id)
            : upd.eq("job_id", links.job_id as string);
        await upd;
      }
    }
  } catch {
    /* the estimate's status is the decision; stamping the visit is a courtesy */
  }

  if (status === "accepted") {
    await createJobFromQuote(id).catch(() => {}); // links quotes.job_id + spins up WO/materials
    await pushQuoteAccepted(id);
    revalidatePath("/planner"); // so the "Accepted — schedule it" item shows immediately
    revalidatePath("/schedule");
  }
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/quotes");
  return { ok: true as const };
}

/**
 * The estimator CORE. Takes the Anthropic user `content` — a free-text scope OR a PDF plan document
 * (+ instruction) — and returns priced line items + review questions from the org's OWN price book
 * (single source of truth, never web prices). Book items carry a "[CODE]" catalog tag (so the CED
 * order sheet resolves them); anything not in the book is flagged with a Home Depot estimate.
 * `markupPct` and `laborRate` come from the customer's pricing level; material sell resolves per
 * item through THE one markup rule (effectiveMarkupPct: level → item markup > 0 → org
 * default_markup_pct → 0), and labor $/hr falls back to the org default rate.
 */
async function runEstimator(
  content: any,
  markupPct?: number,
  laborRate?: number,
): Promise<{ items: DraftLineItem[]; questions: string[]; description: string }> {
  const supabase = await createClient();
  const [{ data: org }, { data: book }] = await Promise.all([
    supabase.from("organizations").select("id, settings").limit(1).maybeSingle(),
    supabase
      .from("price_list_items")
      .select("code, description, buy_price, markup_pct, unit, category")
      .eq("archived", false),
  ]);
  const orgS = getOrgSettings((org as any)?.settings);
  const playbook = orgS.quote_playbook?.trim();
  const rate = laborRate != null && laborRate > 0 ? laborRate : orgS.default_labor_rate;
  // A RATE HE TYPED. `content` is his scope on the text path and a content-block array on the plan
  // path; only the text he wrote is searched, never a PDF's contents — a number lifted out of
  // somebody else's drawing is not his instruction.
  const stated = statedLaborRate(
    typeof content === "string"
      ? content
      : (Array.isArray(content) ? content : [])
          .filter((b: { type?: string }) => b?.type === "text")
          .map((b: { text?: string }) => String(b.text ?? ""))
          .join("\n"),
  );

  const rows = (book ?? []) as any[];
  const catalog = rows
    .map((b) => `${b.code ?? "-"} | ${b.description} | ${b.unit} | $${Number(b.buy_price).toFixed(2)}${b.category ? " | " + b.category : ""}`)
    .join("\n");
  const byCode = new Map(rows.filter((b) => b.code).map((b) => [String(b.code).toUpperCase(), b]));

  // TRADE-NEUTRAL. This prompt opened "You are an estimator for an electrical contractor"
  // and ordered NEC calculations — so when Chris finished a DECK inspection and tapped
  // estimate, his deck was priced by an electrician who was told to size conduit. The org's
  // estimating_mode already distinguishes a catalog shop (bids from its own price book) from
  // a research shop (web-priced + trade calcs); the chat route has branched on it since
  // cn-v80. runEstimator never did.
  const catalogMode = orgS.estimating_mode === "catalog";
  const trade = orgS.trade_label?.trim() || "contractor";

  const client = getAnthropic();
  const system: Anthropic.MessageCreateParams["system"] = [
      {
        type: "text" as const,
        text:
          `You are an estimator for a ${trade}. Draft quote line items for the scope, pricing materials from the contractor's OWN PRICE BOOK (their real net cost) — never invent market prices. ` +
          `LABOR: ${stated ? `$${stated}/hr — HE STATED THIS RATE IN THE SCOPE, use it` : rate > 0 ? `$${rate}/hr` : "a realistic US rate for this trade"}; estimate crew-hours realistically (one or more labor lines). ` +
          "MATERIALS: pick items from the PRICE BOOK below where they fit — return the EXACT catalog code and the book cost. " +
          // THE WIRE NUTS. Erik: "get rid of the wire nuts, that small stuff gets worked into the
          // material ideally grouped together as misc but i dont think its necessary anymore to
          // try and outsmart the contractor — we want to be doing what they need as simple as
          // possible." A dozen $4 rows, each wearing a confirm-this-price badge, buried among the
          // real lines is work he then has to undo by hand.
          //
          // TRADE-NEUTRAL WORDING, deliberately. This whole prompt was rewritten to be trade-blind
          // after it priced Chris's deck as an electrician told to size conduit; naming wire nuts
          // here would put that back one word at a time. Fasteners and adhesives are as true of a
          // deck as connectors are of a panel.
          "CONSUMABLES: never give small hardware its own line — fasteners, connectors, clips, tape, " +
          "adhesives, sealant and the like. Work them into the material line they belong to, or into a " +
          "single 'Misc materials' line if they belong to no one line. " +
          (catalogMode
            ? "QUANTITIES: compute from the measurements given — areas = length × width, linear feet, counts. Do NOT apply trade calculations that don't fit this work. "
            : "QUANTITIES: calculate per the governing code for this trade — don't eyeball. For anything the CALCULATOR TOOLS cover (wire size, voltage drop, conduit fill, box fill) CALL THE TOOL instead of working the tables from memory; they return the exact NEC answer plus the code rule behind it. Reasoning a table in your head is where wrong numbers come from. ") +
          'If a needed material is NOT in the price book, still include it, estimate a typical retail price, and mark source "home_depot". ' +
          'Respond with ONLY a JSON OBJECT: {"description": string, "items": [ ... ], "questions": [ ... ]}. ' +
          // THE SCOPE, POLISHED. Erik: "and the description is the scope polished / by default and
          // editable." He writes a punch list on a ladder — "loose outlet in living room (15 mins)"
          // — and that is the right way to capture it and the wrong way to send it. The same pass
          // that prices the work can tidy the words, because it has already read them. Nothing is
          // invented here: it re-states HIS scope, so a sentence that adds work is a bug.
          '"description" = HIS OWN SCOPE, rewritten as 2-5 sentences a homeowner reads above the ' +
          'line items. Plain, calm, specific about rooms and what gets done. STATE ONLY WHAT HE ' +
          'DESCRIBED — no work he did not list, no hours, no prices, no sales language, no ' +
          'promises about workmanship or timelines. Keep his options as options ("either ... or"). ' +
          'If he wrote nothing to polish, return "". ' +
          'Each entry in "items": {"description": string, "quantity": number, "unit": "ea|ft|hr|lot", "kind": "material"|"labor", "catalog": string|null, "unit_cost": number, "source": "book"|"home_depot"} (labor: kind="labor", source="book", unit_cost=hourly rate). ' +
          // NOTHING WITHOUT DATA — THE SAME LAW THE LINE ITEMS RUN UNDER.
          //
          // Erik, on a real estimate whose questions were otherwise good: "it asked some questions
          // that didnt need to be asked as i stated the basics (feeders are already in place). the
          // MLO question is a good one but its so specific that it will be stated if needed so we
          // shouldnt be trying to make too much up without data just like i didnt mention anything
          // about sheetrock and will if needed."
          //
          // Two failures, one rule. It asked whether the existing feeders were sized for 200A when
          // he had already written that the feed wires are in place — questioning a fact he
          // stated. And it offered to quote drywall patch on a job where nobody had mentioned
          // opening a wall — inventing scope. A contractor who needs drywall in the price says so;
          // silence is not an omission to be helpfully filled, it is an answer.
          //
          // So a question must be ABOUT SOMETHING HE SAID, and it must be a genuine ambiguity in
          // what he said. Not a checklist of what a job like this sometimes involves.
          '"questions" = AT MOST TWO, and usually ZERO. A question is allowed ONLY when his own words are ' +
          'genuinely ambiguous in a way that changes the price — two readings of a count, a quantity he ' +
          'gave without a unit, an option he named without choosing. ' +
          'FORBIDDEN: anything he already stated plainly (do not ask him to confirm a fact he gave you); ' +
          'work he never mentioned (drywall, paint, permits, trenching, disposal — if he wanted it quoted he ' +
          'would have said so); trade options he did not raise; and any restatement of a line item you already ' +
          'returned. Never explain your own pricing. An empty list is the correct answer for a clear scope. ' +
          "No prose outside the JSON." +
          (playbook ? `\n\nCompany notes (apply on top; the price book + calc'd quantities govern):\n${playbook}` : ""),
      },
      {
        // THE PRICE BOOK IS CACHED. It is byte-stable per org between catalog edits and was
        // being re-billed at full input price on every single estimate — and Erik is about to
        // import his real CED net pricing, which multiplies that book several times over.
        // A cache read is ~10% of input, so repeat estimates stop paying for the catalog.
        type: "text" as const,
        text: `PRICE BOOK (code | description | unit | cost${rows.some((b) => b.category) ? " | category" : ""}):\n${catalog || "(price book is empty — estimate retail prices and flag every material)"}`,
        cache_control: { type: "ephemeral" as const },
      },
  ];

  /**
   * THE CALCULATORS ARE NOW REACHABLE. This call passed no `tools` array at all, so the estimator
   * — the one surface whose entire job is producing numbers — worked the NEC tables from memory
   * while four exact, tested calculators sat in the codebase unused. They're pure lookups: no
   * writes, no side effects, nothing to confirm, so the loop can run them without asking.
   *
   * Bounded at 3 rounds. Research-mode estimates need a handful of calls (wire size, then drop on
   * the long run); a bound means a model that gets stuck in a calculation loop still returns an
   * estimate instead of burning the org's shared daily budget. Catalog orgs (deck, carpentry) get
   * no calculators at all — an electrical tool array is noise on a deck bid and costs tokens.
   */
  const tools = catalogMode ? undefined : (CALC_TOOLS as unknown as Anthropic.Tool[]);
  const convo: Anthropic.MessageParam[] = [{ role: "user", content }];
  let msg!: Anthropic.Message;
  const LAST_ROUND = 2;
  for (let round = 0; round <= LAST_ROUND; round++) {
    msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 8192, // headroom: a dense plan take-off can run long — don't truncate mid-JSON
      system,
      // On the FINAL round the tools come off, so the model has no choice but to answer. Otherwise
      // an estimate that spends its whole budget calculating exits the loop mid-tool-call with no
      // text to parse — the contractor gets an error instead of a draft, which is the worst
      // outcome of the three.
      //
      // COSTS A CACHE MISS, knowingly. The tools block sits in front of the price-book cache
      // breakpoint, so dropping it re-bills the whole catalog on the last round of any estimate
      // that called a calculator. `tool_choice: {type: "none"}` would forbid tool use while
      // leaving the prefix intact — the API takes it, but @anthropic-ai/sdk 0.36.3 does not type
      // it, and casting past the SDK on the estimator is not a trade worth making for an
      // optimisation that is invisible on a book this size. Revisit with the SDK bump, BEFORE the
      // CED net pricing import multiplies the catalog.
      ...(tools && round < LAST_ROUND ? { tools } : {}),
      messages: convo,
    });
    // METER EVERY ROUND (0162). This is the single most expensive operation in the product and it
    // was absent from the ledger — you cannot choose a price from a record that omits your biggest
    // cost. Metering only the last round would undercount an estimate that used its calculators.
    void recordAiUsage({
      orgId: (org as { id?: string } | null)?.id,
      model: DEFAULT_MODEL,
      surface: "estimator",
      usage: msg.usage as never,
    });
    const calls = msg.content.filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    if (!calls.length) break;
    convo.push({ role: "assistant", content: msg.content });
    convo.push({
      role: "user",
      content: calls.map((c) => ({
        type: "tool_result" as const,
        tool_use_id: c.id,
        content: runCalc(c.name, c.input),
      })),
    });
  }

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");

  /**
   * THE ANSWER IS READ PROPERLY NOW.
   *
   * This was `JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))` — no fence
   * handling, no trailing-comma scrub, no repair, on the single most expensive operation in the
   * product. One unescaped inch mark in a description (`3/4" EMT`, the everyday vocabulary of this
   * trade) breaks the string and the whole take-off becomes "Estimator failed: Unexpected token".
   * Because the odds of hitting one rise with the SIZE of the take-off, it reads from the outside
   * as the estimator working sometimes and not others.
   *
   * TRUNCATION IS CHECKED FIRST AND NEVER SALVAGED. materials/actions.ts recovers what it can from
   * a cut-off array by trimming to the last complete object; that is right for a shopping list and
   * wrong here. A take-off that quietly loses its last four lines is a wrong PRICE wearing the
   * appearance of a finished one, and nothing on screen would say a line went missing. Say it ran
   * long instead, and let him split the job.
   */
  if (msg.stop_reason === "max_tokens")
    throw new Error("That take-off ran longer than one pass — split the plan, or trim the scope and try again.");
  const parsed = (await parseAiJson(client, text, (org as { id?: string } | null)?.id)) as {
    items?: any[];
    questions?: any[];
    description?: unknown;
  };
  const description = String(parsed.description ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
  const raw = Array.isArray(parsed.items) ? parsed.items : [];
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.map((q) => String(q).trim()).filter(Boolean)
    : [];
  /**
   * THE LADDER RUNS ON EVERY UNRESOLVED LINE, in code. The model returns a catalog code when it
   * recognises one; when it doesn't, it used to hand back an invented `unit_cost` and we took it.
   * But "not in the book" and "didn't think to look" produce identical JSON, and only one of them
   * justifies a guessed price. So every material line without a resolved code now goes through the
   * same book → paid-history ladder the assistant uses, server-side, before anything is priced.
   * Bounded and parallel: a dense plan take-off can return dozens of lines, and this must not turn
   * one estimate into a hundred serial round trips.
   */
  const LADDER_CAP = 30;
  const unresolved = raw
    .filter((i) => i.kind !== "labor")
    .filter((i) => !(i.catalog && byCode.has(String(i.catalog).trim().toUpperCase())))
    .map((i) => String(i.description ?? "").trim())
    .filter(Boolean)
    // NOT THE CATCH-ALL LINE. cn-v716 told the estimator to roll small hardware into one "Misc
    // materials" row, and the ladder promptly word-matched that row to an unrelated $8.03 part and
    // flagged it "check this is the right part before quoting it". There IS no right part: the
    // line is a bag of oddments by construction, so every match it can make is a wrong one. Its
    // own rough number stands, and the est-and-confirm flag says what it is.
    .filter((d) => !/^\s*misc(ellaneous)?\b/i.test(d));
  const uniqueDescs = [...new Set(unresolved.map((d) => d.toLowerCase()))].slice(0, LADDER_CAP);
  const laddered = new Map<string, LadderPrice>();
  await Promise.all(
    uniqueDescs.map(async (d) => {
      try {
        const p = await priceMaterial(supabase as never, {
          description: d,
          levelPct: markupPct ?? null,
          orgDefaultPct: orgS.default_markup_pct,
        });
        // Only a REAL find replaces the model's number. A "none" result means the ladder agrees
        // there's nothing on file, and the model's researched estimate is the best we have.
        if (p.source !== "none") laddered.set(d, p);
      } catch {
        // A lookup failure must never cost the contractor their draft — fall through to the
        // model's number, which is what would have happened anyway.
      }
    }),
  );

  // The per-line pricing rules live in @/lib/estimate/line-map as a PURE function, so the two
  // money bugs that used to hide in this closure (the echoed labor rate, the book-vs-model unit)
  // are covered by tests instead of by review.
  const items: DraftLineItem[] = raw.map((i) =>
    mapEstimatorLine(i, {
      rate,
      statedRate: stated,
      byCode: byCode as Map<string, BookRow>,
      levelPct: markupPct ?? null,
      orgDefaultPct: orgS.default_markup_pct,
      laddered,
    }),
  );
  return { items, questions, description };
}

function estimatorError(e: any) {
  return {
    ok: false as const,
    error: e?.message?.includes("ANTHROPIC_API_KEY")
      ? "Add your ANTHROPIC_API_KEY to enable AI drafting."
      : `Estimator failed: ${e?.message ?? "unknown error"}`,
  };
}

/** The estimator, from a free-text scope. */
/**
 * THE ESTIMATOR GATE (0169 audit, finding F).
 *
 * These two exports were the only ones in this file without `requireStaff()` — all sixteen
 * siblings have it, including the far cheaper generateCircuitSchedule. And /quotes/new has no role
 * check either, so a tech reached the estimator by typing the URL.
 *
 * Each call is the frontier model at max_tokens 8192 for up to three rounds, plus a 20 MB base64
 * PDF on the plan path — this file's own comment calls it "the single most expensive operation in
 * the product." Ungated it was two things at once: direct spend on our API key, and a CROSS-ROLE
 * denial of service, because every round meters into the same ai_usage ledger the chat ceiling
 * reads. One tech in a loop pushes the org past the ceiling and Nort 429s for the owner and the
 * whole office, while the estimator itself never checked that ceiling and kept spending.
 *
 * No data leak, at least: price_list_read is staff-only (0056), so a tech's catalog came back
 * empty and the CED net pricing never reached him.
 */
async function guardEstimator(): Promise<{ ok: true; orgId: string | null } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Only office staff can run the estimator." };
  // Per-user, because the ceiling below is per-ORG and a runaway loop would otherwise burn the
  // whole company's month before anyone noticed.
  if (await rateLimited(`estimator:${ctx.userId}`, 10, 900, { failClosed: true }))
    return { ok: false, error: "That's a lot of estimates in a row — give it a minute." };
  const orgId = await currentOrgId();
  if (await aiSpendExceeded(orgId))
    return { ok: false, error: "Your company has reached this month's AI ceiling. It resets at the start of the month, or the office can raise it." };
  return { ok: true, orgId };
}

export async function generateQuoteDraft(
  scope: string,
  markupPct?: number,
  laborRate?: number,
): Promise<{ ok: true; items: DraftLineItem[]; questions: string[]; description: string } | { ok: false; error: string }> {
  const gate = await guardEstimator();
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!scope.trim()) return { ok: false, error: "Describe the work first." };
  try {
    return { ok: true, ...(await runEstimator(scope, markupPct, laborRate)) };
  } catch (e) {
    return estimatorError(e);
  }
}

/**
 * The estimator, from an uploaded PLAN. Claude reads the PDF natively (legend, schedules, general
 * notes, AND the drawing) and takes it off into the same price-book-priced line items + review
 * questions — a draft you correct, not an auto-bid. FormData carries `file` (the plan PDF), an
 * optional `scope` note (what's already done / excluded / any correction the plan can't show —
 * a plan never says the garage is finished or the panel's already in), and optional `markupPct` +
 * `laborRate` (the selected customer's pricing level — material markup and labor $/hr).
 */
/**
 * A SUPPLIER QUOTE BECOMES LINE ITEMS — transcription, never a take-off.
 *
 * Erik: "I need to upload an estimate from CED so they can be inserted as line items with a mark
 * up." A supplier quote is the opposite document to a plan: the plan needs everything DERIVED
 * (counts, wire sizes, code calcs), the CED quote already IS the answer — descriptions,
 * quantities, and his real net prices, on paper. So the model's only job here is to read it out
 * faithfully. No take-off, no NEC, no inventing lines the paper doesn't carry, and it never
 * touches the price book or the ladder: the net ON THE QUOTE is the buy price, by definition —
 * re-pricing it from history would replace today's quoted number with an older one.
 *
 * THE MARKUP IS APPLIED IN CODE, off the same ladder every other material line uses (customer
 * level → org default), and each line's flag shows the net it came from — so the office can see
 * at a glance what CED charged versus what the customer is asked.
 *
 * Lands in the cn-v716 PROPOSAL list like every other generate: nothing on the estimate until
 * he ticks and adds.
 */

/**
 * THE UPLOAD ARRIVES BY STORAGE, NOT BY REQUEST BODY (#116). Vercel caps any request at
 * ~4.5MB — beneath a single sheet of Andrew's plan sets — so the browser now uploads to the
 * org's own folder in the `documents` bucket (0013 RLS: org members only) and the action gets
 * a PATH. The download below runs on the USER's client, so a crafted cross-org path dies at
 * RLS instead of at a hand-rolled check. The legacy `file` field still works for any open tab
 * from before this shipped.
 */
/**
 * THE CUSTOMER'S OWN PLAN, READ WHERE IT LIVES (Andrew's estimate said "the plan set is attached
 * but I can't open it" — the PDF sat on the LEAD in intake-uploads while the take-off could only
 * read a file re-uploaded from the office's device). This transport hands the estimator that
 * stored file directly: same three checks as intakeFileUrl (RLS-scoped lead read proves
 * membership → the path must sit in that org's intake folder → the lead must actually carry it),
 * then a service download. NO delete-on-read — the stash is a transport, but this file is the
 * customer's record on the lead and must survive every reading.
 */
async function intakePlanUpload(
  formData: FormData,
): Promise<{ ok: true; bytes: ArrayBuffer; size: number; name: string; mime: string } | { ok: false; error: string } | null> {
  const intakePath = String(formData.get("intakePath") ?? "").trim();
  if (!intakePath) return null; // not this transport — fall through to the stash
  const inquiryId = String(formData.get("inquiryId") ?? "").trim();
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Only office staff can run the estimator." };
  const { data: inq } = await ctx.supabase.from("inquiries").select("id, org_id, intake").eq("id", inquiryId).maybeSingle();
  if (!inq) return { ok: false, error: "The lead this plan belongs to wasn't found." };
  const orgId = String((inq as { org_id?: string }).org_id ?? "");
  if (!isOwnIntakePath(orgId, intakePath)) return { ok: false, error: "That file isn't on this lead." };
  const answers = ((inq as { intake?: { intake_answers?: Record<string, unknown> } }).intake?.intake_answers ??
    {}) as Record<string, unknown>;
  const known = Object.values(answers).some((v) => Array.isArray(v) && v.includes(intakePath));
  if (!known) return { ok: false, error: "That file isn't on this lead." };
  const { data: blob } = await createServiceClient().storage.from(INTAKE_BUCKET).download(intakePath);
  if (!blob) return { ok: false, error: "Couldn't read the customer's plan from storage." };
  return {
    ok: true,
    bytes: await blob.arrayBuffer(),
    size: blob.size,
    name: uploadDisplayName(intakePath),
    mime: blob.type || "application/pdf",
  };
}

async function estimatorUpload(formData: FormData): Promise<
  | { ok: true; bytes: ArrayBuffer; size: number; name: string; mime: string }
  | { ok: false; error: string }
> {
  const storagePath = String(formData.get("storagePath") ?? "").trim();
  if (storagePath) {
    const supabase = await createClient();
    const { data: blob, error } = await supabase.storage.from("documents").download(storagePath);
    if (error || !blob) return { ok: false, error: "Couldn't read the uploaded file — try the upload again." };
    // THE STASH IS A TRANSPORT, NOT A LIBRARY (audit 7): delete on read, best-effort — an
    // orphan per estimate would grow the bucket forever, and a CED quote's net pricing must
    // not sit where any org member (field techs included) can list and download it.
    void supabase.storage.from("documents").remove([storagePath]).then(() => undefined, () => undefined);
    return {
      ok: true,
      bytes: await blob.arrayBuffer(),
      size: blob.size,
      name: String(formData.get("fileName") ?? "") || storagePath.split("/").pop() || "upload",
      mime: blob.type || "",
    };
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file to upload." };
  return { ok: true, bytes: await file.arrayBuffer(), size: file.size, name: file.name, mime: file.type };
}

export async function generateQuoteDraftFromSupplier(
  formData: FormData,
): Promise<
  | { ok: true; items: DraftLineItem[]; questions: string[]; description: string; bookReview: BookReview }
  | { ok: false; error: string }
> {
  const gate = await guardEstimator();
  if (!gate.ok) return { ok: false, error: gate.error };
  try {
    const up = await estimatorUpload(formData);
    if (!up.ok) return up;
    if (up.size > 20 * 1024 * 1024) return { ok: false, error: "File is too large (max 20 MB — the reader's ceiling)." };
    const isPdf = up.mime === "application/pdf" || /\.pdf$/i.test(up.name);
    const isText = /csv|text|plain/.test(up.mime) || /\.(csv|txt)$/i.test(up.name);
    if (!isPdf && !isText) return { ok: false, error: "Upload the supplier quote as a PDF or CSV." };

    const mk = formData.get("markupPct");
    const levelPct = mk != null && String(mk) !== "" ? Number(mk) : null;

    const supabase = await createClient();
    const [{ data: org }, { data: bookRows }] = await Promise.all([
      supabase.from("organizations").select("id, settings").limit(1).maybeSingle(),
      // For the price-book review below — read-only here; price_list_read is staff-only (0056),
      // and guardEstimator already required staff.
      supabase.from("price_list_items").select("id, code, description, unit, buy_price").eq("archived", false),
    ]);
    const orgS = getOrgSettings((org as { settings?: unknown } | null)?.settings);

    const instruction =
      "This is a SUPPLIER QUOTE (a materials price quote from a supply house). TRANSCRIBE its line items " +
      "faithfully — do not take off, derive, or add anything that is not printed on it. For each line: " +
      '{"description": string (the supplier\'s wording, plus the part number if printed), "quantity": number, ' +
      '"unit": string (ea/ft/box/roll/lot — as printed, ea if unstated), "unit_cost": number (the NET/each price ' +
      "printed for that line — never the extended total)}. Do not turn subtotal, tax, freight or total rows into items. " +
      'If the quote prints a SALES TAX amount, report it once as "tax_total" (the dollar amount); null if none is printed. ' +
      'Respond with ONLY a JSON object {"items": [...], "tax_total": number|null}. No prose.';

    const content: unknown[] = isPdf
      ? [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(up.bytes).toString("base64") } },
          { type: "text", text: instruction },
        ]
      : [{ type: "text", text: `${instruction}\n\nTHE QUOTE:\n${new TextDecoder().decode(up.bytes).slice(0, 200_000)}` }];

    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: content as never }],
    });
    void recordAiUsage({ orgId: (org as { id?: string } | null)?.id, model: DEFAULT_MODEL, surface: "estimator", usage: msg.usage as never });
    if (msg.stop_reason === "max_tokens")
      return { ok: false, error: "That quote ran longer than one pass — split the file and try again." };
    const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    const parsed = (await parseAiJson(client, text, (org as { id?: string } | null)?.id)) as {
      items?: unknown[];
      tax_total?: unknown;
    };

    // MARKUP IN CODE, provenance on the flag. The transcription is the model's; the money is not.
    //
    // ── AND THE SALES TAX HE PAID IS COST, NOT MARGIN ─────────────────────────────────────────
    // Erik: "we do need to account for the tax somehow, it does get covered in the markup but not
    // sure how it should be done properly." Properly is LANDED COST: the tax CED charges him is as
    // much a part of what the material cost as the freight is, so it folds into the buy price
    // BEFORE markup — spread across the lines in proportion to their value, which is exactly how
    // the supplier computed it. Leaving it "in the markup" means the margin quietly eats ~8%, and
    // for an org billing at 0% markup (Vivian Builders' default) it means literally billing below
    // cost on every taxed line. The flag says when a line carries its tax share, so nothing about
    // the number is a mystery. (An org buying on a resale certificate pays no tax and nothing
    // changes; if one ever wants quoted-tax IGNORED on principle, that's a one-line org setting
    // when they ask.)
    const rawItems = (Array.isArray(parsed.items) ? parsed.items : []).map((raw) => {
      const i = (raw ?? {}) as Record<string, unknown>;
      const qty0 = Number(i.quantity);
      return {
        description: String(i.description ?? "").trim(),
        quantity: Number.isFinite(qty0) && qty0 > 0 ? qty0 : 1,
        unit: String(i.unit ?? "ea").trim() || "ea",
        net: Math.max(0, Number(i.unit_cost) || 0),
      };
    });
    const extended = rawItems.reduce((t, l) => t + l.net * l.quantity, 0);
    const taxTotal = Math.max(0, Number(parsed.tax_total) || 0);
    // Proportional-by-value: a single factor on every net reproduces the supplier's own math.
    const taxFactor = extended > 0 && taxTotal > 0 ? taxTotal / extended : 0;

    const pct = effectiveMarkupPct({ levelPct, itemPct: 0, orgDefaultPct: orgS.default_markup_pct });
    const items: DraftLineItem[] = rawItems
      .map((l) => {
        const landed = l.net * (1 + taxFactor);
        return {
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unit_price: Math.round(landed * (1 + pct / 100) * 100) / 100,
          flag: taxFactor
            ? `supplier net $${l.net.toFixed(2)} + tax share + ${pct}%`
            : `supplier net $${l.net.toFixed(2)} + ${pct}%`,
        };
      })
      .filter((l) => l.description);
    if (!items.length) return { ok: false, error: "Couldn't read any line items off that quote — is it the itemized page?" };

    // THE BOOK REVIEW — read off the PRE-tax nets, because the book stores COST as the supplier
    // states it; the tax share is an estimate-side concern (landed cost), not a catalog fact.
    // Pure matching (lib/pricing/book-review): exact code, then exact normalized description,
    // no fuzzy rung. Everything it proposes is opt-in in the UI; nothing here writes.
    const bookReview = reviewAgainstBook(
      (bookRows ?? []) as never,
      rawItems.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, net: l.net })),
    );
    return { ok: true, items, questions: [], description: "", bookReview };
  } catch (e) {
    return estimatorError(e);
  }
}

export async function generateQuoteDraftFromPlan(
  formData: FormData,
): Promise<{ ok: true; items: DraftLineItem[]; questions: string[]; description: string } | { ok: false; error: string }> {
  // Gate BEFORE the 20 MB file is read and base64'd — an ungated caller shouldn't be able to make
  // the server do that work either.
  const gate = await guardEstimator();
  if (!gate.ok) return { ok: false, error: gate.error };
  try {
    // The lead's stored plan first (intakePath), the office's own upload otherwise.
    const up = (await intakePlanUpload(formData)) ?? (await estimatorUpload(formData));
    if (!up.ok) return { ok: false, error: up.error === "Choose a file to upload." ? "Choose a plan PDF to upload." : up.error };
    if (up.mime !== "application/pdf" && !/\.pdf$/i.test(up.name)) return { ok: false, error: "Upload the plan as a PDF." };
    // Cap at 20 MB: base64 inflates ~33%, and Anthropic's per-request ceiling is 32 MB.
    if (up.size > 20 * 1024 * 1024) return { ok: false, error: "Plan is too large (max 20 MB — the reader's ceiling)." };
    const mk = formData.get("markupPct");
    const markupPct = mk != null && String(mk) !== "" ? Number(mk) : undefined;
    const lr = formData.get("laborRate");
    const laborRate = lr != null && String(lr) !== "" ? Number(lr) : undefined;
    const note = String(formData.get("scope") ?? "").trim();
    const b64 = Buffer.from(up.bytes).toString("base64");
    const content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
      { type: "text", text: planTakeoffInstruction(note) },
    ];
    return { ok: true, ...(await runEstimator(content, markupPct, laborRate)) };
  } catch (e) {
    return estimatorError(e);
  }
}

/**
 * The plan-path instruction, shared by every door that hands the estimator a drawing. TRADE-
 * NEUTRAL, deliberately: this text used to open "Take off this electrical plan … per NEC", which
 * was redundant for Erik (the system prompt already orders code-calculated quantities for his
 * trade) and WRONG the moment Vivian Builders' plans arrived — the same one-word-at-a-time
 * regression the runEstimator prompt was rewritten to prevent. The trade lives in ONE place: the
 * system prompt.
 */
function planTakeoffInstruction(note: string): string {
  return (
    "Take off this plan set into estimate line items. Read the LEGEND, schedules, general notes, AND the drawings themselves; count what the sheets show and calculate quantities per the QUANTITIES rules. Only exclude work the plans explicitly mark as existing/complete. Price per the rules, and in 'questions' list what to review — uncertain counts (say if a sheet is too dense to count reliably), plan callouts that imply extra scope, and owner decisions." +
    // The contractor's note OVERRIDES the drawing. A plan can't show what's already been done
    // or a field decision — so honor exclusions like "garage is finished" or "panel & 2in
    // conduit already in" and DON'T bill that work, even though the drawing still depicts it.
    (note
      ? `\n\nTHE CONTRACTOR ADDED THIS SCOPE NOTE — it OVERRIDES the drawings. Apply it strictly: exclude anything called out as already done/existing, honor stated counts and corrections, and DO NOT bill work the note says is complete even if the plans still show it:\n"""${note}"""`
      : "")
  );
}

/**
 * "GENERATE" READS THE PLANS THE CUSTOMER ALREADY SENT (Andrew: "Still not creating … any line
 * items at all. It acknowledges the plans exist, but nothing further…?"). He was right to expect
 * that: his Generate taps ran the TEXT path, whose prefill NAMES the attached plan set while
 * telling the model it cannot open it — so the model honestly asked for the scope in writing
 * instead of inventing lines. When the linked lead carries plan PDFs, the take-off now reads
 * them: every readable PDF inside the same 20MB budget as every other reading, skips named out
 * loud as a review question, the scope box still overriding the drawings.
 */
export async function generateQuoteDraftFromLeadPlans(
  inquiryId: string,
  scope: string,
  markupPct?: number,
  laborRate?: number,
): Promise<{ ok: true; items: DraftLineItem[]; questions: string[]; description: string } | { ok: false; error: string }> {
  const gate = await guardEstimator();
  if (!gate.ok) return { ok: false, error: gate.error };
  try {
    const ctx = await requireStaff();
    if ("error" in ctx) return { ok: false, error: ctx.error ?? "Only office staff can run the estimator." };
    const { data: inq } = await ctx.supabase.from("inquiries").select("id, org_id, intake").eq("id", inquiryId).maybeSingle();
    if (!inq) return { ok: false, error: "The lead these plans belong to wasn't found." };
    const orgId = String((inq as { org_id?: string }).org_id ?? "");
    const paths = intakePaths((inq as { intake?: unknown }).intake).filter((p) => isOwnIntakePath(orgId, p));
    if (!paths.length) return { ok: false, error: "This lead has no uploaded plans." };

    const svc = createServiceClient();
    const sized: { path: string; bytes: number | null }[] = [];
    for (const p of paths) {
      if (extOf(p) !== "pdf") {
        sized.push({ path: p, bytes: null });
        continue;
      }
      const { data: meta, error } = await svc.storage.from(INTAKE_BUCKET).info(p);
      sized.push({ path: p, bytes: error ? null : Number((meta as { size?: number } | null)?.size ?? 0) });
    }
    const { read, skipped } = pickReadablePlans(sized);
    if (!read.length) return { ok: false, error: "None of the customer's uploads is a readable plan PDF." };

    const docs: any[] = [];
    for (const p of read) {
      const { data: blob } = await svc.storage.from(INTAKE_BUCKET).download(p);
      if (!blob) {
        skipped.push({ name: uploadDisplayName(p), reason: "file no longer in storage" });
        continue;
      }
      docs.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: Buffer.from(await blob.arrayBuffer()).toString("base64") },
      });
    }
    if (!docs.length) return { ok: false, error: "Couldn't read the customer's plans from storage." };

    const content = [...docs, { type: "text", text: planTakeoffInstruction(scope.trim()) }];
    const out = await runEstimator(content, markupPct, laborRate);
    // NO SILENT CAPS: what didn't ride is a review item, not a secret.
    if (skipped.length)
      out.questions = [`Not read: ${skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`, ...out.questions];
    return { ok: true, ...out };
  } catch (e) {
    return estimatorError(e);
  }
}

/**
 * Derive a CIRCUIT SCHEDULE from a saved estimate's line items — the panel layout behind the
 * price (which breaker feeds what, on which wire). Reads the breaker + wire lines to size each
 * circuit and groups loads the way an electrician wires them, then stores it on the quote so it
 * prints as a second page. A draft you correct — the office can edit every row after.
 */
export async function generateCircuitSchedule(
  quoteId: string,
): Promise<{ ok: true; circuits: QuoteCircuit[] } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Not allowed." };
  const supabase = ctx.supabase;

  const { data: quote } = await supabase
    .from("quotes")
    .select("id, title, description, org_id")
    .eq("id", quoteId)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Estimate not found." };
  const { data: items } = await supabase
    .from("quote_line_items")
    .select("description, quantity, unit")
    .eq("quote_id", quoteId)
    .order("sort_order");
  const lines = (items ?? []).map((i: any) => `${i.quantity} ${i.unit ?? ""} · ${i.description}`).join("\n");
  if (!lines.trim()) return { ok: false, error: "Add line items first." };

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 3000,
      system:
        "You are a master electrician laying out a residential branch-circuit (panel) schedule from an estimate's line items. " +
        "Use the BREAKER lines to determine how many circuits and their sizes, and the WIRE lines for conductor sizes. Group loads the way an electrician actually wires them: kitchen small-appliance (two 20A), dishwasher, disposal, refrigerator/freezer, general receptacles, lighting (15A on 14 AWG), bath, laundry/dryer, range, EACH mini-split on its own circuit, bath fan, smoke/CO. Low-voltage (data/Cat6/coax/thermostat/doorbell) is NOT a breaker — leave it out. " +
        'Respond with ONLY a JSON ARRAY, one object per circuit: {"ckt": string, "description": string, "wire": string, "breaker": string, "load": string}. ' +
        'ckt = circuit position ("1","2"…). wire = e.g. "12/2","14/2","10/3","6/3". breaker = e.g. "20A","2P 30A","2P 50A". load = a short note (room/appliance or estimated VA). Number circuits sequentially, matching the breaker counts in the line items. No prose outside the JSON array.',
      messages: [{ role: "user", content: `Estimate: ${quote.title ?? ""}\n${(quote as any).description ?? ""}\n\nLine items:\n${lines}` }],
    });
    void recordAiUsage({ orgId: (quote as { org_id?: string }).org_id, model: DEFAULT_MODEL, surface: "circuit-schedule", usage: msg.usage as never });
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as any[];
    const circuits: QuoteCircuit[] = arr
      .map((r, i) => ({
        ckt: r.ckt != null ? String(r.ckt).trim() : String(i + 1),
        description: String(r.description ?? "").trim(),
        wire: r.wire ? String(r.wire).trim() : null,
        breaker: r.breaker ? String(r.breaker).trim() : null,
        load: r.load ? String(r.load).trim() : null,
      }))
      .filter((r) => r.description);
    const { error } = await supabase.from("quotes").update({ circuits }).eq("id", quoteId);
    if (error) return { ok: false, error: dbError(error) };
    // The circuit schedule renders on the printed quote — regenerating drops the stored copy (audit 7).
    await bustDocPdf("quote", quoteId);
    revalidatePath(`/quotes/${quoteId}`);
    return { ok: true, circuits };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message?.includes("ANTHROPIC_API_KEY")
        ? "Add your ANTHROPIC_API_KEY to enable this."
        : `Circuit schedule failed: ${e?.message ?? "unknown error"}`,
    };
  }
}

/** Save a hand-edited circuit schedule (the office corrects the generated one). Empty → clears it. */
export async function saveCircuitSchedule(
  quoteId: string,
  circuits: QuoteCircuit[],
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const clean = (Array.isArray(circuits) ? circuits : [])
    .map((r) => ({
      ckt: r.ckt ? String(r.ckt).trim() : null,
      description: String(r.description ?? "").trim(),
      wire: r.wire ? String(r.wire).trim() : null,
      breaker: r.breaker ? String(r.breaker).trim() : null,
      load: r.load ? String(r.load).trim() : null,
    }))
    .filter((r) => r.description || r.ckt || r.breaker || r.wire);
  const { error } = await ctx.supabase
    .from("quotes")
    .update({ circuits: clean.length ? clean : null })
    .eq("id", quoteId);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/quotes/${quoteId}`);
  return { ok: true };
}
