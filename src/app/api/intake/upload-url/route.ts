import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { clientIp, rateLimited } from "@/lib/rate-limit";
import { INTAKE_BUCKET, MAX_UPLOAD_MB, extOf, isAllowedUpload } from "@/lib/playbook/uploads";

export const runtime = "nodejs";

/**
 * MINT ONE SIGNED UPLOAD SLOT for a stranger on the public intake door.
 *
 * The bytes never come through here. A 100MB plan set would blow Vercel's ~4.5MB request-body
 * limit long before it reached storage (which is why /api/site-chat/upload caps at 4MB), so this
 * route hands back a short-lived signed URL and the browser PUTs the file straight to Supabase.
 * What we keep is the part that matters: WE choose the path, so a caller cannot pick the bucket,
 * the tenant folder, or the extension.
 *
 * FOUR GATES, in order:
 *   1. per-IP rate limit  — an unauthenticated writer always gets one
 *   2. the org resolves by handle
 *   3. THE DOOR IS ACTUALLY ON — a form flagged is_public_intake must exist. An off switch that
 *      still mints upload slots is not an off switch.
 *   4. the EXTENSION is allowlisted and the declared size fits. Extension, not Content-Type:
 *      browsers report DWG as anything from image/vnd.dwg to application/octet-stream, and a
 *      header the client controls is not a gate.
 */
export async function POST(req: Request) {
  if (await rateLimited(`intake-upload:${clientIp(req.headers)}`, 20, 60)) {
    return NextResponse.json({ error: "Too many uploads — try again in a moment." }, { status: 429 });
  }

  let body: { handle?: string; name?: string; size?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const handle = String(body?.handle ?? "").trim();
  const name = String(body?.name ?? "").trim();
  const size = Number(body?.size ?? 0);
  if (!handle || !name) return NextResponse.json({ error: "Bad request." }, { status: 400 });

  if (!isAllowedUpload(name)) {
    return NextResponse.json({ error: "That file type isn't accepted." }, { status: 415 });
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_MB * 1024 * 1024) {
    return NextResponse.json({ error: `Files must be under ${MAX_UPLOAD_MB}MB.` }, { status: 413 });
  }

  const supabase = createServiceClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("settings->>public_handle", handle)
    .limit(1)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Not available." }, { status: 404 });
  const orgId = (org as { id: string }).id;

  // The door must be ON before we open a slot in this org's folder.
  const { data: form } = await supabase
    .from("forms")
    .select("id")
    .eq("org_id", orgId)
    .eq("is_public_intake", true)
    .limit(1)
    .maybeSingle();
  if (!form) return NextResponse.json({ error: "Not available." }, { status: 404 });

  // Per-org daily ceiling — the per-IP limit above is useless against a rotating-IP flood, and
  // storage costs the contractor money.
  if (await rateLimited(`intake-upload-org:${orgId}`, 200, 86400)) {
    return NextResponse.json({ error: "Too many uploads today — please call us instead." }, { status: 429 });
  }

  // OUR path, never theirs: org folder, an unguessable id, and the extension we validated. The
  // original filename is kept only as a suffix so the office sees something human, sanitized to
  // a flat token so it can never introduce a path segment.
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
  const path = `${orgId}/intake/${Date.now()}-${crypto.randomUUID()}-${safe}`;

  const { data, error } = await supabase.storage.from(INTAKE_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return NextResponse.json({ error: "Upload failed — please try again." }, { status: 500 });

  return NextResponse.json({ path: data.path, token: data.token, ext: extOf(name) });
}
