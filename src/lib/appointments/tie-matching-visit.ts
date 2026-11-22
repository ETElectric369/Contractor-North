import type { SupabaseClient } from "@supabase/supabase-js";
import { SALES_VISIT_TYPES } from "@/lib/appointments/visit-settled";
import { exactJobMatch } from "@/lib/appointments/visit-offer";
import { isDecidableVisitType } from "@/lib/statuses";
import { stampLeadWonByJob } from "@/lib/appointments/lead-won";
import { reportError } from "@/lib/observe";

/**
 * A NEW JOB FINDS ITS VISIT (cn-v1181, I3). The owner, 2026-11-22, of an inspection put in by hand
 * ("Site inspection: Dana Rook", at 410 Larkspur Lane, no customer record, no lead) and a job made by
 * hand for Dana Rook at 410 Larkspur Lane two weeks later: "i put it in not sold but shouldnt it have
 * automatically filed having a name and address on it that match exactly the job".
 *
 * Called by the door that makes a job by hand (schedule/actions createJob), after the job is written.
 * The visit is tied ONLY when EXACTLY ONE open sales visit is an exact match (lib/appointments/visit-offer
 * exactJobMatch: the same street, the same person, the job made after it). Open: not cancelled, not
 * Not Sold, no job, its day passed or it is completed. None: nothing. Several: nothing is written, and
 * each row's offer on the Inspections page asks (a guess between two is no tie).
 *
 * THE TIE IS THE VISIT'S OWN ATTACH RULE, the patch linkAppointmentTo writes for a job: the job, the
 * job's customer when it has one, Won when the kind has a win and none is set (and the lead behind it
 * won with the job, lib/appointments/lead-won, as that door does). Compare-and-set on the row as read
 * (still no job, still not cancelled, its outcome as read), in the caller's company, read back: zero
 * rows is said, never taken for done.
 *
 * NEVER THROWS: the job is made whatever happens here. A failed read or write comes back as `failed`
 * and is filed to the ops sink; the caller says it. No catalog (a lib imports none): the caller words it.
 */

/** The visit columns the match and the tie read. No money column. */
export const TIE_VISIT_COLUMNS = "id, type, title, status, outcome, starts_at, location, inquiry_id, customer_id, job_id, inquiries(name, customer_id)";
/** How many open visits are read at most; a read cut there ties nothing (exactly one cannot be told). */
export const TIE_VISIT_CAP = 500;

export type TieJob = { id: string; customer_id: string | null; address: string | null; unit?: string | null; created_at: string | null };
/** How far back a visit may be and still be the new job's: its day within this many days before. */
export const TIE_VISIT_DAYS = 180;

type VisitRow = {
  id: string;
  type: string | null;
  title: string | null;
  status: string;
  outcome: string | null;
  starts_at: string | null;
  location: string | null;
  inquiry_id: string | null;
  customer_id: string | null;
  job_id: string | null;
  inquiries?: { name?: string | null; customer_id?: string | null } | { name?: string | null; customer_id?: string | null }[] | null;
};

export type TieResult =
  /** Tied: which visit, for the door's sentence (its words and its start). */
  | { kind: "tied"; visit: { id: string; title: string | null; location: string | null; lead_name: string | null; starts_at: string | null }; warning?: string }
  | { kind: "none" }
  | { kind: "several"; count: number }
  /** A read or the write failed (filed to the ops sink); `visit` when it was the write. */
  | { kind: "failed"; visit?: { id: string; title: string | null; location: string | null; lead_name: string | null; starts_at: string | null } };

const one = <V,>(v: V | V[] | null | undefined): V | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** Open, by the rule above, at `now`. */
export function openForTie(v: Pick<VisitRow, "status" | "outcome" | "job_id" | "starts_at">, now: Date): boolean {
  if (v.job_id) return false;
  if (v.status === "cancelled") return false;
  if (v.outcome === "lost" || v.outcome === "no_bid") return false;
  if (v.status === "completed") return true;
  const at = v.starts_at ? Date.parse(v.starts_at) : NaN;
  return Number.isFinite(at) && at <= now.getTime();
}

export async function tieMatchingVisit(
  supabase: SupabaseClient,
  w: { orgId: string | null; job: TieJob; now?: Date },
): Promise<TieResult> {
  const now = w.now ?? new Date();
  const job = w.job;
  if (!job.address || !String(job.address).trim() || !job.customer_id || !w.orgId) return { kind: "none" };
  // ONLY A RECENT VISIT (skeptic #84, M5): its day within TIE_VISIT_DAYS before the job is made, so an
  // inspection years old at the same street is never filed with today's job.
  const madeAt = Date.parse(String(job.created_at ?? "")) || now.getTime();
  const since = new Date(madeAt - TIE_VISIT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabase
      .from("appointments")
      .select(TIE_VISIT_COLUMNS)
      .eq("org_id", w.orgId)
      .in("type", [...SALES_VISIT_TYPES])
      .is("job_id", null)
      .neq("status", "cancelled")
      // ENDED VISITS ARE LEFT OUT IN THE QUERY ITSELF (skeptic #84, M5): five hundred old Not Sold
      // visits would otherwise fill the cap and the door would tie nothing for ever. A null outcome
      // stays in (SQL's NOT IN would drop it, so it is asked for by name).
      .or("outcome.is.null,outcome.not.in.(lost,no_bid)")
      .gte("starts_at", since)
      .not("location", "is", null)
      .order("starts_at", { ascending: false })
      .limit(TIE_VISIT_CAP);
    if (error) throw error;
    const rows = (data ?? []) as VisitRow[];
    if (rows.length >= TIE_VISIT_CAP) {
      reportError("tieMatchingVisit:capped", new Error(`open visits read cut at ${TIE_VISIT_CAP}`), { jobId: job.id });
      return { kind: "none" };
    }
    // The job's customer's name as on file (the name arm of the match), in the caller's company: read
    // only when an open visit with no customer record of its own or its lead's is there to ask it.
    const open = rows.filter((v) => openForTie(v, now));
    let customerName: string | null = null;
    if (open.some((v) => !v.customer_id && !one(v.inquiries)?.customer_id)) {
      const { data: cust, error: custErr } = await supabase.from("customers").select("id, name").eq("id", job.customer_id).eq("org_id", w.orgId).maybeSingle();
      if (custErr) throw custErr;
      customerName = (cust as { name?: string | null } | null)?.name ?? null;
    }
    const matches = open.filter(
      (v) =>
        exactJobMatch(
          {
            starts_at: v.starts_at,
            job_id: v.job_id,
            customer_id: v.customer_id,
            lead_customer_id: one(v.inquiries)?.customer_id ?? null,
            location: v.location,
            title: v.title,
            lead_name: one(v.inquiries)?.name ?? null,
          },
          { created_at: job.created_at, address: job.address, unit: job.unit ?? null, customer_id: job.customer_id, customer_name: customerName },
        ),
    );
    if (matches.length === 0) return { kind: "none" };
    if (matches.length > 1) return { kind: "several", count: matches.length };

    const v = matches[0];
    const said = { id: v.id, title: v.title, location: v.location, lead_name: one(v.inquiries)?.name ?? null, starts_at: v.starts_at };
    // THE PATCH linkAppointmentTo WRITES FOR A JOB. The place is not filled: the match needed one.
    const patch: Record<string, unknown> = { job_id: job.id, customer_id: job.customer_id, updated_at: now.toISOString() };
    const win = isDecidableVisitType(v.type) && !v.outcome;
    if (win) {
      patch.outcome = "won";
      patch.outcome_at = now.toISOString();
    }
    let write = supabase.from("appointments").update(patch).eq("id", v.id).eq("org_id", w.orgId).is("job_id", null).neq("status", "cancelled");
    write = v.outcome ? write.eq("outcome", v.outcome) : write.is("outcome", null);
    const { data: tied, error: tieErr } = await write.select("id");
    if (tieErr || !tied?.length) {
      reportError("tieMatchingVisit:write", tieErr ?? new Error("the tie wrote no row"), { jobId: job.id, appointmentId: v.id });
      return { kind: "failed", visit: said };
    }
    const lead = await stampLeadWonByJob(supabase, { jobId: job.id, inquiryId: v.inquiry_id });
    return { kind: "tied", visit: said, ...(lead.warning ? { warning: lead.warning } : {}) };
  } catch (e) {
    reportError("tieMatchingVisit:read", e, { jobId: job.id });
    return { kind: "failed" };
  }
}
