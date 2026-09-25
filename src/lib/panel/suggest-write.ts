import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobCircuit } from "@/lib/types";
import type { ReaderDraft } from "./readers";

/**
 * THE ONE WRITE EVERY READER USES (the panel photo, the plans, Nort): its drafts land as
 * SUGGESTIONS on the job, after the list's last row, and the rows that come back are what the tab
 * shows. The caller's own session writes them (RLS and 0333's guard: the org is the job's, a
 * machine's circuit is a suggestion whatever the request said, only the office writes source
 * 'plan', and a document link rides only on a photo's or a plan's row). Read back in full (the
 * silent-write law): a short answer is said, never passed off as the whole read.
 *
 * Not a server action: nothing a browser can call directly. The doors are panel-actions.ts and the
 * panel.suggest action.
 */
export async function writeSuggestions(
  supabase: SupabaseClient,
  o: { orgId: string; jobId: string; panelId: string | null; documentId: string | null; drafts: ReaderDraft[]; cols: string },
): Promise<{ ok: true; rows: JobCircuit[] } | { ok: false; error: string; code?: string }> {
  if (!o.drafts.length) return { ok: true, rows: [] };
  const { data: last } = await supabase
    .from("job_circuits")
    .select("sort_order")
    .eq("job_id", o.jobId)
    .eq("org_id", o.orgId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  let sort = Number((last as { sort_order?: number } | null)?.sort_order ?? -1) + 1;
  const { data, error } = await supabase
    .from("job_circuits")
    .insert(
      o.drafts.map((d) => ({
        ...d,
        job_id: o.jobId,
        panel_id: o.panelId,
        source_document_id: d.source === "nort" ? null : o.documentId,
        state: "suggested",
        sort_order: sort++,
      })),
    )
    .select(o.cols);
  if (error) return { ok: false, error: error.message, code: error.code };
  const rows = (data ?? []) as unknown as JobCircuit[];
  if (rows.length !== o.drafts.length) {
    return { ok: false, error: `Only ${rows.length} of ${o.drafts.length} suggestions saved. Reload and check the list; a read never adds the same one twice.` };
  }
  return { ok: true, rows };
}
