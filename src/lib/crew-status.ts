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
  /** The running entry, so the office can open it straight onto its clock-out sheet (Clock Out Brian). Null off the clock. */
  entryId: string | null;
  /** When that entry clocked in (ISO). Null off the clock. */
  clockIn: string | null;
  /** The entry this piece was cut from at a Switch Job (0288), so a reader can time the SHIFT and
   *  not the piece (audit v994 SW1: lib/shift-chain). Null for a first piece or off the clock. */
  splitFrom: string | null;
};

export async function getCrewStatus(supabase: any): Promise<CrewMember[]> {
  // A RETURNED ERROR IS AN ERROR (skeptic, 2026-10-13). supabase-js hands errors back, it does not
  // throw them, and reading `data` alone turned a refused or timed-out read into an empty crew —
  // "Nobody right now" over three running clocks. Thrown, so every caller's catch says so instead.
  const { data: members, error: membersError } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("active", true)
    .order("full_name");
  if (membersError) throw membersError;
  if (!members?.length) return [];
  const ids = members.map((m: { id: string }) => m.id);
  const { data: open, error: openError } = await supabase
    .from("time_entries")
    .select("id, profile_id, clock_in, split_from, job:job_id(job_number, name)")
    .eq("status", "open")
    .in("profile_id", ids);
  if (openError) throw openError;

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
      entryId: o?.id ?? null,
      clockIn: o?.clock_in ?? null,
      splitFrom: o?.split_from ?? null,
    };
  });
}
