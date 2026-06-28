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
 *  (2) un-split closed entries on the job (gross hours). Rate = bill_rate ??
 *  hourly_rate ?? default_labor_rate. Quantity is rounded to the quarter hour
 *  PER PERSON (so a 2.6h person bills 2.5h, matching the printed line).
 *
 *  jobEntries: closed time_entries on the job, each with profiles + time_allocations.
 *  jobAllocs: time_allocations tagged to the job, each with time_entries.profiles. */
export function computeJobLaborBilling(
  jobEntries: any[],
  jobAllocs: any[],
  defaultRate: number,
): { lines: LaborLine[]; total: number } {
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
  for (const a of jobAllocs ?? []) addHours(a.time_entries?.profiles, Number(a.hours ?? 0));
  // (2) un-split closed entries on this job → gross hours
  for (const e of jobEntries ?? []) {
    if ((e.time_allocations?.length ?? 0) > 0 || !e.clock_out) continue;
    const lunch = Math.max(0, Number(e.lunch_minutes) || 0); // a negative lunch can't add billable time
    addHours(e.profiles, (new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 3_600_000 - lunch / 60);
  }
  const lines: LaborLine[] = [...perPerson.entries()].map(([personId, p]) => {
    const rate = p.realRate > 0 ? p.realRate : def; // default rate only if no real rate anywhere
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
      .select("clock_in, clock_out, lunch_minutes, profiles(id, full_name, hourly_rate, bill_rate), time_allocations(id)")
      .eq("job_id", jobId)
      .eq("status", "closed"),
    supabase
      .from("time_allocations")
      .select("hours, time_entries!inner(status, profiles(id, full_name, hourly_rate, bill_rate))")
      .eq("job_id", jobId)
      .eq("time_entries.status", "closed"),
  ]);
  return { jobEntries: jobEntries ?? [], jobAllocs: jobAllocs ?? [] };
}
