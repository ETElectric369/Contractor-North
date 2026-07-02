import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";
import { addDocument } from "../actions";

/**
 * THE job-photo upload pipeline (client-side), extracted from the Photos tab so
 * every capture surface — the tab's Take photo/Upload buttons AND the action
 * dock's quick Photo button — files a picture the exact same way:
 * prepareImageForUpload → storage upload → addDocument(category "Photo").
 * Throws on the first failure so the caller can surface it (never silent).
 */
export async function uploadJobPhotos(orgId: string, jobId: string, files: File[]): Promise<void> {
  const supabase = createClient();
  for (const raw of files) {
    const file = await prepareImageForUpload(raw);
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${orgId}/${jobId}/${Date.now()}-${safe}`;
    const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
    if (upErr) throw upErr;
    const res = await addDocument({ job_id: jobId, name: file.name, category: "Photo", file_url: path, size_bytes: file.size });
    if (!res.ok) throw new Error(res.error);
  }
}
