"use server";

import { requireOwnerExport } from "@/lib/export/guard";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { JOBS_PAGE, JOB_LIST_UNREAD_WORDS, readJobsWithFiles, type JobWithFiles } from "@/lib/export-files/jobs-with-files";

/**
 * THE NEXT PAGE OF FILES BY JOB (cn-v1138): the same guard as the download routes (the owner only,
 * a lapsed owner included; a refusal is its words), the same reader as the first page (the service
 * client behind that guard, filtered to the company — 0366 revokes a visit's answers column from
 * the signed-in role; whole or a failure), the next JOBS_PAGE rows from `offset`.
 */
export async function listJobsWithFiles(offset: number): Promise<{ ok: true; rows: JobWithFiles[]; total: number } | { error: string }> {
  const who = await requireOwnerExport();
  if (!who.ok) return { error: who.words };
  const at = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const svc = createServiceClient();
  const read = await readJobsWithFiles(svc, who.orgId, { offset: at, limit: JOBS_PAGE });
  if (!read.ok) {
    reportError("your-data:list-jobs-with-files", read.error, { orgId: who.orgId, offset: at });
    return { error: JOB_LIST_UNREAD_WORDS };
  }
  return { ok: true, rows: read.rows, total: read.total };
}
