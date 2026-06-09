"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { formatPhone, formatState, formatZip, titleCase } from "@/lib/utils";

export type Result = { ok: boolean; error?: string; id?: string; redirect?: string };

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { data, error } = await supabase
    .from("inquiries")
    .insert({ name, ...inquiryFields(formData), source: "manual", status: "new", created_by: user.id })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/leads");
  return { ok: true, id: data.id };
}

export async function updateInquiry(id: string, formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { error } = await supabase
    .from("inquiries")
    .update({ name, ...inquiryFields(formData), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/leads");
  return { ok: true };
}

/** Log contact now; optionally set/update the next follow-up date. */
export async function markInquiryContacted(id: string, nextFollowUp?: string | null): Promise<Result> {
  const supabase = await createClient();
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
  const supabase = await createClient();
  const { error } = await supabase
    .from("inquiries")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/leads");
  return { ok: true };
}

export async function deleteInquiry(id: string): Promise<Result> {
  const supabase = await createClient();
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
  target: "customer" | "quote" | "job",
  opts: { customerId?: string | null } = {},
): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: inq } = await supabase.from("inquiries").select("*").eq("id", id).maybeSingle();
  if (!inq) return { ok: false, error: "Inquiry not found." };

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
        created_by: user.id,
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
    redirect = `/quotes/new?customer=${customerId}`;
  } else if (target === "job") {
    const { data: job, error: jErr } = await supabase
      .from("jobs")
      .insert({
        customer_id: customerId,
        name: `Job — ${inq.name}`,
        description: inq.message ?? null,
        status: "estimate",
        address: inq.address,
        city: inq.city,
        state: inq.state,
        zip: inq.zip,
        created_by: user.id,
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
