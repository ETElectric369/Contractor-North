/**
 * ONE WAY A FILE GOES UP ONTO A JOB: prep, a path under the org and the job, the private
 * `documents` bucket. Nothing else: no documents row, no reader.
 *
 * Two pipelines stand on it. The receipt pipeline (lib/receipt-capture) files the paper as a
 * Receipt and may have Nort read it into a cost; the plans door (the Customer Page tab's Plans And
 * Drawings) files it as a Plan through filePlan, which never reads anything. They share this step
 * so a plan and a receipt land in the same folder the same way, and the portal's "is it in the
 * job's folder" check (isJobPhotoPath) holds for both.
 */

import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";

export type UploadedJobFile =
  | { ok: true; path: string; name: string; size: number }
  | { ok: false; error: string };

/** Where a job's file lives in the bucket: `<org>/<job>/<ms>-<safe name>`. */
export function jobFilePath(orgId: string, jobId: string, name: string, now = Date.now()): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${orgId}/${jobId}/${now}-${safe}`;
}

/**
 * Prep → upload. A failure comes back as a lowercase clause ("didn't upload (…)") so a door can
 * lead with the file's name and still read as one sentence.
 */
export async function uploadJobFile(o: { orgId: string; jobId: string; file: File; fallbackName?: string }): Promise<UploadedJobFile> {
  // Prep is best-effort: it hands back the original when it can't decode, and if it throws the
  // server's own refusal is the honest explanation, so the raw file still goes up.
  let file = o.file;
  try {
    file = await prepareImageForUpload(o.file);
  } catch {
    file = o.file;
  }
  const name = file.name || o.file.name || o.fallbackName || "file.jpg";
  const path = jobFilePath(o.orgId, o.jobId, name);
  const { error } = await createClient().storage.from("documents").upload(path, file, { upsert: false });
  if (error) return { ok: false, error: `didn't upload (${error.message})` };
  return { ok: true, path, name, size: file.size };
}
