import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Guard for Vercel-Cron endpoints — the cron equivalent of requireStaff(). Verifies the
 * CRON_SECRET bearer token (CONSTANT-TIME, so a byte-by-byte timing side-channel can't leak
 * the secret) and hands back a service-role client. Returns { error: NextResponse } on any
 * failure so the route can `const g = requireCron(request); if ("error" in g) return g.error;`.
 * One definition so the three cron routes can't drift on the secret check or its hardening.
 */
export function requireCron(
  request: Request,
): { supabase: ReturnType<typeof createServiceClient> } | { error: NextResponse } {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { error: NextResponse.json({ error: "CRON_SECRET not configured." }, { status: 503 }) };
  }
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  try {
    return { supabase: createServiceClient() };
  } catch {
    return { error: NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured." }, { status: 500 }) };
  }
}
