"use server";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { requireStaff } from "@/lib/staff-guard";
import { formatPhone, formatState, formatZip, titleCase } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { PROJECT_TYPES, estimateLinesFromIntake } from "@/lib/lead-triage";
import { saveQuote } from "../quotes/actions";

export type Result = { ok: boolean; error?: string; id?: string; redirect?: string };

function orNull(s: string): string | null {
  const t = s.trim();
  return t.length ? t : null;
}

/** Fields shared by create + update, read from a FormData. */
function inquiryFields(formData: FormData) {
  return {
    company_name: emptyToNull(formData.get("company_name")),
    type: String(formData.get("type") ?? "residential"),
    email: emptyToNull(formData.get("email")),
    phone: orNull(formatPhone(String(formData.get("phone") ?? ""))),
    address: emptyToNull(formData.get("address")),
    city: orNull(titleCase(String(formData.get("city") ?? ""))),
    state: orNull(formatState(String(formData.get("state") ?? ""))),
    zip: orNull(formatZip(String(formData.get("zip") ?? ""))),
    message: emptyToNull(formData.get("message")),
    notes: emptyToNull(formData.get("notes")),
  };
}

export async function createInquiry(formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const fields = inquiryFields(formData);
  // Fragment-first: a bare phone number is a valid lead (the missed-call case) —
  // default the name instead of blocking the capture.
  let name = String(formData.get("name") ?? "").trim();
  if (!name && (fields.phone || fields.message)) name = fields.phone ?? "Unknown caller";
  if (!name) return { ok: false, error: "Add a name, phone, or note to save the lead." };

  const { data, error } = await supabase
    .from("inquiries")
    .insert({ name, ...fields, source: "manual", status: "new", created_by: ctx.userId })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  // A new lead auto-books a follow-up / site-visit appointment (tomorrow 9am) so
  // it lands on the calendar instead of slipping through the cracks.
  const followUp = new Date();
  followUp.setDate(followUp.getDate() + 1);
  followUp.setHours(9, 0, 0, 0);
  await supabase.from("appointments").insert({
    type: "appointment",
    title: `Follow up: ${name}`,
    starts_at: followUp.toISOString(),
    location: fields.address,
    notes: fields.message ?? fields.notes,
    created_by: ctx.userId,
  });

  revalidatePath("/leads");
  revalidatePath("/schedule");
  return { ok: true, id: data.id };
}

export async function updateInquiry(id: string, formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const fields = inquiryFields(formData);
  // Fragment-first: same defaulting as create — a phone-only lead stays editable.
  let name = String(formData.get("name") ?? "").trim();
  if (!name && (fields.phone || fields.message)) name = fields.phone ?? "Unknown caller";
  if (!name) return { ok: false, error: "Add a name, phone, or note to save the lead." };

  const { error } = await supabase
    .from("inquiries")
    .update({ name, ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/leads");
  return { ok: true };
}

/** Log contact now; optionally set/update the next follow-up date. */
export async function markInquiryContacted(id: string, nextFollowUp?: string | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const patch: Record<string, unknown> = {
    last_contacted_at: new Date().toISOString(),
    status: "contacted",
    updated_at: new Date().toISOString(),
  };
  if (nextFollowUp !== undefined) patch.next_follow_up_at = nextFollowUp || null;
  const { error } = await supabase.from("inquiries").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/leads");
  return { ok: true };
}

export async function setInquiryStatus(id: string, status: string): Promise<Result> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("inquiries")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/leads");
  revalidatePath("/planner"); // My Day shows inquiry counts — keep it in sync
  return { ok: true };
}

export async function deleteInquiry(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("inquiries").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/leads");
  return { ok: true };
}

/**
 * Explicitly convert an inquiry. Nothing happens automatically — the caller
 * picks the target AND whether to link an existing customer or create one
 * from the inquiry's details. We stamp the inquiry so it leaves the open list
 * but stays as history.
 */
export async function convertInquiry(
  id: string,
  target: "inspection" | "customer" | "quote" | "estimate" | "job",
  opts: { customerId?: string | null; startDate?: string } = {},
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: inq } = await supabase.from("inquiries").select("*").eq("id", id).maybeSingle();
  if (!inq) return { ok: false, error: "Lead not found." };

  // Idempotency: a lead that's already been converted (customer/quote/estimate/job all stamp
  // converted_at) must not be re-converted, or a SECOND customer + estimate/job would be created.
  // This matters now because the provenance backlink deliberately re-surfaces converted leads on
  // /leads with a live Convert menu — so this is the backstop. Inspection is exempt: it leaves the
  // lead OPEN (converted_at stays null) so an inspected lead can still go on to become an estimate.
  if (inq.converted_at && target !== "inspection") {
    return { ok: false, error: "This lead was already converted — open its customer or estimate instead." };
  }

  // INSPECTION — the pre-sale nerve, parallel to estimate. Books a site inspection onto the
  // Schedule and leaves the lead OPEN (converted_at stays null) so it can still become an
  // estimate afterward. No customer is forced — an inspection happens before the deal is won.
  if (target === "inspection") {
    const startDate = opts.startDate || (() => {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      return d.toISOString().slice(0, 10);
    })();
    const startsAt = new Date(`${startDate}T00:00:00`);
    startsAt.setHours(9, 0, 0, 0); // 9am (matches the follow-up auto-book; movable on the calendar)
    const { error: aErr } = await supabase.from("appointments").insert({
      type: "inspection",
      title: `Site inspection: ${inq.name}`,
      starts_at: startsAt.toISOString(),
      location: inq.address,
      notes: inq.message ?? inq.notes ?? null,
      customer_id: opts.customerId || inq.customer_id || null,
      created_by: ctx.userId,
    });
    if (aErr) return { ok: false, error: aErr.message };
    // Engaged, not closed: mark contacted and resurface the lead around the inspection date.
    await supabase
      .from("inquiries")
      .update({
        status: "contacted",
        last_contacted_at: new Date().toISOString(),
        next_follow_up_at: startDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    revalidatePath("/leads");
    revalidatePath("/schedule");
    revalidatePath("/planner");
    return { ok: true, redirect: `/schedule?view=day&date=${startDate}` };
  }

  // ESTIMATE — the deferred-customer path (Erik's flow: a prospect becomes a saved Contact ONLY when
  // the estimate is ACCEPTED, not when it's drafted). We create NO customer here — the estimate
  // carries inquiry_id, and updateQuoteStatus('accepted') / accept_public_quote materialize the
  // customer (with a dedup crosscheck against the existing book) at the win. The lead is stamped
  // 'quoted' so it leaves the open list (exactly as before), but its customer_id stays null until the
  // estimate is accepted. (An org that explicitly links an existing customer still can, via opts.)
  if (target === "quote") {
    const linkedCustomer = opts.customerId ?? null;
    let redirect: string;
    const lines = estimateLinesFromIntake(inq.intake);
    if (lines.length) {
      // Lead arrived with a priced estimate (Tahoe Deck configurator) → seed a real draft and open it.
      const { data: orgRow } = await supabase.from("organizations").select("settings").maybeSingle();
      const validUntil = new Date();
      validUntil.setDate(validUntil.getDate() + (getOrgSettings(orgRow?.settings).quote_expiry_days || 30));
      const label = PROJECT_TYPES.find((p) => p.value === inq.project_type)?.label;
      const reason = typeof (inq.intake as { reason?: unknown } | null)?.reason === "string"
        ? (inq.intake as { reason: string }).reason
        : null;
      const res = await saveQuote({
        customer_id: linkedCustomer, // null → the estimate stands alone until accepted
        inquiry_id: id, // provenance: this estimate traces back to the lead
        title: label ? `${label} — ${inq.name}` : `Estimate — ${inq.name}`,
        notes: reason ? `From lead — ${reason}` : "From lead.",
        tax_rate: 0, // never infer tax on a seeded draft; the office sets it on review
        valid_until: validUntil.toISOString().slice(0, 10),
        items: lines,
      });
      if (!res.ok) return { ok: false, error: res.error };
      redirect = `/quotes/${res.id}`;
    } else {
      // Manual lead → open the blank builder threaded to the inquiry (no customer forced).
      redirect = linkedCustomer
        ? `/quotes/new?customer=${linkedCustomer}&inquiry=${id}`
        : `/quotes/new?inquiry=${id}`;
    }
    const { error: uErr } = await supabase
      .from("inquiries")
      .update({
        customer_id: linkedCustomer, // stays null until the estimate is accepted
        converted_to: "quote",
        converted_at: new Date().toISOString(),
        status: "quoted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (uErr) return { ok: false, error: uErr.message };
    revalidatePath("/leads");
    revalidatePath("/quotes");
    return { ok: true, redirect };
  }

  // Resolve the customer: link the chosen existing one, or create from inquiry.
  // (Reached only by the commit-now targets: customer / estimate-job / job.)
  let customerId = opts.customerId || null;
  if (!customerId) {
    const { data: cust, error: cErr } = await supabase
      .from("customers")
      .insert({
        name: inq.name,
        company_name: inq.company_name,
        type: inq.type ?? "residential",
        status: "active",
        email: inq.email,
        phone: inq.phone,
        address: inq.address,
        city: inq.city,
        state: inq.state,
        zip: inq.zip,
        notes: inq.message ? `From inquiry: ${inq.message}` : inq.notes,
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (cErr) return { ok: false, error: cErr.message };
    customerId = cust.id;
  }

  let redirect = `/crm/${customerId}`;
  let newStatus = "won";

  if (target === "estimate" || target === "job") {
    // An estimate is still in the pipeline; a scheduled job means the inquiry is won.
    newStatus = target === "estimate" ? "quoted" : "won";
    const { data: job, error: jErr } = await supabase
      .from("jobs")
      .insert({
        customer_id: customerId,
        inquiry_id: id, // provenance: this estimate/job traces back to the lead
        name: `Job — ${inq.name}`,
        description: inq.message ?? null,
        // Lifecycle rework (2026-07): "estimate" is a QUOTE stage, not a job status — a job
        // born from a lead starts in the to_be_scheduled waiting room either way.
        status: "to_be_scheduled",

        address: inq.address,
        city: inq.city,
        state: inq.state,
        zip: inq.zip,
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (jErr) return { ok: false, error: jErr.message };
    redirect = `/jobs/${job.id}`;
  }

  const { error: uErr } = await supabase
    .from("inquiries")
    .update({
      customer_id: customerId,
      converted_to: target,
      converted_at: new Date().toISOString(),
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (uErr) return { ok: false, error: uErr.message };

  revalidatePath("/leads");
  revalidatePath("/crm");
  return { ok: true, id: customerId ?? undefined, redirect };
}
