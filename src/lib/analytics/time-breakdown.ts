import { hoursBetween } from "@/lib/utils";

/**
 * Where the crew's time actually went — closed hours grouped by JOB and by COST CODE over a recent
 * window. Allocation-aware like laborCostForJob: a split shift's hours land on each allocation's own
 * job + code; an un-split closed entry contributes its gross hours to its own job + code. This is the
 * pivot hours_summary (per-employee, dollarless) doesn't do.
 */
export type HoursBucket = { label: string; hours: number };
export type HoursBreakdown = { totalHours: number; sinceDays: number; byJob: HoursBucket[]; byCode: HoursBucket[] };

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeHoursBreakdown(
  entries: any[],
  sinceMs: number,
  sinceDays: number,
  jobLabelById: Map<string, string>,
): HoursBreakdown {
  const byJob = new Map<string, number>();
  const byCode = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, h: number) => m.set(k, (m.get(k) ?? 0) + h);
  const jobLabel = (id: string | null | undefined) => (id ? jobLabelById.get(id) ?? "(unknown job)" : "(no job)");
  let total = 0;

  for (const e of entries ?? []) {
    if (e.clock_in && new Date(e.clock_in).getTime() < sinceMs) continue; // outside the window
    const allocs = e.time_allocations ?? [];
    if (allocs.length) {
      for (const a of allocs) {
        const h = Number(a.hours ?? 0);
        if (h <= 0) continue;
        add(byJob, jobLabel(a.job_id ?? e.job_id), h);
        add(byCode, a.job_code || e.job_code || "Uncoded", h);
        total += h;
      }
      continue;
    }
    if (e.status === "closed" && e.clock_out) {
      const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
      if (h <= 0) continue;
      add(byJob, jobLabel(e.job_id), h);
      add(byCode, e.job_code || "Uncoded", h);
      total += h;
    }
  }

  const toSorted = (m: Map<string, number>): HoursBucket[] =>
    [...m.entries()].map(([label, hours]) => ({ label, hours: round2(hours) })).sort((a, b) => b.hours - a.hours);

  return { totalHours: round2(total), sinceDays, byJob: toSorted(byJob), byCode: toSorted(byCode) };
}

export async function getHoursBreakdown(supabase: any, sinceDays = 30): Promise<HoursBreakdown> {
  const days = Math.min(365, Math.max(1, Math.round(sinceDays)));
  const since = new Date(Date.now() - days * 86_400_000);
  const [{ data: entries }, { data: jobs }] = await Promise.all([
    supabase
      .from("time_entries")
      .select("job_id, job_code, clock_in, clock_out, lunch_minutes, status, time_allocations(job_id, job_code, hours)")
      .eq("status", "closed")
      .gte("clock_in", since.toISOString()),
    supabase.from("jobs").select("id, job_number, name"),
  ]);
  const labelById = new Map<string, string>();
  for (const j of (jobs ?? []) as any[]) labelById.set(j.id, `${j.job_number} — ${j.name}`);
  return computeHoursBreakdown(entries ?? [], since.getTime(), days, labelById);
}
