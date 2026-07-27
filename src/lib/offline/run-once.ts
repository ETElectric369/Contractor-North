import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";

/**
 * EXACTLY-ONCE FOR A RETRIED WRITE (0167).
 *
 * The offline queue retries. A retry that isn't idempotent is worse than a lost write: a timeout
 * halfway through a create leaves the row written AND the queue convinced it failed, so the replay
 * makes a second one. Nobody notices until there are two of something.
 *
 * The client mints `clientOpId` before its FIRST attempt and reuses it forever, so "the same
 * operation" is defined by the caller's intent rather than by whatever the server happens to see.
 * The unique index on (org_id, client_op_id) is the actual guarantee; this is the wrapper.
 *
 * ONLINE PATH IS UNCHANGED: with no clientOpId this is a straight call-through, so nothing that
 * exists today pays for a feature it doesn't use.
 */
export async function runOnce<T extends { ok: boolean; id?: string; error?: string }>(
  args: {
    clientOpId?: string | null;
    action: string;
    orgId: string | null | undefined;
    profileId: string | null | undefined;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const { clientOpId, action, orgId, profileId } = args;
  if (!clientOpId || !orgId) return fn();

  const sb = createServiceClient();

  // CLAIM FIRST. The insert is the lock: whoever lands it owns the work, and a concurrent replay
  // trips the unique index instead of racing into a second write.
  const claim = await sb
    .from("client_operations")
    .insert({ org_id: orgId, profile_id: profileId ?? null, client_op_id: clientOpId, action })
    .select("id")
    .maybeSingle();

  if (claim.error) {
    // A duplicate key means this operation already ran (or is running). Return the ORIGINAL
    // result so the caller gets the same answer it would have got the first time.
    const dup = String(claim.error.code ?? "") === "23505";
    if (!dup) {
      // The ledger is unavailable. Failing the WRITE because the bookkeeping failed would be the
      // wrong trade in the field — run it, and accept that a retry in this rare window could
      // duplicate. Recorded, so it isn't invisible.
      reportError("runOnce.claim", claim.error, { action, orgId });
      return fn();
    }
    const { data: prior } = await sb
      .from("client_operations")
      .select("result_id")
      .eq("org_id", orgId)
      .eq("client_op_id", clientOpId)
      .maybeSingle();
    // No result_id yet means the original attempt is still in flight. "Accepted" is the honest
    // answer — the work is happening, and doing it again is exactly what we're preventing.
    return { ok: true, id: (prior as { result_id?: string } | null)?.result_id ?? undefined } as T;
  }

  let res: T;
  try {
    res = await fn();
  } catch (e) {
    // The work failed, so RELEASE the claim — otherwise a genuine failure is permanently
    // remembered as "already done" and the retry that would have fixed it can never run.
    await sb.from("client_operations").delete().eq("id", (claim.data as { id: string }).id);
    throw e;
  }
  if (!res.ok) {
    await sb.from("client_operations").delete().eq("id", (claim.data as { id: string }).id);
    return res;
  }

  await sb
    .from("client_operations")
    .update({ result_id: res.id ?? null, completed_at: new Date().toISOString() })
    .eq("id", (claim.data as { id: string }).id);
  return res;
}
