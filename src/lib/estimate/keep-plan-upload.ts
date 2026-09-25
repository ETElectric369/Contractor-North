import type { SupabaseClient } from "@supabase/supabase-js";
import { jobLabel } from "@/lib/schedule-options";

/**
 * THE ESTIMATOR'S UPLOAD PLANS KEEPS THE PLANS (Panel plan, phase 4; Erik's decision 3).
 *
 * The estimator's upload arrives through a stash (`<org>/ai-uploads/…`, #116) that was deleted on
 * read, on purpose (audit 7): the same stash carries SUPPLIER QUOTES, whose CED net pricing must
 * never sit where a field tech can list and open it. That rule stands: a supplier quote is still
 * deleted the moment it is read.
 *
 * But Herringbone's plans went the same way, and Read Circuits From The Plans had nothing left to
 * read. So an upload that says it is PLANS (the Upload Plans door, never the Supplier Quote door) is
 * now kept: moved out of the stash into the job's folder (or the customer's, when the estimate has
 * no job yet) and filed as a Plan document on the customer, and on the job when there is one. Plans
 * are the crew's to see (the tech job access law): nothing on them is a price.
 *
 * Nothing silent: the answer says where the plans were kept, or why they weren't ("pick who the
 * estimate is for first"). The same plans uploaded twice are filed once. Not a server action.
 */

/** Is this path the estimator's stash in this org (and nothing else in the org's folder)? */
export function isEstimatorStash(orgId: string | null | undefined, path: string): boolean {
  return !!orgId && path.startsWith(`${orgId}/ai-uploads/`) && !path.includes("..") && path.split("/").length === 3;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JobRow = { id: string; job_number: string | null; name: string | null; customer_id: string | null };

export type KeptPlan = { kept: boolean; words: string; documentId?: string };

export async function keepPlanUpload(
  supabase: SupabaseClient,
  o: { orgId: string; stashPath: string; name: string; size: number; jobId?: unknown; customerId?: unknown; now?: number },
): Promise<KeptPlan> {
  const drop = async () => {
    await supabase.storage.from("documents").remove([o.stashPath]).then(
      () => undefined,
      () => undefined,
    );
  };
  if (!isEstimatorStash(o.orgId, o.stashPath)) return { kept: false, words: "Not kept: the upload wasn't in the estimator's folder." };

  const jobId = typeof o.jobId === "string" && UUID.test(o.jobId) ? o.jobId : null;
  let customerId = typeof o.customerId === "string" && UUID.test(o.customerId) ? o.customerId : null;
  let job: JobRow | null = null;
  if (jobId) {
    const { data } = await supabase.from("jobs").select("id, job_number, name, customer_id").eq("id", jobId).eq("org_id", o.orgId).maybeSingle();
    job = (data as JobRow | null) ?? null;
    if (job && !customerId) customerId = job.customer_id;
  }
  let customerName: string | null = null;
  if (customerId) {
    const { data } = await supabase.from("customers").select("id, name").eq("id", customerId).eq("org_id", o.orgId).maybeSingle();
    if (!data) customerId = null;
    else customerName = (data as { name: string | null }).name;
  }
  if (!job && !customerId) {
    await drop();
    return { kept: false, words: "Not kept: pick who the estimate is for first, then upload the plans again to keep them on file." };
  }
  const where = job ? `on ${jobLabel(job)}` : `on ${customerName?.trim() || "the customer"}'s file`;

  // The same plans twice are filed once (a re-read after a correction is the common case).
  let dup = supabase
    .from("documents")
    .select("id")
    .eq("org_id", o.orgId)
    .eq("category", "Plan")
    .eq("name", o.name)
    .eq("size_bytes", o.size);
  dup = job ? dup.eq("job_id", job.id) : dup.is("job_id", null).eq("customer_id", customerId!);
  const { data: same } = await dup.limit(1);
  if ((same as { id: string }[] | null)?.length) {
    await drop();
    return { kept: true, words: `Already on file as a Plan ${where}.`, documentId: (same as { id: string }[])[0].id };
  }

  const safe = o.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "plans.pdf";
  const dest = job ? `${o.orgId}/${job.id}/${o.now ?? Date.now()}-${safe}` : `${o.orgId}/customers/${customerId}/${o.now ?? Date.now()}-${safe}`;
  const moved = await supabase.storage.from("documents").move(o.stashPath, dest);
  if (moved.error) {
    await drop();
    return { kept: false, words: `Not kept: the file couldn't be filed (${moved.error.message}). Add it on the job's Customer Page tab.` };
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: row, error } = await supabase
    .from("documents")
    .insert({
      org_id: o.orgId,
      job_id: job?.id ?? null,
      customer_id: customerId,
      name: o.name.slice(0, 200),
      category: "Plan",
      kind: "other",
      file_url: dest,
      size_bytes: o.size || null,
      uploaded_by: user?.id ?? null,
    })
    .select("id");
  const id = (row as { id: string }[] | null)?.[0]?.id;
  if (error || !id) {
    await supabase.storage.from("documents").remove([dest]).then(
      () => undefined,
      () => undefined,
    );
    return { kept: false, words: `Not kept: the plan couldn't be filed${error ? ` (${error.message})` : ""}. Add it on the job's Customer Page tab.` };
  }
  return { kept: true, words: `Kept as a Plan ${where}.`, documentId: id };
}
