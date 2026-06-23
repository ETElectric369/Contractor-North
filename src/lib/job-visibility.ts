/**
 * Return `jobId` only when it's visible to the caller (the user's RLS-scoped client
 * resolves a foreign-org job to nothing) — otherwise null. Use before writing a
 * job_id onto a row (time entry, bill, …) so a crafted/foreign id can never persist
 * as a cross-org dangling FK. Centralized so clockIn / createManualEntry / createBill
 * can't drift apart.
 */
export async function visibleJobIdOrNull(
  supabase: { from: (t: string) => any },
  jobId: string | null | undefined,
): Promise<string | null> {
  if (!jobId) return null;
  const { data } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
  return data ? jobId : null;
}
