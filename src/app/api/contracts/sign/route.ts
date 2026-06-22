import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Best-effort in-memory throttle (per IP, per instance). Not distributed, but it caps
// a single-instance hammer; the 128-bit unguessable token is the real defense.
const HITS = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  if (HITS.size > 5000) HITS.clear();
  const h = HITS.get(ip);
  if (!h || now > h.resetAt) {
    HITS.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  h.count += 1;
  return h.count > 8;
}

/** Public endpoint the contract sign page POSTs to. Captures the signer's IP and
 *  user-agent (which a direct browser RPC call can't), then records the signature
 *  via the anon-granted sign_contract RPC. */
export async function POST(req: NextRequest) {
  const { token, name } = await req.json().catch(() => ({}));
  if (!token || !name || !String(name).trim()) {
    return NextResponse.json({ ok: false, error: "Please type your full name to sign." }, { status: 400 });
  }
  const ip =
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "";
  const ua = req.headers.get("user-agent") || "";

  if (rateLimited(ip || "unknown")) {
    return NextResponse.json({ ok: false, error: "Too many attempts — please wait a minute and try again." }, { status: 429 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("sign_contract", {
    p_token: String(token),
    p_name: String(name).trim().slice(0, 120),
    p_ip: ip,
    p_ua: ua.slice(0, 400),
  });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
