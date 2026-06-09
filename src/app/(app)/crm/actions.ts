"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { formatPhone, formatState, formatZip, titleCase } from "@/lib/utils";

export type ActionResult = { ok: boolean; error?: string; id?: string };

export async function createCustomer(formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { data, error } = await supabase
    .from("customers")
    .insert({
      name,
      company_name: emptyToNull(formData.get("company_name")),
      type: String(formData.get("type") ?? "residential"),
      status: String(formData.get("status") ?? "lead"),
      email: emptyToNull(formData.get("email")),
      phone: orNull(formatPhone(String(formData.get("phone") ?? ""))),
      address: emptyToNull(formData.get("address")),
      city: orNull(titleCase(String(formData.get("city") ?? ""))),
      state: orNull(formatState(String(formData.get("state") ?? ""))),
      zip: orNull(formatZip(String(formData.get("zip") ?? ""))),
      notes: emptyToNull(formData.get("notes")),
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/crm");
  return { ok: true, id: data.id };
}

export async function updateCustomer(
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createClient();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { error } = await supabase
    .from("customers")
    .update({
      name,
      company_name: emptyToNull(formData.get("company_name")),
      type: String(formData.get("type") ?? "residential"),
      status: String(formData.get("status") ?? "lead"),
      email: emptyToNull(formData.get("email")),
      phone: orNull(formatPhone(String(formData.get("phone") ?? ""))),
      address: emptyToNull(formData.get("address")),
      city: orNull(titleCase(String(formData.get("city") ?? ""))),
      state: orNull(formatState(String(formData.get("state") ?? ""))),
      zip: orNull(formatZip(String(formData.get("zip") ?? ""))),
      notes: emptyToNull(formData.get("notes")),
      pricing_level_id: emptyToNull(formData.get("pricing_level_id")),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/crm/${id}`);
  revalidatePath("/crm");
  return { ok: true };
}

/** Log that a lead was contacted now; optionally set the next follow-up date. */
export async function markContacted(
  id: string,
  nextFollowUp?: string | null,
): Promise<ActionResult> {
  const supabase = await createClient();
  const patch: Record<string, unknown> = {
    last_contacted_at: new Date().toISOString(),
  };
  if (nextFollowUp !== undefined) patch.next_follow_up_at = nextFollowUp || null;
  const { error } = await supabase.from("customers").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/leads");
  revalidatePath(`/crm/${id}`);
  return { ok: true };
}

export async function setNextFollowUp(
  id: string,
  date: string | null,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({ next_follow_up_at: date || null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/leads");
  return { ok: true };
}

/** Convert an inquiry into a job (and mark the customer active). */
export async function createJobForCustomer(
  customerId: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: cust } = await supabase
    .from("customers")
    .select("name")
    .eq("id", customerId)
    .maybeSingle();

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      customer_id: customerId,
      name: cust?.name ? `Job — ${cust.name}` : "New job",
      status: "scheduled",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  await supabase.from("customers").update({ status: "active" }).eq("id", customerId);
  revalidatePath("/leads");
  return { ok: true, id: job.id };
}

export async function convertLead(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({ status: "active" })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/leads");
  revalidatePath("/crm");
  return { ok: true };
}

export async function updateCustomerStatus(
  id: string,
  status: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({ status })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/crm");
  revalidatePath(`/crm/${id}`);
  return { ok: true };
}

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

function orNull(s: string): string | null {
  const t = s.trim();
  return t.length ? t : null;
}
