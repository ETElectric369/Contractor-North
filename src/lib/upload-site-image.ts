"use client";

import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";

/**
 * Upload one image from the browser into the org's PUBLIC branding bucket and return its public URL.
 * The path uses the `portfolio-` prefix so it satisfies BOTH the org-staff storage policy AND the
 * scoped external-collaborator policy (which only allows `<org>/portfolio-*` image files) — so the
 * page-builder upload works from Settings AND the /content workspace. Resizes/strips EXIF via
 * prepareImageForUpload first. Throws on failure (callers surface the message).
 */
export async function uploadSiteImage(orgId: string, file: File): Promise<string> {
  if (!orgId) throw new Error("Missing organization.");
  const prepared = await prepareImageForUpload(file);
  const ext = prepared.type === "image/png" ? "png" : "jpg";
  const path = `${orgId}/portfolio-blk-${Date.now()}-${Math.floor(performance.now())}.${ext}`;
  const supabase = createClient();
  const { error } = await supabase.storage.from("branding").upload(path, prepared, { upsert: true, cacheControl: "3600" });
  if (error) throw error;
  return supabase.storage.from("branding").getPublicUrl(path).data.publicUrl;
}
