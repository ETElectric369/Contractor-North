import { hoursBetween } from "@/lib/utils";
import { payRateForEntry } from "@/lib/payroll-math";

/** One billable-labor line for a worker on a job. */
export type LaborLine = { personId: string; name: string; rate: number; rawHours: number; quantity: number; amount: number };

/**
 * Per-job LABOR COST (what we PAY) — the one allocation-aware implementation shared by the job
 * hub and /analytics so a job can't show two different profits. Counts only the hours that belong
 * to `jobId`: an entry's same-job/unlabeled allocations, or its gross hours when it has no split.
 * Each entry is costed at its OWN pay rate (rate_override ?? base) via payRateForEntry. Accepts the
 * job's own entries (job hub, pre-filtered) OR all entries (analytics) — same result either way.
 */
export function laborCostForJob(
  entries: any[],
  jobId: string,
  fallbackRate = 0,
): { hours: number; cost: number } {
  let hours = 0;
  let cost = 0;
  for (const e of entries ?? []) {
    const rate = payRateForEntry(e, fallbackRate);
    const allocs = e.time_allocations ?? [];
    if (allocs.length) {
      for (const a of allocs) {
        // belongs to this job if the allocation names it, or it's unlabeled and the entry is on this job
        const belongs = a.job_id ? a.job_id === jobId : e.job_id === jobId;
        if (!belongs) continue;
        const h = Number(a.hours ?? 0);
        hours += h;
        cost += h * rate;
      }
      continue;
    }
    if (e.job_id === jobId && e.status === "closed" && e.clock_out) {
      const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
      hours += h;
      cost += h * rate;
    }
  }
  return { hours: Math.round(hours * 100) / 100, cost: Math.round(cost * 100) / 100 };
}

/** Compute per-person billable labor for a job from its CLOSED time — the single
 *  source of truth shared by importLaborIntoInvoice (which inserts these lines)
 *  and jobProgressFinancials / the job page (which sum the total). Keeping the
 *  algorithm in one place is what makes the panel's "work to date" reconcile to
 *  the penny with the labor lines that actually get billed.
 *
 *  Rule (Erik's): bill the EXACT time on this job — (1) every time-allocation
 *  tagged to the job, even from a shift clocked mainly into another job, plus
 *  (2) the UNLABELED allocation rows on this job's own entries, plus (3) un-split
 *  closed entries on the job (gross hours). Rate = bill_rate ?? hourly_rate ??
 *  default_labor_rate. Quantity is rounded to the quarter hour PER PERSON (so a
 *  2.6h person bills 2.5h, matching the printed line).
 *
 *  (2) is the fix for the silent-unbilled-week bug: a job-less clock-in writes an
 *  allocation row with job_id NULL, which laborCostForJob:27 COSTS to the entry's job
 *  ("unlabeled → the entry's job"). This used to skip any entry that had allocations at
 *  all, so those hours were costed but never billable — the job hub showed thousands of
 *  labor while the draw imported $0. Same predicate on both sides now, so cost and bill
 *  can't disagree about what a null job_id means.
 *
 *  jobEntries: closed time_entries on the job, each with profiles + time_allocations
 *              (id, job_id, hours — the contents, not just ids).
 *  jobAllocs: time_allocations tagged to the job, each with time_entries.profiles. */
export function computeJobLaborBilling(
  jobEntries: any[],
  jobAllocs: any[],
  defaultRate: number,
  /** The customer's pricing-level labor rate — a CEILING on hourly billing for that
   *  customer tier (Erik 7/24): a person billing ABOVE it drops to it (Erik $150 →
   *  Local $125), a person below keeps their own rate (Brian stays $95). A person
   *  with no rate at all bills the level rate directly. Absent/0 → per-person
   *  bill_rate then org default, as before. (Quotes use the level rate as the single
   *  draft labor rate — different surface, deliberate.) */
  levelRate?: number | null,
): { lines: LaborLine[]; total: number } {
  const rawLevel = Number(levelRate);
  const level = Number.isFinite(rawLevel) && rawLevel > 0 ? rawLevel : 0;
  const rawDefault = Number(defaultRate);
  const def = Number.isFinite(rawDefault) && rawDefault > 0 ? rawDefault : 0;
  // Track the best REAL rate seen for a person (NOT frozen on first-seen — the alloc
  // and entry queries can carry different rate snapshots). Key on id, falling back
  // to name so two distinct rate-less workers don't collapse into one bucket.
  const perPerson = new Map<string, { name: string; realRate: number; hours: number }>();
  const addHours = (prof: any, hrs: number) => {
    if (!(hrs > 0)) return;
    const key = String(prof?.id ?? prof?.full_name ?? "unknown");
    // BILL rate (what the customer is charged), NOT pay. A time entry's rate_override is a
    // PAY-rate override (payroll only — see payRateForEntry) and is intentionally ignored
    // here: paying a tech a supervisor rate doesn't change what the customer is billed.
    const raw = Number(prof?.bill_rate ?? prof?.hourly_rate ?? 0);
    const realRate = Number.isFinite(raw) && raw > 0 ? raw : 0; // 0 = no usable rate on this snapshot
    const cur = perPerson.get(key);
    if (cur) {
      cur.hours += hrs;
      if (realRate > cur.realRate) cur.realRate = realRate;
    } else {
      perPerson.set(key, { name: prof?.full_name ?? "Crew", realRate, hours: hrs });
    }
  };
  // (1) exact hours allocated to this job (handles split shifts)
  const billedAllocIds = new Set<string>();
  for (const a of jobAllocs ?? []) {
    if (a.id) billedAllocIds.add(String(a.id));
    addHours(a.time_entries?.profiles, Number(a.hours ?? 0));
  }
  for (const e of jobEntries ?? []) {
    const allocs = e.time_allocations ?? [];
    if (allocs.length) {
      // (2) this entry is split. Its rows tagged to ANOTHER job aren't ours; its rows
      // tagged to THIS job already came through jobAllocs above (id-dedupe guards a
      // double-count if that query ever widens). What's left is the UNLABELED hours —
      // costed to this entry's job, so billed to it too.
      for (const a of allocs) {
        if (a.job_id) continue;
        // A TIME-CODE part (Drive/Shop/…) also carries job_id NULL, but the editor promises
        // "paid, not billed" — billing it to whichever job the shift was clocked into is the
        // customer paying for drive time. Only genuinely unlabeled hours belong to the job.
        // (Cost still counts them: we DID pay for that hour, so it shows as unbilled cost.)
        if (a.job_code) continue;
        if (a.id && billedAllocIds.has(String(a.id))) continue;
        addHours(e.profiles, Number(a.hours ?? 0));
      }
      continue;
    }
    // (3) un-split closed entries on this job → gross hours
    if (!e.clock_out) continue;
    const lunch = Math.max(0, Number(e.lunch_minutes) || 0); // a negative lunch can't add billable time
    addHours(e.profiles, (new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 3_600_000 - lunch / 60);
  }
  const lines: LaborLine[] = [...perPerson.entries()].map(([personId, p]) => {
    const personal = p.realRate > 0 ? p.realRate : 0;
    const rate = personal > 0 ? (level > 0 ? Math.min(personal, level) : personal) : level > 0 ? level : def;
    const quantity = Math.round(p.hours * 4) / 4; // quarter-hour
    return { personId, name: p.name, rate, rawHours: p.hours, quantity, amount: Math.round(quantity * rate * 100) / 100 };
  });
  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { lines, total };
}

/** The two queries computeJobLaborBilling needs, run against a job_id. Returns
 *  { jobEntries, jobAllocs } ready to pass in. Centralised so import + financials
 *  fetch identical data. */
export async function fetchJobLaborRows(supabase: any, jobId: string): Promise<{ jobEntries: any[]; jobAllocs: any[] }> {
  const [{ data: jobEntries }, { data: jobAllocs }] = await Promise.all([
    supabase
      .from("time_entries")
      // allocation CONTENTS, not just ids: computeJobLaborBilling has to bill the
      // unlabeled (job_id NULL) rows on this job's entries, which the cost side already
      // charges to the job — selecting only ids is what hid a whole unbilled week.
      .select("clock_in, clock_out, lunch_minutes, profiles(id, full_name, hourly_rate, bill_rate), time_allocations(id, job_id, job_code, hours)")
      .eq("job_id", jobId)
      .eq("status", "closed"),
    supabase
      .from("time_allocations")
      .select("id, hours, time_entries!inner(status, profiles(id, full_name, hourly_rate, bill_rate))")
      .eq("job_id", jobId)
      .eq("time_entries.status", "closed"),
  ]);
  return { jobEntries: jobEntries ?? [], jobAllocs: jobAllocs ?? [] };
}

/** The customer's pricing-level labor rate for a JOB (null when the job has no customer,
 *  the customer has no level, or the level has no labor rate). THE one resolver every
 *  labor-billing consumer shares — invoice import, job work-to-date panel, and progress
 *  financials must pass the SAME value or the penny-reconcile promise breaks. */
export async function customerLaborRateForJob(supabase: any, jobId: string): Promise<number | null> {
  const { data } = await supabase
    .from("jobs")
    .select("customers(pricing_levels(labor_rate))")
    .eq("id", jobId)
    .maybeSingle();
  const raw = Number((data as any)?.customers?.pricing_levels?.labor_rate);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** The material markup % to bill a JOB at: the customer's pricing-level markup when the
 *  customer has a level, else the org default. THE one resolver for materials, mirroring
 *  customerLaborRateForJob — the draw/finish-job importers and the work-to-date panel must
 *  all seed from this or a level customer gets billed at the org rate on one path and their
 *  negotiated rate on another (two totals for identical work). A level markup of 0 is a real
 *  answer (bill at cost), so only null/absent falls through to the default. */
export async function customerMaterialMarkupForJob(
  supabase: any,
  jobId: string,
  orgDefaultPct: number,
): Promise<number> {
  const { data } = await supabase
    .from("jobs")
    .select("customers(pricing_levels(markup_pct))")
    .eq("id", jobId)
    .maybeSingle();
  const raw = Number((data as any)?.customers?.pricing_levels?.markup_pct);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  const def = Number(orgDefaultPct);
  return Number.isFinite(def) && def >= 0 ? def : 0;
}
