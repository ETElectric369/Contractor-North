/**
 * The boss's live crew presence: for EVERY active member, are they on the clock right now and on
 * which job. This is the "what's everyone doing" glance the owner had no way to see (the timeclock
 * only ever showed your OWN clock). Staff-only at the call site — it reads the whole org's open
 * shifts. Hours are deliberately NOT here anymore — those belong to payroll (/timecards); this
 * board is pure live presence (Erik: the crew-hours table isn't needed anywhere but payroll).
 */
export type CrewMember = {
  id: string;
  name: string;
  clockedIn: boolean;
  jobLabel: string | null;
};

export async function getCrewStatus(supabase: any): Promise<CrewMember[]> {
  const { data: members } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("active", true)
    .order("full_name");
  if (!members?.length) return [];
  const ids = members.map((m: { id: string }) => m.id);
  const { data: open } = await supabase
    .from("time_entries")
    .select("profile_id, job:job_id(job_number, name)")
    .eq("status", "open")
    .in("profile_id", ids);

  const openBy = new Map<string, any>();
  for (const o of (open ?? []) as any[]) openBy.set(o.profile_id, o);

  return members.map((m: { id: string; full_name: string | null }) => {
    const o = openBy.get(m.id);
    const job = o?.job;
    return {
      id: m.id,
      name: m.full_name ?? "—",
      clockedIn: !!o,
      // Deliberately NOT schedule-options' jobLabel: this omits the " · " when a job
      // has no name (the shared shape would print "J-0012 · undefined" on the board).
      jobLabel: job ? `${job.job_number}${job.name ? ` · ${job.name}` : ""}` : null,
    };
  });
}
