import { reportError } from "@/lib/observe";

/**
 * ONE AUDIT ROW PER EXPORT (cn-v1138): the same table and shape the action runner writes
 * (lib/actions/execute.ts auditLog), so "who took the company's data out, and when" is read where
 * every other deed is. A read, risk 1, from the UI; the summary carries counts and ids, never a
 * name or a path. Best-effort: a failed insert is filed and never stops the download.
 */
export type ExportAction = "export.job_files" | "export.company_files";

export type AuditSvc = {
  from(table: string): { insert(row: Record<string, unknown>): { select(cols: string): PromiseLike<{ error: unknown }> } };
};

export async function recordExport(
  svc: AuditSvc,
  p: { orgId: string; userId: string; action: ExportAction; input: Record<string, unknown> },
): Promise<void> {
  try {
    const { error } = await svc
      .from("agent_audit_log")
      .insert({
        org_id: p.orgId,
        user_id: p.userId,
        action: p.action,
        risk: 1,
        effect: "read",
        ok: true,
        error: null,
        input_summary: p.input,
        source: "ui",
      })
      .select("id");
    if (error) throw error;
  } catch (e) {
    reportError("export-files:audit", e, { orgId: p.orgId, action: p.action });
  }
}
