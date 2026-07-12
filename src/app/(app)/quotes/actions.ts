"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { createNotifications } from "@/lib/notifications";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import { QUOTE_STATUSES } from "@/lib/statuses";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { getOrgSettings, accentHex } from "@/lib/org-settings";
import { sendEmail, renderQuoteNoticeEmail, ownerBcc } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { createWorkOrderFromQuote } from "../work-orders/actions";
import { createMaterialListFromQuote } from "../materials/actions";
import { findMatchingCustomerId, type DupCustomer } from "@/lib/crm/duplicates";

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
    .select("quote_number, total, public_token, doc_type, status, customers(name, phone)")
    .eq("id", id)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found." };
  const customer = (quote as any).customers;
  if (!customer?.phone)
    return { ok: false, error: "This customer has no phone number." };

  const label = ((quote as any).doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote";
  const { data: org } = await supabase.from("organizations").select("name, settings").maybeSingle();
  const link = publicQuoteLink((quote as any).public_token);
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
  const link = publicQuoteLink((quote as any).public_token);
  const label = ((quote as any).doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote";

  const { data: org } = await supabase
    .from("organizations")
    .select("name, phone, email, settings")
    .maybeSingle();

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

export interface DraftLineItem {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  /** Optional group this line belongs to (a kit/"job code group" like Stairs, Decking) — a
   *  build-time organizer so the estimate reads as collapsible groups. Not persisted yet. */
  group?: string;
  /** Set when the estimator priced this line from a FALLBACK (Home Depot / rough estimate) instead
   *  of the price book — surfaced in the builder so you confirm the number. Build-time only. */
  flag?: string;
}

export interface SaveQuoteInput {
  customer_id: string | null;
  job_id?: string | null;
  /** The lead this estimate was seeded from (provenance backlink) — set when a lead is
      converted to a quote; null for quotes started from scratch. */
  inquiry_id?: string | null;
  title: string;
  description?: string | null;
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
  const { error } = await supabase
    .from("quote_line_items")
    .update(clean)
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
  const { error } = await supabase
    .from("quotes")
    .update(clean)
    .eq("id", quoteId);
  if (error) return { ok: false, error: error.message };
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
    const { data } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customerId)
      .maybeSingle();
    if (!data) return { ok: false, error: "That customer isn't available." };
    safeCustomerId = customerId;
  }

  const { error } = await supabase
    .from("quotes")
    .update({ customer_id: safeCustomerId, updated_at: new Date().toISOString() })
    .eq("id", quoteId);
  if (error) return { ok: false, error: error.message };
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
  if (error) return { ok: false, error: error.message };
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
  if (error) return { ok: false, error: error.message };
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
  if (error) return { ok: false, error: error.message };
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

  revalidatePath("/quotes");
  return { ok: true as const, id: quote.id };
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
    .select("customer_id, title, notes, tax_rate, valid_until")
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
    .select("id, job_id, customer_id, title, quote_number, inquiry_id")
    .eq("id", quoteId)
    .maybeSingle();
  if (!q) return { ok: false, error: "Quote not found." };
  if (q.job_id) return { ok: true, id: q.job_id };

  // Deferred-customer estimate won → create/link the Contact now, before the job (so the job gets it).
  const resolvedCustomerId = await materializeQuoteCustomer(supabase, q, ctx.userId);

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      customer_id: resolvedCustomerId ?? q.customer_id,
      inquiry_id: q.inquiry_id ?? null, // carry the lead provenance forward: lead → quote → job
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
  if (error) return { ok: false as const, error: error.message };

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
 * `markupPct` (customer pricing level, else org default) turns cost → sell price.
 */
async function runEstimator(
  content: any,
  markupPct?: number,
): Promise<{ items: DraftLineItem[]; questions: string[] }> {
  const supabase = await createClient();
  const [{ data: org }, { data: book }] = await Promise.all([
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    supabase.from("price_list_items").select("code, description, buy_price, unit, category").eq("archived", false),
  ]);
  const orgS = getOrgSettings((org as any)?.settings);
  const playbook = orgS.quote_playbook?.trim();
  const markup = markupPct != null ? markupPct : orgS.material_markup_percent ?? 0;
  const rate = orgS.default_labor_rate;

  const rows = (book ?? []) as any[];
  const catalog = rows
    .map((b) => `${b.code ?? "-"} | ${b.description} | ${b.unit} | $${Number(b.buy_price).toFixed(2)}${b.category ? " | " + b.category : ""}`)
    .join("\n");
  const byCode = new Map(rows.filter((b) => b.code).map((b) => [String(b.code).toUpperCase(), b]));

  const client = getAnthropic();
  const msg = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 8192, // headroom: a dense plan take-off can run long — don't truncate mid-JSON

    system:
      "You are an estimator for an electrical contractor. Draft quote line items for the scope, pricing materials from the contractor's OWN PRICE BOOK (their real net cost) — never invent market prices. " +
      `LABOR: ${rate > 0 ? `$${rate}/hr` : "a realistic US electrical rate"}; estimate crew-hours realistically (one or more labor lines). ` +
      "MATERIALS: pick items from the PRICE BOOK below where they fit — return the EXACT catalog code and the book cost. Calculate quantities per NEC (wire size, box/conduit fill, breaker/feeder, loads) — don't eyeball. " +
      'If a needed material is NOT in the price book, still include it, estimate a typical HOME DEPOT retail price, and mark source "home_depot". ' +
      'Respond with ONLY a JSON OBJECT: {"items": [ ... ], "questions": [ ... ]}. ' +
      'Each entry in "items": {"description": string, "quantity": number, "unit": "ea|ft|hr|lot", "kind": "material"|"labor", "catalog": string|null, "unit_cost": number, "source": "book"|"home_depot"} (labor: kind="labor", source="book", unit_cost=hourly rate). ' +
      '"questions" = a short list of plain-English things the contractor should REVIEW before sending: ambiguous counts, plan callouts that imply EXTRA scope (e.g. data/TV outlets often need a home-run Cat6 to a central data box — confirm the count and where it feeds), owner decisions (EV location, fixture selection), or anything low-confidence. Be specific. No prose outside the JSON.' +
      (playbook ? `\n\nCompany notes (apply on top; the price book + calc'd quantities govern):\n${playbook}` : "") +
      `\n\nPRICE BOOK (code | description | unit | cost${rows.some((b) => b.category) ? " | category" : ""}):\n${catalog || "(price book is empty — estimate Home Depot prices and flag every material)"}`,
    messages: [{ role: "user", content }],
  });

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");

  const objText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(objText) as { items?: any[]; questions?: any[] };
  const raw = Array.isArray(parsed.items) ? parsed.items : [];
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.map((q) => String(q).trim()).filter(Boolean)
    : [];
  const sell = (cost: number) => Math.round(cost * (1 + markup / 100) * 100) / 100;
  const items: DraftLineItem[] = raw.map((i) => {
    const kind = i.kind === "labor" ? "labor" : "material";
    if (kind === "labor") {
      return {
        description: String(i.description ?? "Labor"),
        quantity: Number(i.quantity) || 1,
        unit: "hr",
        unit_price: Number(i.unit_cost) || rate || 0,
      };
    }
    const cat = i.catalog ? String(i.catalog).trim() : null;
    const pl = cat ? byCode.get(cat.toUpperCase()) : null;
    const cost = pl ? Number(pl.buy_price) : Number(i.unit_cost) || 0;
    const base = String(i.description ?? pl?.description ?? "");
    return {
      description: pl ? `${base} [${pl.code}]` : base, // book items carry [CODE] so the CED order sheet resolves them
      quantity: Number(i.quantity) || 1,
      unit: String(i.unit ?? pl?.unit ?? "ea"),
      unit_price: sell(cost),
      flag: pl ? undefined : "est · Home Depot — confirm",
    };
  });
  return { items, questions };
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
export async function generateQuoteDraft(
  scope: string,
  markupPct?: number,
): Promise<{ ok: true; items: DraftLineItem[]; questions: string[] } | { ok: false; error: string }> {
  if (!scope.trim()) return { ok: false, error: "Describe the work first." };
  try {
    return { ok: true, ...(await runEstimator(scope, markupPct)) };
  } catch (e) {
    return estimatorError(e);
  }
}

/**
 * The estimator, from an uploaded PLAN. Claude reads the PDF natively (legend, schedules, general
 * notes, AND the drawing) and takes it off into the same price-book-priced line items + review
 * questions — a draft you correct, not an auto-bid. FormData carries `file` (the plan PDF), an
 * optional `scope` note (what's already done / excluded / any correction the plan can't show —
 * a plan never says the garage is finished or the panel's already in), and optional `markupPct`
 * (the selected customer's pricing level).
 */
export async function generateQuoteDraftFromPlan(
  formData: FormData,
): Promise<{ ok: true; items: DraftLineItem[]; questions: string[] } | { ok: false; error: string }> {
  try {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a plan PDF to upload." };
    if (file.type !== "application/pdf") return { ok: false, error: "Upload the plan as a PDF." };
    // Cap at 20 MB: base64 inflates ~33%, and Anthropic's per-request ceiling is 32 MB.
    if (file.size > 20 * 1024 * 1024) return { ok: false, error: "Plan is too large (max 20 MB)." };
    const mk = formData.get("markupPct");
    const markupPct = mk != null && String(mk) !== "" ? Number(mk) : undefined;
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
    return { ok: true, ...(await runEstimator(content, markupPct)) };
  } catch (e) {
    return estimatorError(e);
  }
}
