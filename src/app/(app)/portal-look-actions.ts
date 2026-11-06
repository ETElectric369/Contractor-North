"use server";

import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";
import { getOrgSettings, orgPublicBaseUrl } from "@/lib/org-settings";
import { hashSecret, newSessionSecret } from "@/lib/portal/code";
import { callerLang } from "@/lib/lang-of";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * SEE WHAT THEY SEE, WITHOUT THEIR CODE (0331). The customer's page now asks each new device for a
 * code emailed to the customer, and the office must never need it (nor send the customer an email
 * by looking). So the office's look goes through a one-use ticket: this action (office staff of the
 * customer's own org; portal_preview_ticket checks again) draws a ticket, stores only its sha256
 * with a 2-minute life, and hands back the URL on the business's own host. /portal/<token>/enter
 * spends the ticket for an 8-hour office session on that one link. The office's looks never count
 * as the customer opening it and are never counted as a signed-in device.
 */
export async function portalOfficeLookUrl(
  customerId: string,
  jobId?: string | null,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  const ws = wordsOf(ctx.supabase, ctx.userId);
  if (!UUID.test(String(customerId ?? ""))) return { ok: false, error: await ws.say("cu_srv_customerNotInBook") };
  if (jobId && !UUID.test(jobId)) return { ok: false, error: await ws.say("cu_srv_jobNotInBook") };

  const ticket = newSessionSecret();
  const [{ data: token, error }, { data: org }] = await Promise.all([
    ctx.supabase.rpc("portal_preview_ticket", { p_customer_id: customerId, p_ticket_hash: hashSecret(ticket) }),
    ctx.supabase.from("organizations").select("settings").eq("id", ctx.orgId ?? "").maybeSingle(),
  ]);
  if (error) return { ok: false, error: dbError(error) };
  if (typeof token !== "string" || !token) return { ok: false, error: await ws.say("cu_srv_pageCouldntOpen") };
  const base = orgPublicBaseUrl(getOrgSettings((org as { settings?: unknown } | null)?.settings));
  const qs = new URLSearchParams({ t: ticket, ...(jobId ? { job: jobId } : {}) });
  return { ok: true, url: `${base}/portal/${token}/enter?${qs.toString()}` };
}
