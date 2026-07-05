import { NextResponse } from "next/server";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimited, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * PUBLIC image upload for the "Ask Nort" chat — a visitor drops a photo of their panel / job so
 * Nort's vision can read it and the office sees the real thing on the captured lead. Sandboxed:
 * one image per call, image mime types only, size-capped, per-IP rate-limited, org resolved by
 * handle. Stores to the public `lead-uploads` bucket under the org's folder via the SERVICE role
 * (anon can't write there directly) and returns ONLY the public URL — which /api/site-chat then
 * validates against this exact bucket prefix before ever handing it to the model.
 */
// 4MB, deliberately under Vercel's ~4.5MB function request-body limit so an oversized image gets
// OUR friendly message instead of a platform 413. The client pre-shrinks to 2200px JPEG anyway.
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function POST(req: Request) {
  if (await rateLimited(`upload:${clientIp(req.headers)}`, 20, 60)) {
    return NextResponse.json({ error: "Too many uploads — try again in a moment." }, { status: 429 });
  }

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Bad request." }, { status: 400 }); }

  const handle = String(form.get("handle") ?? "");
  const file = form.get("image");
  if (!handle || !(file instanceof File)) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  if (!ALLOWED[file.type]) return NextResponse.json({ error: "Please upload a JPG, PNG, WEBP, or GIF." }, { status: 415 });
  if (!file.size || file.size > MAX_BYTES) return NextResponse.json({ error: "Image must be under 4MB." }, { status: 413 });

  const org = await getPublicOrgByHandle(handle);
  if (!org) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const supabase = createServiceClient();
  const path = `${org.id}/${Date.now()}-${crypto.randomUUID()}.${ALLOWED[file.type]}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error } = await supabase.storage.from("lead-uploads").upload(path, buf, {
    contentType: file.type,
    upsert: false,
  });
  if (error) return NextResponse.json({ error: "Upload failed — please try again." }, { status: 500 });

  const { data } = supabase.storage.from("lead-uploads").getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl });
}
