import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "@/lib/observe";

/**
 * WHICH SHOWN PHOTOS THE CUSTOMER NO LONGER SEES (audit v994 PL4). The portal shows a shared photo
 * only while its document still points at the file that was shown and that file's stored version
 * is the one that was shown (0300/0301). A photo overwritten out of the app is hidden from the
 * customer, and the office's tile used to keep saying "Customer Sees It". job_shared_photo_state
 * (0323) answers, for the office of the job's own org, which shares still hold.
 *
 * Returns the ids of shared photos the customer's page has stopped showing. Before 0323 is applied
 * (the function is missing) the answer is "none known": the tiles read as they always did, and
 * nothing claims a photo is fine or broken on a guess. A read that fails for any other reason is
 * the same "none known", and says so in the log.
 */
export async function staleSharedPhotoIds(supabase: SupabaseClient, jobId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("job_shared_photo_state", { p_job_id: jobId });
  if (error) {
    const code = String((error as { code?: string }).code ?? "");
    if (code !== "PGRST202" && code !== "42883") reportError("portal.sharedPhotoState", error, { jobId });
    return [];
  }
  return ((data ?? []) as { document_id: string; still_shown: boolean }[]).filter((r) => r && r.still_shown === false).map((r) => r.document_id);
}
