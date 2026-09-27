"use server";

import { aiSpendExceeded } from "@/lib/ai-cost";
import { getAnthropic } from "@/lib/anthropic";
import { featureOn, normalizeFeatures } from "@/lib/features";
import { reportError } from "@/lib/observe";
import { rateLimited } from "@/lib/rate-limit";
import { readWithModel } from "@/lib/site-read/ai-read";
import { extractContact, pageTextForModel, type SiteFields } from "@/lib/site-read/extract";
import { readPublicPage, type ReadFailure } from "@/lib/site-read/fetch-page";
import { FILL_KEYS, gapsFor, mergeModelFields, siteUrl, type FillKey } from "@/lib/site-read/form-fill";
import { requireStaff } from "@/lib/staff-guard";
import { RESOURCE_CATEGORIES } from "./categories";

/**
 * FILL FROM THEIR SITE (Erik 2026-09-27: "in add resources, if i add a link to their site can it
 * autopopulate for me?"). Staff only, like every Resources write.
 *
 * Reads the page (lib/site-read/fetch-page: public addresses only, pinned, capped, 8 seconds), then
 * its own card (extract.ts). Only when that leaves a box the person wants empty, AND Nort is switched
 * on for the company, AND the company is under its month's AI allowance, one small model call reads
 * the rest (ai-read.ts). At the allowance it degrades softly: what the site lists plainly is still
 * filled, and a line says so.
 *
 * WRITES NOTHING. It hands back suggestions; the form fills its empty boxes and the person saves.
 * 20 reads an hour per company, so a pasted list or a script can't turn this into a crawler.
 */

const READS_PER_HOUR = 20;

export type FillFromSiteResult = { ok: true; fields: SiteFields; note?: string } | { ok: false; error: string };

function failureWords(why: ReadFailure, status?: number): string {
  switch (why) {
    case "bad-url":
      return "That doesn't look like a web address. Paste the site's address, like yourcounty.gov/building.";
    case "not-web":
      return "Only a website address (http or https) can be read.";
    case "has-login":
      return "That address has a login in it. Paste the plain site address.";
    case "port":
      return "Couldn't read that site. Paste its plain address, like yourcounty.gov/building.";
    case "private":
      return "That address points inside a private network, so it wasn't read.";
    case "no-such-site":
      return "Couldn't find that site. Check the address.";
    case "timeout":
      return "Couldn't read that site: it took too long to answer. Try again, or type the details in.";
    case "too-many-redirects":
      return "Couldn't read that site: it kept sending us somewhere else.";
    case "not-html":
      return "Couldn't read that site: that link is a file, not a web page.";
    case "http-error":
      if (status === 401 || status === 403 || status === 429) return "Couldn't read that site: it doesn't let apps read it. Type the details in.";
      if (status === 404 || status === 410) return "Couldn't read that site: that page wasn't found. Check the address.";
      return status ? `Couldn't read that site (it answered ${status}). Try again, or type the details in.` : "Couldn't read that site.";
    case "unreachable":
    default:
      return "Couldn't read that site. Check the address, or type the details in.";
  }
}

/** May the model read the rest? "off" = Nort is switched off (say nothing), "allowance" = the month's
 *  AI allowance is used (say so, softly), "on" = go. */
type Db = Extract<Awaited<ReturnType<typeof requireStaff>>, { supabase: unknown }>["supabase"];
async function modelMayRead(supabase: Db, orgId: string): Promise<"on" | "off" | "allowance"> {
  const { data } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  const settings = (data as { settings?: { features?: unknown } | null } | null)?.settings;
  if (!featureOn(normalizeFeatures(settings?.features), "nort")) return "off";
  if (await aiSpendExceeded(orgId)) return "allowance";
  return "on";
}

export async function fillFromSite(input: { url: string; need?: string[] }): Promise<FillFromSiteResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  const { orgId } = ctx;
  if (!orgId) return { ok: false, error: "Your account isn't attached to a company yet." };

  const url = siteUrl(typeof input?.url === "string" ? input.url.slice(0, 2000) : "");
  if (!url) return { ok: false, error: "Type or paste their website first." };
  const need = (Array.isArray(input?.need) ? input.need : FILL_KEYS).filter((k): k is FillKey => (FILL_KEYS as readonly string[]).includes(k));

  if (await rateLimited(`resource-site:${orgId}`, READS_PER_HOUR, 3600)) {
    return { ok: false, error: `Your company has read ${READS_PER_HOUR} sites in the last hour, the most for now. Type the details in, or try again in a bit.` };
  }

  const page = await readPublicPage(url);
  if (!page.ok) return { ok: false, error: failureWords(page.why, page.status) };

  // The extractor is meant to be total, but the page is a stranger's: if it ever throws, say so in
  // words (and report it) rather than letting the browser blame the person's connection.
  let read: ReturnType<typeof extractContact>;
  try {
    read = extractContact(page.html, page.finalUrl);
  } catch (e) {
    reportError("fillFromSite.extract", e, { orgId });
    return { ok: false, error: "Couldn't read that page. Type the details in." };
  }
  const { fields, weak } = read;
  const gaps = gapsFor(need, fields, weak);
  if (!gaps.length) return { ok: true, fields };

  const gate = await modelMayRead(ctx.supabase, orgId);
  if (gate === "allowance") {
    return { ok: true, fields, note: "This month's AI allowance is used up, so only what the site lists plainly was filled." };
  }
  if (gate === "off") return { ok: true, fields };

  let client;
  try {
    client = getAnthropic();
  } catch {
    return { ok: true, fields };
  }
  try {
    const model = await readWithModel({ client, orgId, pageText: pageTextForModel(page.html, page.finalUrl), categories: RESOURCE_CATEGORIES });
    return { ok: true, fields: mergeModelFields(fields, weak, model, gaps) };
  } catch (e) {
    reportError("fillFromSite.model", e, { orgId });
    return { ok: true, fields, note: "Nort couldn't read the rest of the page this time." };
  }
}
