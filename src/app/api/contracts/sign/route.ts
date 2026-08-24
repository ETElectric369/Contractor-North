import { dbError } from "@/lib/db-error";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

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

/**
 * Public endpoint the contract sign page POSTs to. Captures the signer's IP and user-agent off
 * the request Vercel actually received, then records the signature via sign_contract.
 *
 * THIS COMMENT USED TO CLAIM a direct browser RPC call couldn't set those fields. It always
 * could — 0068 grants sign_contract to anon, so anyone holding the token could call PostgREST
 * directly and choose its own IP, permanently, because the signature record is frozen on write.
 * 0219 makes the database honour p_ip/p_ua ONLY for a service-role caller, so this route is now
 * the notary rather than a formality: signing anywhere else records NULL evidence instead of
 * chosen evidence. Hence the admin client below — with the anon client, the IP we observed would
 * be discarded along with everyone else's.
 */
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

  // Fall back to the anon client if the service key isn't provisioned: the customer still signs,
  // the evidence fields just come back NULL. A missing env var must never be a locked door on the
  // one page where somebody is trying to agree to pay us.
  const supabase = adminConfigured() ? createAdminClient() : await createClient();
  const { data, error } = await supabase.rpc("sign_contract", {
    p_token: String(token),
    p_name: String(name).trim().slice(0, 120),
    p_ip: ip,
    p_ua: ua.slice(0, 400),
  });
  if (error) return NextResponse.json({ ok: false, error: dbError(error) }, { status: 500 });
  return NextResponse.json(data);
}
