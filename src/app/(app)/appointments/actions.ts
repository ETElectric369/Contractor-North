"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendPushToProfiles } from "@/lib/push";

export type Result = { ok: boolean; error?: string; id?: string };

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
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

  const { data, error } = await supabase
    .from("appointments")
    .insert({
      type: String(formData.get("type") ?? "appointment"),
      title,
      starts_at: startIso,
      ends_at: endIso,
      job_id: emptyToNull(formData.get("job_id")),
      customer_id: emptyToNull(formData.get("customer_id")),
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

  const { error } = await supabase
    .from("appointments")
    .update({
      type: String(formData.get("type") ?? "appointment"),
      title,
      starts_at: startIso,
      ends_at: endIso,
      job_id: emptyToNull(formData.get("job_id")),
      customer_id: emptyToNull(formData.get("customer_id")),
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

export async function deleteAppointment(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("appointments").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  return { ok: true };
}
