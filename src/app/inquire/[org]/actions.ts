"use server";

import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { orgStaffIds } from "@/lib/push";
import { notifyPeople } from "@/lib/notifications";
import { clientIp, rateLimited } from "@/lib/rate-limit";
import { getOrgSettings } from "@/lib/org-settings";
import { requestHref } from "@/lib/feature-doors";

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
): Promise<{ ok: true; leadId?: string } | { ok: false; error: string }> {
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

  // THE LEAD THIS SUBMIT WROTE (cn-v1180, audit A6 and A2). submit_inquiry returns nothing, so the
  // row is read back: this company, this door, the last two minutes, and the exact values this call
  // just sent (the function's own trims). Its id goes back to THIS browser, the one key its "Request
  // a Site Visit" tap attaches by, and the office alert opens that lead's own file.
  const mine = await readBackLead(sb, org, {
    name,
    email: email || null,
    phone: phone || null,
    // As the database stored it: left(btrim(x), 2000) counts CHARACTERS, where a JS slice counts UTF-16
    // units, so a long message with an emoji in it never matched (skeptic #83, S8).
    message: Array.from(String(payload?.message ?? "").trim()).slice(0, 2000).join("") || null,
  });
  void notifyNewInquiry(org, mine);
  return mine ? { ok: true, leadId: mine.id } : { ok: true };
}

type WrittenLead = { id: string; name: string | null; message: string | null; created_at: string | null };

/**
 * The row submit_inquiry just wrote, or null. Matched in JS (nothing typed is built into a filter),
 * newest first, among this company's public-form leads of the last two minutes. Two identical
 * submissions in the same two minutes are the same words from the same door: either id is theirs.
 */
async function readBackLead(
  sb: ReturnType<typeof createServiceClient>,
  orgId: string,
  sent: { name: string; email: string | null; phone: string | null; message: string | null },
): Promise<WrittenLead | null> {
  try {
    const { data } = await sb
      .from("inquiries")
      .select("id, name, email, phone, message, created_at")
      .eq("org_id", orgId)
      .eq("source", "public_form")
      .gte("created_at", new Date(Date.now() - 120_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(25);
    const norm = (v: unknown) => String(v ?? "").trim() || null;
    const hit = ((data ?? []) as (WrittenLead & { email: string | null; phone: string | null })[]).find(
      (r) =>
        norm(r.name) === norm(sent.name.slice(0, 200)) &&
        norm(r.email) === norm(sent.email) &&
        norm(r.phone) === norm(sent.phone) &&
        norm(r.message) === norm(sent.message),
    );
    return hit ? { id: hit.id, name: hit.name, message: hit.message, created_at: hit.created_at } : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget: ping office staff that a new public inquiry just landed.
 * Called by the public inquiry form AFTER submit_inquiry succeeds. The form is
 * anonymous, so this reads the real just-created row with the service client
 * (content can't be spoofed by the caller) and only fires for an inquiry created
 * in the last 2 minutes — bounding any replay of this hook to a real submission.
 *
 * NOT EXPORTED (audit v921): this file is "use server", so an export is a POSTable server action.
 * Exported, it took an org uuid from the caller with no honeypot and no limiter — inside the
 * 2-minute window after any real inquiry, anyone holding the action id could re-fire the push to
 * that tenant's whole office, once per request. It has exactly one caller, right above.
 */
async function notifyNewInquiry(orgId: string, written: WrittenLead | null): Promise<void> {
  try {
    if (!orgId) return;
    const sb = createServiceClient();
    // The row this submit wrote when it was read back; otherwise the company's newest, as before.
    const inq =
      written ??
      ((
        await sb
          .from("inquiries")
          .select("id, name, message, created_at")
          .eq("org_id", orgId)
          // At least THIS door's own rows (skeptic #83, S8): the bell must never name an office lead or
          // another door's, which are not what this alert announces.
          .eq("source", "public_form")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      ).data as WrittenLead | null);
    if (!inq?.created_at) return;
    if (Date.now() - new Date(inq.created_at).getTime() > 120_000) return;

    const who = (inq.name || "Someone").trim();
    const snippet = (inq.message || "").trim().slice(0, 80);
    // LEADS OFF, THE REQUEST STILL LANDS (the switch board, rule d): the push opens My Day, where
    // it waits with Call Back, instead of the switched-off list. Service client: org filtered here.
    const { data: orgRow } = await sb.from("organizations").select("settings").eq("id", orgId).maybeSingle();
    // The bell records it too (notifyPeople): a push missed on the lock screen is still on the bell.
    await notifyPeople(orgId, await orgStaffIds(orgId), "inquiry", {
      title: "New inquiry",
      body: snippet ? `${who}: ${snippet}` : `${who} sent a new request`,
      // Leads on: the lead's own file (cn-v1180, audit A2), the one this submit wrote.
      url: requestHref(getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).features, written?.id),
    });
  } catch {
    /* best-effort — never surface to the public form */
  }
}
