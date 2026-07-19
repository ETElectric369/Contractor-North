// Single source of truth for the jobs/customers/staff option lists that feed
// AppointmentButton (and NewJobButton). The label SHAPE lived inline in three
// places and drifted; keep the mappers here so they can't.

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatFullAddress } from "@/lib/utils";

export type PickerOption = { id: string; label: string; address?: string | null };

/** THE job display label — "J-0012 · Panel swap". The one shape every job dropdown,
 *  chip and toast uses (toJobOptions builds its option labels with it too), so the
 *  label can't drift per surface. Client-safe (pure). */
export const jobLabel = (j: { job_number?: string | null; name?: string | null }): string =>
  `${j.job_number} · ${j.name}`;

/** The CODES-OFF job identity label — "Smith · 123 Main St" (customer · street address).
 *  Orgs that turn timeclock_job_codes off identify work by whose house the crew is at,
 *  not by a number/code; every codes-off timeclock picker/chip uses THIS shape (same
 *  SSOT rule as jobLabel — no per-surface forks). Falls back to jobLabel when the job
 *  carries neither part, so a bare row still labels. Client-safe (pure). */
export const jobSiteLabel = (j: {
  job_number?: string | null;
  name?: string | null;
  address?: string | null;
  customer_name?: string | null;
}): string => {
  const parts = [j.customer_name, j.address].map((s) => (s ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(" · ") : jobLabel(j);
};

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

/** The new-job form's customer options — name plus the ONE-LINE site-address prefill
 *  (a job stores a single address string; formatFullAddress is the canonical shape). */
export type NewJobCustomerOption = { id: string; name: string; address: string | null };

export const toNewJobCustomerOptions = (rows: any[] | null | undefined): NewJobCustomerOption[] =>
  (rows ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    address: formatFullAddress(c.address, c.city, c.state, c.zip) || null,
  }));

/** listCustomerOptions + the address parts — ONLY for surfaces that prefill a site
 *  address from the pick (NewJobButton). A separate query so the plain pickers
 *  (e.g. billing's 2000-row list) don't ship four extra columns to the client. */
export const listNewJobCustomerOptions = (supabase: SupabaseClient) =>
  supabase.from("customers").select("id, name, address, city, state, zip").order("name");

/** New-job form: what the site-address field should become when the customer pick
 *  changes. Returns the string to apply (possibly "" — dropping a stale prefill when
 *  the new pick has no address), or null to leave the field alone. The pick's address
 *  applies only while the field is empty or still holds the PREVIOUS pick's prefill,
 *  so typed input is never clobbered. */
export function addressPrefillOnCustomerPick(
  current: string,
  prevPrefill: string,
  nextPrefill: string,
): string | null {
  const untouched = current.trim() === "" || current === prevPrefill;
  if (!untouched || nextPrefill === current) return null;
  return nextPrefill;
}

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
