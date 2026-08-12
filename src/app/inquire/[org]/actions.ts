"use server";

import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { clientIp, rateLimited } from "@/lib/rate-limit";

export interface PublicInquiryPayload {
  /** Honeypot — a real person never fills it. */
  hp?: string;
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  ref?: string | null;
}

/**
 * THE PUBLIC INQUIRY DOOR, WITH A CEILING ON IT (audit 6).
 *
 * This was the one public write surface that submitted straight from the BROWSER: the form called
 * `supabase.rpc("submit_inquiry", …)` with the anon key that ships in the bundle, so the honeypot
 * was a client-side `if` an attacker simply doesn't run, and there was no limiter anywhere. The
 * org uuid is in the URL — it is printed on ET Electric's business cards and QR codes — so anyone
 * holding a card could write unbounded rows into that tenant, each one costing a push to every
 * office phone.
 *
 * Every sibling door already had this: /estimate 5/60, /site 10/60, site-chat 15/60,
 * inbound/lead 60/60. This one is now the same shape, in the same order, for the same reasons.
 *
 * ORDER MATTERS. Honeypot FIRST and it returns a silent fake success — a trapped bot must believe
 * it worked and must never consume limiter budget that a real homeowner might need. Then the
 * per-IP ceiling, then the per-org daily backstop, which is what a rotating-IP flood walks into.
 */
export async function submitPublicInquiry(
  orgId: string,
  payload: PublicInquiryPayload,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (payload?.hp) return { ok: true }; // bot trap — pretend success, write nothing

  const name = String(payload?.name ?? "").trim().slice(0, 120);
  if (!name) return { ok: false, error: "Please enter your name." };
  const phone = String(payload?.phone ?? "").trim().slice(0, 40);
  const email = String(payload?.email ?? "").trim().slice(0, 200);
  if (!phone && !email) return { ok: false, error: "Add a phone or email so we can reach you." };

  const ip = clientIp(await headers());
  if (await rateLimited(`inquire:${ip}`, 5, 60))
    return { ok: false, error: "Too many requests — please try again in a moment." };

  const org = String(orgId ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(org)) return { ok: false, error: "That link isn't valid." };

  // THE ROTATING-IP BACKSTOP. rateLimited fails OPEN by default, which is right here — no
  // per-call money is spent, and refusing a real homeowner because a limiter hiccuped is the
  // worse failure. The per-org daily ceiling is what bounds the flood that walks past per-IP.
  if (await rateLimited(`inquire-org:${org}`, 50, 86_400))
    return { ok: false, error: "We've had a lot of requests today — please call us instead." };

  const sb = createServiceClient();
  // The RPC, not a raw insert: submit_inquiry is SECURITY DEFINER and already owns the triage,
  // the org check and the referral validation. Moving the CALL server-side is the whole fix; the
  // rules it enforces stay exactly where they were.
  const { error } = await sb.rpc("submit_inquiry", {
    p_org: org,
    p_name: name,
    p_email: email || null,
    p_phone: phone || null,
    p_message: String(payload?.message ?? "").trim().slice(0, 4000) || null,
    p_address: String(payload?.address ?? "").trim().slice(0, 300) || null,
    p_city: String(payload?.city ?? "").trim().slice(0, 80) || null,
    p_state: String(payload?.state ?? "").trim().slice(0, 40) || null,
    p_zip: String(payload?.zip ?? "").trim().slice(0, 20) || null,
    p_ref: payload?.ref ?? null,
  });
  if (error) return { ok: false, error: "Couldn't send that — please try again." };

  void notifyNewInquiry(org);
  return { ok: true };
}

/**
 * Fire-and-forget: ping office staff that a new public inquiry just landed.
 * Called by the public inquiry form AFTER submit_inquiry succeeds. The form is
 * anonymous, so this reads the real just-created row with the service client
 * (content can't be spoofed by the caller) and only fires for an inquiry created
 * in the last 2 minutes — bounding any replay of this hook to a real submission.
 */
export async function notifyNewInquiry(orgId: string): Promise<void> {
  try {
    if (!orgId) return;
    const sb = createServiceClient();
    const { data: inq } = await sb
      .from("inquiries")
      .select("id, name, message, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!inq?.created_at) return;
    if (Date.now() - new Date(inq.created_at).getTime() > 120_000) return;

    const who = (inq.name || "Someone").trim();
    const snippet = (inq.message || "").trim().slice(0, 80);
    await sendPushToProfiles(await orgStaffIds(orgId), "inquiry", {
      title: "New inquiry",
      body: snippet ? `${who}: ${snippet}` : `${who} sent a new request`,
      url: "/leads",
    });
  } catch {
    /* best-effort — never surface to the public form */
  }
}
