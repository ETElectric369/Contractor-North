import type { SupabaseClient } from "@supabase/supabase-js";
import type { Inquiry } from "@/lib/types";
import type { FileVisitRow } from "@/lib/appointments/file-visit";

/**
 * WHAT THE LEAD'S FILE READS (cn-v1170, /leads/<id>). Erik, 2026-11-19: "lets make everything staged
 * around the customer and stored with the customer file", and "if they are Not Sold then the data
 * stays with them in that file". Until the win makes a customer, this page is the lead's file.
 *
 * Every read goes through the caller's own session client (RLS keeps it in the company), names its
 * columns, and keeps its error: a failed read is said on the page, never drawn as "nothing". NO MONEY
 * COLUMN: techs see no prices, and nothing here needs one (so no estimate total, no estimate_total).
 */

/** The lead's own columns, with who referred it (the list page's join). */
export const LEAD_FILE_COLUMNS =
  "id, name, company_name, type, email, phone, address, unit, city, state, zip, message, notes, source, status, last_contacted_at, customer_id, converted_to, converted_at, created_by, created_at, updated_at, priority, intake, lead_bucket, site_inspection_required, referrer:profiles!inquiries_referred_by_fkey(full_name)";
export const FILE_VISIT_COLUMNS = "id, type, status, outcome, starts_at, title, job_id";
export const FILE_ESTIMATE_COLUMNS = "id, quote_number, title, status, created_at";
export const FILE_JOB_COLUMNS = "id, job_number, name, status";

export type FileLead = Inquiry & { referrer?: { full_name?: string | null } | null };
/** One shape for a visit on any person's file (cn-v1171): lib/appointments/file-visit. */
export type FileVisit = FileVisitRow;
export type FileEstimate = { id: string; quote_number: string | null; title: string | null; status: string; created_at: string };
export type FileJob = { id: string; job_number: string | null; name: string | null; status: string | null };

export type LeadFileRead = {
  /** null with no error: there is no such lead for this person (notFound). */
  lead: FileLead | null;
  leadError: unknown;
  /** Each list is null when its read failed. */
  visits: FileVisit[] | null;
  estimates: FileEstimate[] | null;
  jobs: FileJob[] | null;
  /** null when there is no customer, or its name could not be read (the link then says it plainly). */
  customerName: string | null;
  /** Each failed read's error, by what it read, for the error sink. */
  readErrors: Record<string, unknown>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMPTY: Omit<LeadFileRead, "lead" | "leadError"> = { visits: [], estimates: [], jobs: [], customerName: null, readErrors: {} };

export async function readLeadFile(supabase: SupabaseClient, id: string): Promise<LeadFileRead> {
  // An id that is not a uuid is a lead that does not exist, not a failed read.
  if (!UUID.test(id)) return { lead: null, leadError: null, ...EMPTY };
  const { data: lead, error: leadError } = await supabase.from("inquiries").select(LEAD_FILE_COLUMNS).eq("id", id).maybeSingle();
  if (leadError || !lead) return { lead: null, leadError: leadError ?? null, ...EMPTY };
  const row = lead as unknown as FileLead;

  const [visits, estimates, jobs, customer] = await Promise.all([
    // Cancelled ones too (cn-v1171): the Inspections page's Filed side is gone, so the person's file is
    // where a cancelled inspection is found. Nothing here takes one for a visit that stands
    // (visitStands refuses a cancelled status). Read soonest first, so the header names the soonest
    // visit that stands, as before; the list is drawn in the file's own order (fileVisitOrder).
    supabase
      .from("appointments")
      .select(FILE_VISIT_COLUMNS)
      .eq("inquiry_id", id)
      .order("starts_at", { ascending: true, nullsFirst: false }),
    supabase.from("quotes").select(FILE_ESTIMATE_COLUMNS).eq("inquiry_id", id).order("created_at", { ascending: false }),
    supabase.from("jobs").select(FILE_JOB_COLUMNS).eq("inquiry_id", id).order("created_at", { ascending: false }),
    row.customer_id
      ? supabase.from("customers").select("name").eq("id", row.customer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const customerName = String((customer.data as { name?: string | null } | null)?.name ?? "").trim() || null;
  const readErrors: Record<string, unknown> = {};
  for (const [what, r] of [["visits", visits], ["estimates", estimates], ["jobs", jobs], ["customer", customer]] as const) {
    if (r.error) readErrors[what] = r.error;
  }
  return {
    lead: row,
    leadError: null,
    visits: visits.error ? null : ((visits.data ?? []) as FileVisit[]),
    estimates: estimates.error ? null : ((estimates.data ?? []) as FileEstimate[]),
    jobs: jobs.error ? null : ((jobs.data ?? []) as FileJob[]),
    customerName,
    readErrors,
  };
}
