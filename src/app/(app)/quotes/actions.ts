"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { createNotifications } from "@/lib/notifications";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import { QUOTE_STATUSES } from "@/lib/statuses";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
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
  revalidatePath(`/quotes/${id}`);
  return { ok: true };
}

/** Re-exported so the existing importers (quote builder, kit picker, deck panel) don't move.
 *  The definition lives with the pricing rules in @/lib/estimate/line-map. */
export type { DraftLineItem } from "@/lib/estimate/line-map";

export interface SaveQuoteInput {
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
  const { data: quote } = await supabase
    .from("quotes")
    .select("tax_rate")
    .eq("id", quoteId)
    .maybeSingle();
  const { data: items } = await supabase
    .from("quote_line_items")
    .select("line_total")
    .eq("quote_id", quoteId);
  const { subtotal, tax, total } = subtotalTaxTotal(
    (items ?? []).map((i: any) => Number(i.line_total ?? 0)),
    Number(quote?.tax_rate ?? 0),
  );
  await supabase
    .from("quotes")
    .update({ subtotal, tax, total })
    .eq("id", quoteId);
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
  const { error } = await supabase
    .from("quote_line_items")
    .update(clean)
    .eq("id", itemId);
  if (error) return { ok: false, error: dbError(error) };
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
  const { error } = await supabase.from("quote_line_items").delete().eq("id", itemId);
  if (error) return { ok: false, error: dbError(error) };
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
  const { error } = await supabase.from("quotes").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
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

  const { data: quote, error } = await supabase
    .from("quotes")
    .insert({
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
      created_by: ctx.userId,
    })
    // quote_number is stamped by the BEFORE-INSERT trigger (0004 next_doc_number),
    // so insert-returning carries the real document number.
    .select("id, quote_number")
    .single();

  if (error) return { ok: false as const, error: dbError(error) };

  if (input.items.length) {
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
      await supabase
        .from("appointments")
        .update({ capture: { ...existing, quote_id: quote.id }, updated_at: new Date().toISOString() })
        .eq("id", appt.id);
      revalidatePath("/inspections");
    }
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
        address: inq.address,
        city: inq.city,
        state: inq.state,
        zip: inq.zip,
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
          `LABOR: ${rate > 0 ? `$${rate}/hr` : "a realistic US rate for this trade"}; estimate crew-hours realistically (one or more labor lines). ` +
          "MATERIALS: pick items from the PRICE BOOK below where they fit — return the EXACT catalog code and the book cost. " +
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
          '"questions" = a short list of plain-English things the contractor should REVIEW before sending: ambiguous counts, callouts that imply EXTRA scope, owner decisions, or anything low-confidence. Be specific. No prose outside the JSON.' +
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

  const objText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(objText) as { items?: any[]; questions?: any[]; description?: unknown };
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
    .filter(Boolean);
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
export async function generateQuoteDraftFromPlan(
  formData: FormData,
): Promise<{ ok: true; items: DraftLineItem[]; questions: string[]; description: string } | { ok: false; error: string }> {
  // Gate BEFORE the 20 MB file is read and base64'd — an ungated caller shouldn't be able to make
  // the server do that work either.
  const gate = await guardEstimator();
  if (!gate.ok) return { ok: false, error: gate.error };
  try {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a plan PDF to upload." };
    if (file.type !== "application/pdf") return { ok: false, error: "Upload the plan as a PDF." };
    // Cap at 20 MB: base64 inflates ~33%, and Anthropic's per-request ceiling is 32 MB.
    if (file.size > 20 * 1024 * 1024) return { ok: false, error: "Plan is too large (max 20 MB)." };
    const mk = formData.get("markupPct");
    const markupPct = mk != null && String(mk) !== "" ? Number(mk) : undefined;
    const lr = formData.get("laborRate");
    const laborRate = lr != null && String(lr) !== "" ? Number(lr) : undefined;
    const note = String(formData.get("scope") ?? "").trim();
    const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
      {
        type: "text",
        text:
          "Take off this electrical plan into estimate line items. Read the LEGEND, schedules, general notes, AND the drawing itself; count every device and calculate quantities per NEC (wire size, box/conduit fill, breaker/feeder, loads). Only exclude work the plan explicitly marks as existing/complete. Price per the rules, and in 'questions' list what to review — uncertain counts (say the drawing is dense), plan callouts that imply extra scope (e.g. data/TV outlets needing a home-run Cat6 to a central data box), and owner decisions." +
          // The contractor's note OVERRIDES the drawing. A plan can't show what's already been done
          // or a field decision — so honor exclusions like "garage is finished" or "panel & 2in
          // conduit already in" and DON'T bill that work, even though the drawing still depicts it.
          (note
            ? `\n\nTHE CONTRACTOR ADDED THIS SCOPE NOTE — it OVERRIDES the drawing. Apply it strictly: exclude anything called out as already done/existing, honor stated counts and corrections, and DO NOT bill work the note says is complete even if the plan still shows it:\n"""${note}"""`
            : ""),
      },
    ];
    return { ok: true, ...(await runEstimator(content, markupPct, laborRate)) };
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
