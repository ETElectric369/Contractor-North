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
  target: "customer" | "quote" | "estimate" | "job",
  opts: { customerId?: string | null } = {},
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: inq } = await supabase.from("inquiries").select("*").eq("id", id).maybeSingle();
  if (!inq) return { ok: false, error: "Lead not found." };

  // Resolve the customer: link the chosen existing one, or create from inquiry.
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

  if (target === "quote") {
    newStatus = "quoted";
    // If the lead arrived with a priced estimate (the Tahoe Deck configurator sends
    // intake.estimate.lines), seed a real draft estimate from those lines and open it —
    // lead → priced draft in one click. Manual leads / design consults with nothing to
    // price fall back to the empty new-quote form, exactly as before.
    const lines = estimateLinesFromIntake(inq.intake);
    if (lines.length) {
      const { data: orgRow } = await supabase.from("organizations").select("settings").maybeSingle();
      const validUntil = new Date();
      validUntil.setDate(validUntil.getDate() + (getOrgSettings(orgRow?.settings).quote_expiry_days || 30));
      const label = PROJECT_TYPES.find((p) => p.value === inq.project_type)?.label;
      const reason = typeof (inq.intake as { reason?: unknown } | null)?.reason === "string"
        ? (inq.intake as { reason: string }).reason
        : null;
      const res = await saveQuote({
        customer_id: customerId,
        title: label ? `${label} — ${inq.name}` : `Estimate — ${inq.name}`,
        notes: reason ? `From lead — ${reason}` : "From lead.",
        tax_rate: 0, // never infer tax on a seeded draft; the office sets it on review
        valid_until: validUntil.toISOString().slice(0, 10),
        items: lines,
      });
      if (!res.ok) return { ok: false, error: res.error };
      redirect = `/quotes/${res.id}`;
    } else {
      redirect = `/quotes/new?customer=${customerId}`;
    }
  } else if (target === "estimate" || target === "job") {
    // An estimate is still in the pipeline; a scheduled job means the inquiry is won.
    newStatus = target === "estimate" ? "quoted" : "won";
    const { data: job, error: jErr } = await supabase
      .from("jobs")
      .insert({
        customer_id: customerId,
        name: `Job — ${inq.name}`,
        description: inq.message ?? null,
        status: target === "estimate" ? "estimate" : "scheduled",

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
