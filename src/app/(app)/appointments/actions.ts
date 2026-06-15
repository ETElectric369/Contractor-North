"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendPushToProfiles } from "@/lib/push";

export type Result = { ok: boolean; error?: string; id?: string };

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

/** Resolve the customer for an appointment form: an existing id, or create a new
 *  customer on the fly from a typed name (the "+ New customer" path). Surfaces
 *  errors instead of silently saving an appointment with no customer. */
async function resolveCustomer(
  supabase: any,
  formData: FormData,
  userId: string,
): Promise<{ customerId: string | null; error?: string }> {
  const customerId = emptyToNull(formData.get("customer_id"));
  const newName = emptyToNull(formData.get("new_customer_name"));
  if (customerId === "__new__" || (!customerId && newName)) {
    if (!newName) return { customerId: null, error: "Enter a name for the new customer." };
    const { data: c, error } = await supabase
      .from("customers")
      .insert({ name: newName, phone: emptyToNull(formData.get("new_customer_phone")), created_by: userId })
      .select("id")
      .single();
    if (error || !c) return { customerId: null, error: error?.message ?? "Could not create the new customer." };
    return { customerId: c.id };
  }
  return { customerId };
}

/** Combine a date + time input into an ISO timestamp at local time. */
function toIso(date: string, time: string): string | null {
  if (!date) return null;
  const t = time && /^\d{2}:\d{2}/.test(time) ? time : "08:00";
  const d = new Date(`${date}T${t}:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export async function createAppointment(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };

  // Prefer the ISO the browser computed in the user's own timezone; fall back to
  // server-side parsing only if it's missing.
  const startIso =
    emptyToNull(formData.get("starts_at_iso")) ??
    toIso(String(formData.get("date") ?? ""), String(formData.get("start_time") ?? ""));
  if (!startIso) return { ok: false, error: "Pick a date." };
  const endTime = String(formData.get("end_time") ?? "");
  const endIso =
    emptyToNull(formData.get("ends_at_iso")) ??
    (endTime ? toIso(String(formData.get("date") ?? ""), endTime) : null);

  const cust = await resolveCustomer(supabase, formData, user.id);
  if (cust.error) return { ok: false, error: cust.error };
  const customerId = cust.customerId;

  const { data, error } = await supabase
    .from("appointments")
    .insert({
      type: String(formData.get("type") ?? "appointment"),
      title,
      starts_at: startIso,
      ends_at: endIso,
      job_id: emptyToNull(formData.get("job_id")),
      customer_id: customerId,
      location: emptyToNull(formData.get("location")),
      notes: emptyToNull(formData.get("notes")),
      assigned_to: emptyToNull(formData.get("assigned_to")),
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  const assignedTo = emptyToNull(formData.get("assigned_to"));
  if (assignedTo && assignedTo !== user.id) {
    void sendPushToProfiles([assignedTo], "assigned", {
      title: "New appointment assigned",
      body: title,
      url: "/schedule?view=appointments",
    });
  }

  revalidatePath("/schedule");
  return { ok: true, id: data.id };
}

export async function updateAppointment(id: string, formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };
  const cust = user
    ? await resolveCustomer(supabase, formData, user.id)
    : { customerId: emptyToNull(formData.get("customer_id")) as string | null };
  if (cust.error) return { ok: false, error: cust.error };
  const customerId = cust.customerId;

  // Prefer the ISO the browser computed in the user's own timezone; fall back to
  // server-side parsing only if it's missing.
  const startIso =
    emptyToNull(formData.get("starts_at_iso")) ??
    toIso(String(formData.get("date") ?? ""), String(formData.get("start_time") ?? ""));
  if (!startIso) return { ok: false, error: "Pick a date." };
  const endTime = String(formData.get("end_time") ?? "");
  const endIso =
    emptyToNull(formData.get("ends_at_iso")) ??
    (endTime ? toIso(String(formData.get("date") ?? ""), endTime) : null);

  const { error } = await supabase
    .from("appointments")
    .update({
      type: String(formData.get("type") ?? "appointment"),
      title,
      starts_at: startIso,
      ends_at: endIso,
      job_id: emptyToNull(formData.get("job_id")),
      customer_id: customerId,
      location: emptyToNull(formData.get("location")),
      notes: emptyToNull(formData.get("notes")),
      assigned_to: emptyToNull(formData.get("assigned_to")),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/schedule");
  return { ok: true };
}

export async function setAppointmentStatus(id: string, status: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("appointments")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  return { ok: true };
}

/** Turn an appointment (often a site-visit/estimate walk-through) into a job —
 *  idempotent: if it already spawned one, returns that job. Inherits the
 *  customer, title → name, location → address, and start time. */
export async function createJobFromAppointment(appointmentId: string): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: appt } = await supabase
    .from("appointments")
    .select("id, title, customer_id, location, job_id, starts_at")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.job_id) return { ok: true, id: appt.job_id };

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      name: appt.title || "Job from appointment",
      customer_id: appt.customer_id,
      status: "scheduled",
      scheduled_start: appt.starts_at,
      address: appt.location,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  await supabase.from("appointments").update({ job_id: job.id }).eq("id", appointmentId);
  revalidatePath("/schedule");
  return { ok: true, id: job.id };
}

export async function deleteAppointment(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("appointments").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  return { ok: true };
}
