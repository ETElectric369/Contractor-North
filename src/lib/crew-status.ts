/**
 * The boss's live crew picture: for EVERY active member, are they on the clock right now,
 * on which job, and how many hours today. This is the "what's everyone doing" board the owner
 * had no way to see (the timeclock only ever showed your OWN clock). Staff-only at the call
 * site — it reads the whole org's open shifts. Closed hours are computed server-side; the
 * open shift's live time is added on the client so the board ticks (see crew-board.tsx).
 */
export type CrewMember = {
  id: string;
  name: string;
  clockedIn: boolean;
  clockInIso: string | null;
  jobLabel: string | null;
  closedHoursToday: number; // completed shifts today; the live shift is added client-side
};

export async function getCrewStatus(supabase: any, todayStr: string): Promise<CrewMember[]> {
  const { data: members } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("active", true)
    .order("full_name");
  if (!members?.length) return [];
  const ids = members.map((m: { id: string }) => m.id);
  const startToday = `${todayStr}T00:00:00`;
  const [{ data: open }, { data: today }] = await Promise.all([
    supabase
      .from("time_entries")
      .select("profile_id, clock_in, job:job_id(job_number, name)")
      .eq("status", "open")
      .in("profile_id", ids),
    supabase
      .from("time_entries")
      .select("profile_id, clock_in, clock_out, lunch_minutes")
      .gte("clock_in", startToday)
      .in("profile_id", ids),
  ]);

  const openBy = new Map<string, any>();
  for (const o of (open ?? []) as any[]) openBy.set(o.profile_id, o);

  const closed = new Map<string, number>();
  for (const e of (today ?? []) as any[]) {
    if (!e.clock_out) continue; // the open shift is ticked live on the client
    const h =
      (new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 3_600_000 -
      (Number(e.lunch_minutes) || 0) / 60;
    closed.set(e.profile_id, (closed.get(e.profile_id) ?? 0) + Math.max(0, h));
  }

  return members.map((m: { id: string; full_name: string | null }) => {
    const o = openBy.get(m.id);
    const job = o?.job;
    return {
      id: m.id,
      name: m.full_name ?? "—",
      clockedIn: !!o,
      clockInIso: o?.clock_in ?? null,
      jobLabel: job ? `${job.job_number}${job.name ? ` · ${job.name}` : ""}` : null,
      closedHoursToday: Math.round((closed.get(m.id) ?? 0) * 100) / 100,
    };
  });
}
