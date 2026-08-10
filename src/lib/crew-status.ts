/**
 * The boss's live crew presence: for EVERY active member, are they on the clock right now and on
 * which job. This is the "what's everyone doing" glance the owner had no way to see (the timeclock
 * only ever showed your OWN clock). Staff-only at the call site — it reads the whole org's open
 * shifts. Hours are deliberately NOT here anymore — those belong to payroll (/timecards); this
 * board is pure live presence (Erik: the crew-hours table isn't needed anywhere but payroll).
 */
import { jobLabel } from "@/lib/schedule-options";

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
      // THE SSOT, not a fork (cn-v697). The old line built its own label with the NUMBER first,
      // justified by a comment claiming the shared helper "would print J-0012 · undefined" — it
      // would not: schedule-options' jobLabel is `name || num || "Job"`, so it never emits a
      // dangling separator and never emits undefined. That describes jobLabelWithNumber, or a
      // version of jobLabel that predates cn-v590.
      //
      // The cost of the fork was Erik filing the same bug three times — "timecards and all jobs
      // need to be displayed as job name not job number everywhere", twice more in other words.
      // /timecards itself was fixed; this strip across the top of it was still number-led, which
      // is why it kept looking unfixed.
      jobLabel: job ? jobLabel(job) : null,
    };
  });
}
