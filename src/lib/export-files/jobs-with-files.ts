import { readAllPages } from "@/lib/read-all-pages";
import { jobSaidLabel } from "@/lib/job-pick-label";
import { customerNamePart } from "@/lib/schedule-options";
import { capturePhotoPaths, inspectionAnswerPaths, isOwnPath } from "./collect";

/**
 * THE JOBS THAT HAVE FILES, NEWEST FIRST (cn-v1138, the "Files By Job" list under Your Data).
 *
 * A job "has files" when a pointer row names one: a documents row, a task's photo, a visit's photo
 * or sheet file, or a pick's picture. The count is DISTINCT keys per job (a task photo that is also
 * a documents row is one file), so the row's "12 Files" is what its zip will hold, give or take what
 * sits in the job's or a visit's folder with no row (the zip walks those folders too). Every read is
 * paged whole or fails; the reader answers a whole list or a failure, never a shorter list.
 *
 * The label is the one the bells use (jobSaidLabel: the place, the number, who), never a bare
 * number. Takes the client it is given: the door hands it the SERVICE client behind
 * requireOwnerExport, every read filtered to the company, because 0366 revokes a visit's
 * inspection_answers column from the signed-in role and the sheet's photos count as the job's files.
 */
export type JobWithFiles = { id: string; label: string; files: number };

export const JOBS_PAGE = 50;
export const JOB_LIST_UNREAD_WORDS = "The job list could not be read. Reload.";

type Rows<T> = { rows: T[]; error: unknown };
// The client's query builder is Supabase's own (typed loosely across the repo); this only chains on it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from(table: string): any };

type DocRow = { job_id: string | null; file_url: string | null };
type TaskRow = { job_id: string | null; photo_path: string | null; done_photo_path: string | null };
type ApptRow = { job_id: string | null; capture: unknown; inspection_answers?: unknown };
type PickRow = { job_id: string | null; file_path: string | null };
type JobRow = {
  id: string;
  job_number: string | null;
  name: string | null;
  created_at: string | null;
  customers?: { name?: string | null; company_name?: string | null } | { name?: string | null; company_name?: string | null }[] | null;
};

/** Distinct file keys per job, from the pointer rows; a key outside the company's prefix counts nothing. */
export function tallyFilesByJob(
  orgId: string,
  rows: { documents: readonly DocRow[]; tasks: readonly TaskRow[]; appointments: readonly ApptRow[]; picks: readonly PickRow[] },
): Map<string, number> {
  const keys = new Map<string, Set<string>>();
  const put = (jobId: string | null | undefined, path: unknown) => {
    if (!jobId || !isOwnPath(orgId, path)) return;
    const set = keys.get(jobId) ?? new Set<string>();
    set.add(path.trim());
    keys.set(jobId, set);
  };
  for (const d of rows.documents) put(d.job_id, d.file_url);
  for (const t of rows.tasks) {
    put(t.job_id, t.photo_path);
    put(t.job_id, t.done_photo_path);
  }
  for (const a of rows.appointments) {
    for (const p of capturePhotoPaths(a.capture)) put(a.job_id, p);
    for (const p of inspectionAnswerPaths(orgId, a.inspection_answers)) put(a.job_id, p);
  }
  for (const k of rows.picks) put(k.job_id, k.file_path);
  const out = new Map<string, number>();
  for (const [jobId, set] of keys) if (set.size > 0) out.set(jobId, set.size);
  return out;
}

/** Newest first; a tie (or no date) falls back to the number, the later number first. */
export function newestFirst(a: Pick<JobRow, "created_at" | "job_number">, b: Pick<JobRow, "created_at" | "job_number">): number {
  const ad = a.created_at ?? "";
  const bd = b.created_at ?? "";
  if (ad !== bd) return ad < bd ? 1 : -1;
  const an = a.job_number ?? "";
  const bn = b.job_number ?? "";
  return an === bn ? 0 : an < bn ? 1 : -1;
}

const CHUNK = 200;

export async function readJobsWithFiles(
  sb: Sb,
  orgId: string,
  page: { offset: number; limit: number },
): Promise<{ ok: true; rows: JobWithFiles[]; total: number } | { ok: false; error: unknown }> {
  const [documents, tasks, appointments, picks] = (await Promise.all([
    readAllPages<DocRow>((f, t) => sb.from("documents").select("job_id, file_url").eq("org_id", orgId).not("job_id", "is", null).not("file_url", "is", null).order("id").range(f, t)),
    readAllPages<TaskRow>((f, t) => sb.from("tasks").select("job_id, photo_path, done_photo_path").eq("org_id", orgId).not("job_id", "is", null).order("id").range(f, t)),
    // A visit's files are its capture photos and its sheet's file slots; a visit with a sheet file
    // and no capture still counts, so neither column is filtered on.
    readAllPages<ApptRow>((f, t) => sb.from("appointments").select("job_id, capture, inspection_answers").eq("org_id", orgId).not("job_id", "is", null).order("id").range(f, t)),
    readAllPages<PickRow>((f, t) => sb.from("job_picks").select("job_id, file_path").eq("org_id", orgId).not("file_path", "is", null).order("id").range(f, t)),
  ])) as [Rows<DocRow>, Rows<TaskRow>, Rows<ApptRow>, Rows<PickRow>];
  const failed = [documents, tasks, appointments, picks].find((r) => r.error);
  if (failed) return { ok: false, error: failed.error };

  const counts = tallyFilesByJob(orgId, { documents: documents.rows, tasks: tasks.rows, appointments: appointments.rows, picks: picks.rows });
  const ids = Array.from(counts.keys());
  if (!ids.length) return { ok: true, rows: [], total: 0 };

  const jobs: JobRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = (await sb
      .from("jobs")
      .select("id, job_number, name, created_at, customers(name, company_name)")
      .eq("org_id", orgId)
      .in("id", chunk)) as { data: JobRow[] | null; error: unknown };
    if (error || !Array.isArray(data)) return { ok: false, error: error ?? new Error("the jobs read returned no rows array") };
    jobs.push(...data);
  }
  jobs.sort(newestFirst);
  const offset = Math.max(0, Math.floor(page.offset || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(page.limit || JOBS_PAGE)));
  const rows = jobs.slice(offset, offset + limit).map((j) => {
    const c = Array.isArray(j.customers) ? j.customers[0] : j.customers;
    return { id: String(j.id), label: jobSaidLabel({ job_number: j.job_number, name: j.name, customer: customerNamePart(c) }), files: counts.get(String(j.id)) ?? 0 };
  });
  return { ok: true, rows, total: jobs.length };
}
