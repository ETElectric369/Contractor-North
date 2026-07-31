"use server";

import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings, orgPublicBaseUrl } from "@/lib/org-settings";

/**
 * The signed-in user's personal "request an estimate" share link + QR.
 * The ?ref={profile_id} tags any lead that arrives through it as referred_by
 * this person ("Brian at the bar" → commission is a lookup, not a memory).
 * Available to EVERY role — techs are the street team.
 *
 * Returns the company's own name and trade so the CALLER can write the blurb. It used to be
 * hardcoded to "Need electrical work? Request an estimate here:" — fine for the electrical
 * tenant, wrong for everyone else on the platform: a deck company's crew was handing out a card
 * asking strangers about their electrical work.
 *
 * The URL is built on the ORG'S OWN public base rather than NEXT_PUBLIC_SITE_URL. A referral card
 * that sends a stranger to the software vendor's domain is not the business's card.
 */
export async function getShareLink(): Promise<{
  url: string;
  qr: string;
  orgName?: string;
  tradeLabel?: string;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { url: "", qr: "", error: "Not signed in." };
  const { data: prof } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
  const orgId = (prof as { org_id?: string } | null)?.org_id;
  if (!orgId) return { url: "", qr: "", error: "No company on this account." };

  const { data: org } = await supabase
    .from("organizations")
    .select("name, settings")
    .eq("id", orgId)
    .maybeSingle();
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const url = `${orgPublicBaseUrl(settings)}/inquire/${orgId}?ref=${user.id}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: "#0f172a" } });
  return {
    url,
    qr,
    orgName: (org as { name?: string } | null)?.name ?? undefined,
    tradeLabel: settings.trade_label || undefined,
  };
}

/**
 * The signed-in user's org's PUBLIC base URL ("https://etelectricity.com").
 *
 * Exists because four client components were building customer-facing links from
 * `window.location.origin` — the STAFF member's host, baked into the CUSTOMER's message. That is
 * non-deterministic as well as wrong: the same "pick a time" button produced app.contractornorth.com,
 * a vercel.app preview, or localhost depending on where the office happened to be signed in, so one
 * customer's text and their email could carry two different domains for the same appointment.
 *
 * A customer-facing URL is never derived from the browser. Ask the server whose it is.
 */
export async function orgPublicBase(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "";
  const { data: prof } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
  const orgId = (prof as { org_id?: string } | null)?.org_id;
  if (!orgId) return "";
  const { data: org } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  return orgPublicBaseUrl(getOrgSettings((org as { settings?: unknown } | null)?.settings));
}
