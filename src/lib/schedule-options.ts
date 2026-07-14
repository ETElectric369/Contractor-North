// Single source of truth for the jobs/customers/staff option lists that feed
// AppointmentButton (and NewJobButton). The label SHAPE lived inline in three
// places and drifted; keep the mappers here so they can't.

import type { SupabaseClient } from "@supabase/supabase-js";

export type PickerOption = { id: string; label: string; address?: string | null };

/** THE job display label — "J-0012 · Panel swap". The one shape every job dropdown,
 *  chip and toast uses (toJobOptions builds its option labels with it too), so the
 *  label can't drift per surface. Client-safe (pure). */
export const jobLabel = (j: { job_number?: string | null; name?: string | null }): string =>
  `${j.job_number} · ${j.name}`;

export const toJobOptions = (rows: any[] | null | undefined): PickerOption[] =>
  (rows ?? []).map((j) => ({ id: j.id, label: jobLabel(j), address: j.address ?? null }));
export const toCustomerOptions = (rows: any[] | null | undefined): PickerOption[] =>
  (rows ?? []).map((c) => ({ id: c.id, label: c.name }));
export const toStaffOptions = (rows: any[] | null | undefined): PickerOption[] =>
  (rows ?? []).map((s) => ({ id: s.id, label: s.full_name ?? "Unnamed" }));

/** THE active-tech roster query — every assignee picker / crew list reads the same
 *  active profiles, id+full_name, sorted by name, so the roster can't drift across
 *  surfaces. Returns the Supabase query builder: await it, or drop it into a Promise.all. */
export const listActiveTechs = (supabase: SupabaseClient) =>
  supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name");

/** THE customer-picker query — id+name, alphabetical. Pass `limit` for the big billing
 *  picker; omit it for the common short lists. Same drift-proofing as listActiveTechs. */
export const listCustomerOptions = (supabase: SupabaseClient, limit?: number) => {
  const q = supabase.from("customers").select("id, name").order("name");
  return limit ? q.limit(limit) : q;
};

/** Fetch the jobs/customers/staff rows and map them to picker options — for
 *  callers that don't already have the rows on hand. */
export async function getSchedulePickerOptions(supabase: SupabaseClient) {
  const [{ data: jobs }, { data: customers }, { data: staff }] = await Promise.all([
    supabase.from("jobs").select("id, job_number, name, address").order("created_at", { ascending: false }).limit(200),
    listCustomerOptions(supabase),
    listActiveTechs(supabase),
  ]);
  return {
    jobOpts: toJobOptions(jobs),
    custOpts: toCustomerOptions(customers),
    staffOpts: toStaffOptions(staff),
    customers: (customers ?? []) as { id: string; name: string }[],
    staff: (staff ?? []) as { id: string; full_name: string | null }[],
  };
}
