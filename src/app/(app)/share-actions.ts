"use server";

import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings, orgPublicBaseUrl } from "@/lib/org-settings";
import { orgTrade } from "@/lib/org-trade";
import { callerLang } from "@/lib/lang-of";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";

/**
 * THE CALLER'S OWN WORDS (the Ventas-2 wave, cn-v1146): a refusal this file hands a screen comes from
 * lib/words/customers-server (cu_srv_) in the caller's language — profiles.language through lib/lang-of
 * callerLang, read once per call and only when a refusal needs words; English when nobody is signed in
 * or the read fails, byte for byte what it always said. quotes/actions' wordsOf, copied; not exported
 * (a "use server" file exports only async functions).
 */
type Said = { lang: () => Promise<Lang>; say: (key: string, vars?: Record<string, string | number>) => Promise<string> };
const SAID = new WeakMap<object, Said>();
function wordsOf(supabase: unknown, userId?: string | null): Said {
  // The action's own entry (it hands the signed-in id) starts this call's memo; a helper (no id) reads it.
  const memo = supabase && typeof supabase === "object" ? (supabase as object) : null;
  const had = memo ? SAID.get(memo) : undefined;
  if (had && userId === undefined) return had;
  let read: Promise<Lang> | null = null;
  const lang = () => (read ??= callerLang(supabase as Parameters<typeof callerLang>[0], userId));
  const made: Said = { lang, say: async (key, vars) => fillSlots(translator(await lang())(key), vars) };
  if (memo) SAID.set(memo, made);
  return made;
}

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
  const ws = wordsOf(supabase, user?.id ?? null);
  if (!user) return { url: "", qr: "", error: await ws.say("cu_srv_notSignedIn") };
  const { data: prof } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
  const orgId = (prof as { org_id?: string } | null)?.org_id;
  if (!orgId) return { url: "", qr: "", error: await ws.say("cu_srv_noCompany") };

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
    tradeLabel: orgTrade(settings).label || undefined,
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
