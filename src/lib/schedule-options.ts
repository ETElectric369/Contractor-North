// Single source of truth for the jobs/customers/staff option lists that feed
// AppointmentButton (and NewJobButton). The label SHAPE lived inline in three
// places and drifted; keep the mappers here so they can't.

import type { SupabaseClient } from "@supabase/supabase-js";

export type PickerOption = { id: string; label: string };

export const toJobOptions = (rows: any[] | null | undefined): PickerOption[] =>
  (rows ?? []).map((j) => ({ id: j.id, label: `${j.job_number} · ${j.name}` }));
export const toCustomerOptions = (rows: any[] | null | undefined): PickerOption[] =>
  (rows ?? []).map((c) => ({ id: c.id, label: c.name }));
export const toStaffOptions = (rows: any[] | null | undefined): PickerOption[] =>
  (rows ?? []).map((s) => ({ id: s.id, label: s.full_name ?? "Unnamed" }));

/** Fetch the jobs/customers/staff rows and map them to picker options — for
 *  callers that don't already have the rows on hand. */
export async function getSchedulePickerOptions(supabase: SupabaseClient) {
  const [{ data: jobs }, { data: customers }, { data: staff }] = await Promise.all([
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(200),
    supabase.from("customers").select("id, name").order("name"),
    supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
  ]);
  return {
    jobOpts: toJobOptions(jobs),
    custOpts: toCustomerOptions(customers),
    staffOpts: toStaffOptions(staff),
    customers: (customers ?? []) as { id: string; name: string }[],
    staff: (staff ?? []) as { id: string; full_name: string | null }[],
  };
}
