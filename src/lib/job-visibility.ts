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

/**
 * Same guard for a customer id — return it only when the caller's RLS-scoped client can
 * see it (a foreign-org customer resolves to nothing). Use before re-pointing a row onto a
 * customer (quote/invoice reassignment, merge target) so a crafted/foreign id can never
 * persist as a cross-org reference. The twin of visibleJobIdOrNull.
 */
export async function visibleCustomerIdOrNull(
  supabase: { from: (t: string) => any },
  customerId: string | null | undefined,
): Promise<string | null> {
  if (!customerId) return null;
  const { data } = await supabase.from("customers").select("id").eq("id", customerId).maybeSingle();
  return data ? customerId : null;
}

/**
 * Same guard for a job-code template id — return it only when the caller's RLS-scoped
 * client can see it (a foreign-org template resolves to nothing). Use before writing
 * jobs.code_template_id so a job can never reference another org's template.
 */
export async function visibleTemplateIdOrNull(
  supabase: { from: (t: string) => any },
  templateId: string | null | undefined,
): Promise<string | null> {
  if (!templateId) return null;
  const { data } = await supabase.from("job_code_templates").select("id").eq("id", templateId).maybeSingle();
  return data ? templateId : null;
}
