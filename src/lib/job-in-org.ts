/**
 * IS THIS JOB ONE OF OURS? For a write that takes a job id from the browser and stamps it onto a
 * row of this org's (audit v994 TL2: Organize's File It wrote a bill and a document naming whatever
 * job id the call carried). Scoped twice: the caller's RLS client can only see its own org's jobs,
 * and the org is named explicitly as well, so the answer does not rest on one read path. The
 * database refuses the write too (0340); this is what lets the door say so in a sentence first.
 *
 * A failed read answers false: a job this door cannot confirm is not written.
 */
export async function jobInOrg(
  supabase: { from: (t: string) => any },
  orgId: string | null | undefined,
  jobId: string | null | undefined,
): Promise<boolean> {
  if (!jobId || !orgId) return false;
  const { data, error } = await supabase.from("jobs").select("id").eq("id", jobId).eq("org_id", orgId).maybeSingle();
  return !error && !!data;
}
