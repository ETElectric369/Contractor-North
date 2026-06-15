import { createClient } from "@/lib/supabase/server";
import { DayGrid, type DayBlock, type DayPerson } from "./day-grid";

const APPT_LABEL: Record<string, string> = {
  appointment: "Appointment",
  quote: "Quote / estimate",
  meeting: "Meet with client",
  inspection: "Inspection",
  other: "Appointment",
};

export interface ProfileRow {
  id: string;
  full_name: string | null;
  active: boolean;
}

/** Gather every schedulable block (jobs, appointments, clocked time) whose start
 *  falls inside an absolute time window, plus the profile list. Shared by the Day
 *  and Week views so they merge data identically. */
export async function gatherBlocks(
  winStartIso: string,
  winEndIso: string,
): Promise<{ blocks: DayBlock[]; profiles: ProfileRow[] }> {
  const supabase = await createClient();
  const [{ data: profiles }, { data: jobs }, { data: appts }, { data: times }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, active").order("full_name"),
    supabase
      .from("jobs")
      .select("id, name, job_number, assigned_to, scheduled_start, scheduled_end, customers(name)")
      .not("scheduled_start", "is", null)
      .gte("scheduled_start", winStartIso)
      .lt("scheduled_start", winEndIso),
    supabase
      .from("appointments")
      .select("id, type, title, starts_at, ends_at, assigned_to, job_id, customers(name)")
      .gte("starts_at", winStartIso)
      .lt("starts_at", winEndIso)
      .neq("status", "cancelled"),
    supabase
      .from("time_entries")
      .select("id, profile_id, job_id, job_code, clock_in, clock_out, status, jobs(job_number, name)")
      .gte("clock_in", winStartIso)
      .lt("clock_in", winEndIso),
  ]);

  const blocks: DayBlock[] = [];

  for (const j of (jobs ?? []) as any[]) {
    const cust = j.customers?.name as string | undefined;
    blocks.push({
      id: `job-${j.id}`,
      personId: j.assigned_to ?? null,
      kind: "job",
      label: j.name || j.job_number || "Job",
      sublabel: cust && cust !== j.name ? cust : j.job_number,
      startIso: j.scheduled_start,
      endIso: j.scheduled_end ?? null,
      href: `/jobs/${j.id}`,
    });
  }

  for (const a of (appts ?? []) as any[]) {
    blocks.push({
      id: `appt-${a.id}`,
      personId: a.assigned_to ?? null,
      kind: "appt",
      label: a.title || APPT_LABEL[a.type as string] || "Appointment",
      sublabel: a.customers?.name ?? APPT_LABEL[a.type as string] ?? null,
      startIso: a.starts_at,
      endIso: a.ends_at ?? null,
      href: a.job_id ? `/jobs/${a.job_id}` : "/schedule?view=appointments",
    });
  }

  for (const t of (times ?? []) as any[]) {
    const jobName = t.jobs?.name as string | undefined;
    blocks.push({
      id: `time-${t.id}`,
      personId: t.profile_id,
      kind: "time",
      label: jobName ? `On site · ${jobName}` : t.job_code ? `Clocked · ${t.job_code}` : "Clocked in",
      sublabel: t.jobs?.job_number ?? t.job_code ?? null,
      startIso: t.clock_in,
      endIso: t.clock_out ?? null,
      open: t.status === "open" || !t.clock_out,
      href: "/timecards",
    });
  }

  return { blocks, profiles: (profiles ?? []) as ProfileRow[] };
}

/** Columns = active crew, plus anyone referenced by a block (e.g. assigned but
 *  now inactive). Optionally pinned to a single person. */
export function peopleFromBlocks(profiles: ProfileRow[], blocks: DayBlock[], pinned?: string): DayPerson[] {
  const referenced = new Set(blocks.map((b) => b.personId).filter(Boolean) as string[]);
  let people = profiles
    .filter((p) => p.active || referenced.has(p.id))
    .map((p) => ({ id: p.id, name: p.full_name ?? "Unnamed" }));
  if (pinned) people = people.filter((p) => p.id === pinned);
  return people;
}

export function ScheduleLegend() {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-[rgb(var(--glass-tint))]" /> Scheduled job
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-violet-400" /> Appointment
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Clocked time
      </span>
    </div>
  );
}

/** Per-person day timeline: jobs, appointments and clocked time as time-blocks,
 *  one column per crew member. The headline view of the Scheduler. */
export async function DayTimeline({ date }: { date: string }) {
  // Generous ±18h window in absolute time; the client trims to the exact local
  // day, so this stays correct regardless of the server's timezone.
  const base = new Date(`${date}T00:00:00`);
  const winStart = new Date(base.getTime() - 18 * 3600 * 1000).toISOString();
  const winEnd = new Date(base.getTime() + (24 + 18) * 3600 * 1000).toISOString();
  const { blocks, profiles } = await gatherBlocks(winStart, winEnd);
  const people = peopleFromBlocks(profiles, blocks);

  return (
    <div>
      <ScheduleLegend />
      {people.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white py-12 text-center text-sm text-slate-400">
          No active team members yet — add people under Settings → Team to see their day.
        </div>
      ) : (
        <DayGrid people={people} blocks={blocks} dateStr={date} />
      )}
    </div>
  );
}
