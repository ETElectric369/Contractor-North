type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

/** What sweep_error_events (0399) answers: the closed rows and the traces it dropped. */
export type ErrorSweep = { closed_deleted: number; trace_deleted: number };

/**
 * THE SINK KEEPS ONLY WHAT IS STILL NEWS (cn-v1136, 0399): fixed and ignored rows go after their
 * time, traces after a week; new and triaged rows stay until a person moves them. The rule lives in
 * the database (service role only); this is the nightly knock on its door. supabase-js hands a
 * refused call back instead of throwing it, so the error is thrown here — the daily cron files it
 * as cron-error-sweep and the night's answer goes red.
 */
export async function sweepErrorEvents(supabase: RpcClient): Promise<ErrorSweep> {
  const { data, error } = await supabase.rpc("sweep_error_events");
  if (error) throw error;
  const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return { closed_deleted: Number(o.closed_deleted ?? 0), trace_deleted: Number(o.trace_deleted ?? 0) };
}
