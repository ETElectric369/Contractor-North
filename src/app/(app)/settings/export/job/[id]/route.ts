import { deflateRawSync } from "node:zlib";
import { NextResponse, type NextRequest } from "next/server";
import { requireOwnerExport } from "@/lib/export/guard";
import { exportDoorRefusal } from "@/lib/export/door";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { getOrgSettings } from "@/lib/org-settings";
import { readAllPages } from "@/lib/read-all-pages";
import { todayStrInTz, wallClockInTz } from "@/lib/tz";
import { fileSafeName } from "@/lib/accountant-workbook";
import { zipResponse } from "@/lib/zip-response";
import { jobSaidLabel } from "@/lib/job-pick-label";
import { customerNamePart } from "@/lib/schedule-options";
import { jobFileRefs, overCap } from "@/lib/export-files/collect";
import { walkFolder } from "@/lib/export-files/list";
import { packFiles } from "@/lib/export-files/pack";
import { recordExport } from "@/lib/export-files/audit";
import { COMPANY_UNREAD_WORDS, FILES_UNLISTED_WORDS, JOB_NOT_HERE_WORDS, JOB_NO_FILES_WORDS, JOB_UNREAD_WORDS, couldNotReadWords, tooBigWords } from "@/lib/export-files/words";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** A refusal, in words, as plain text: the download button reads it and says it on the card. */
const say = (words: string, status: number) =>
  new NextResponse(words, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

const deflate = (b: Uint8Array) => new Uint8Array(deflateRawSync(b));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Customer = { name?: string | null; company_name?: string | null };
type JobRow = { id: string; job_number: string | null; name: string | null; customers?: Customer | Customer[] | null };

/**
 * ONE JOB'S FILES AS A ZIP (cn-v1138). GET /settings/export/job/<id>
 *
 * THE OWNER ONLY, BEFORE ANY READ (lib/export/guard: a lapsed owner passes; nobody else does), then
 * the door's two checks (lib/export/door: no cross-site fetch, ten downloads an hour per company).
 * The job is read under the owner's own company — a job of another company, or none, "isn't here"
 * (404, the same words, so the route tells a stranger nothing). Then the pointers (documents, the
 * tasks' photos, the visits' photos and sheet files, the picks' pictures), the job's own folder and
 * each of its visits' folders on the documents bucket, through the service client with the company
 * named on every read; the refs; the cap in words before a byte is downloaded; the pack, which is
 * whole or nothing; one audit row; the zip, streamed, named for the job and the company's today.
 * Every refusal that is North's own failure (a read, a walk, an object) is filed, never only said.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const who = await requireOwnerExport();
  if (!who.ok) return say(who.words, who.status);
  const { orgId, profileId } = who;
  const door = await exportDoorRefusal(req, orgId);
  if (door) return say(door.words, door.status);
  const { id } = await ctx.params;
  if (!UUID.test(String(id ?? ""))) return say(JOB_NOT_HERE_WORDS, 404);

  let svc: ReturnType<typeof createServiceClient>;
  try {
    svc = createServiceClient();
  } catch (e) {
    reportError("export:job-files:service", e, { orgId });
    return say(COMPANY_UNREAD_WORDS, 503);
  }
  const [orgRead, jobRead] = await Promise.all([
    svc.from("organizations").select("name, settings").eq("id", orgId).maybeSingle(),
    svc.from("jobs").select("id, job_number, name, customers(name, company_name)").eq("org_id", orgId).eq("id", id).maybeSingle(),
  ]);
  const org = orgRead.data as { name?: string | null; settings?: unknown } | null;
  if (orgRead.error || !org) {
    reportError("export:job-files:company", orgRead.error ?? new Error("no company row"), { orgId });
    return say(COMPANY_UNREAD_WORDS, 503);
  }
  if (jobRead.error) {
    reportError("export:job-files:job", jobRead.error, { orgId, jobId: id });
    return say(JOB_UNREAD_WORDS, 503);
  }
  const job = jobRead.data as JobRow | null;
  if (!job) return say(JOB_NOT_HERE_WORDS, 404);
  const tz = getOrgSettings(org.settings).timezone;

  const [documents, tasks, appointments, picks, folder] = await Promise.all([
    readAllPages<{ name: string | null; file_url: string | null; size_bytes: number | null }>((f, t) =>
      svc.from("documents").select("name, file_url, size_bytes").eq("org_id", orgId).eq("job_id", id).order("id").range(f, t),
    ),
    readAllPages<{ photo_path: string | null; done_photo_path: string | null }>((f, t) =>
      svc.from("tasks").select("photo_path, done_photo_path").eq("org_id", orgId).eq("job_id", id).order("id").range(f, t),
    ),
    readAllPages<{ id: string; capture: unknown; inspection_answers: unknown }>((f, t) =>
      svc.from("appointments").select("id, capture, inspection_answers").eq("org_id", orgId).eq("job_id", id).order("id").range(f, t),
    ),
    readAllPages<{ file_path: string | null }>((f, t) => svc.from("job_picks").select("file_path").eq("org_id", orgId).eq("job_id", id).order("id").range(f, t)),
    walkFolder(svc, "documents", `${orgId}/${id}`),
  ]);
  const unlisted = [documents.error, tasks.error, appointments.error, picks.error, folder.ok ? null : folder.error].find((e) => e);
  if (unlisted) {
    reportError("export:job-files:list", unlisted, { orgId, jobId: id });
    return say(FILES_UNLISTED_WORDS, 503);
  }
  // Each visit's own folder (`<org>/appointments/<visit>/`): the inspector's photos and sheet files
  // land there, named by a row or not; the folder is walked so none is missed.
  const visitWalks = await Promise.all(appointments.rows.map((a) => walkFolder(svc, "documents", `${orgId}/appointments/${a.id}`)));
  const visitFailed = visitWalks.find((w) => !w.ok);
  if (visitFailed && !visitFailed.ok) {
    reportError("export:job-files:list", visitFailed.error, { orgId, jobId: id });
    return say(FILES_UNLISTED_WORDS, 503);
  }
  const visits = visitWalks.flatMap((w) => (w.ok ? w.files : []));

  const refs = jobFileRefs({
    orgId,
    jobId: id,
    documents: documents.rows,
    picks: picks.rows,
    tasks: tasks.rows,
    appointments: appointments.rows,
    listing: folder.ok ? folder.files : [],
    visits,
  });
  if (!refs.length) return say(JOB_NO_FILES_WORDS, 404);
  if (overCap(refs)) return say(tooBigWords(), 413);

  // Stamped on the company's own clock: an unzipper reads a zip's time as local time.
  const packed = await packFiles(svc, refs, { deflate, modified: wallClockInTz(tz) });
  if (!packed.ok) {
    if ("overCap" in packed) return say(tooBigWords(), 413);
    reportError("export:job-files:pack", new Error(`${packed.failed} of ${packed.total} objects could not be read`), { orgId, jobId: id });
    return say(couldNotReadWords(packed.failed, packed.total), 503);
  }

  await recordExport(svc, { orgId, userId: profileId, action: "export.job_files", input: { job_id: id, files: packed.files, bytes: packed.bytes.length } });

  const customer = Array.isArray(job.customers) ? job.customers[0] : job.customers;
  const label = jobSaidLabel({ job_number: job.job_number, name: job.name, customer: customerNamePart(customer) });
  return zipResponse(packed.bytes, `${fileSafeName(label)}-files-${todayStrInTz(tz)}.zip`);
}
