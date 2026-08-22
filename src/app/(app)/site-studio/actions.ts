"use server";

import { revalidatePath } from "next/cache";
import { DEFAULT_MODEL, getAnthropic } from "@/lib/anthropic";
import { aiSpendExceeded, recordAiUsage } from "@/lib/ai-cost";
import { parseAiJson } from "@/lib/ai-json";
import { dbError } from "@/lib/db-error";
import { getOrgSettings } from "@/lib/org-settings";
import { rateLimited } from "@/lib/rate-limit";
import {
  applySiteDoc,
  coerceSiteDoc,
  diffSiteDoc,
  extractSiteDoc,
  type SiteDoc,
} from "@/lib/site-doc";
import { SECTION_KEYS } from "@/lib/site-blocks";
import { requireStaff } from "@/lib/staff-guard";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * THE DESIGN STUDIO'S VERBS. Versions, never edits: every pass writes a NEW draft row; the live
 * site changes only in publishSiteVersion, which materializes a doc onto organizations.settings
 * — the renderer keeps reading what it has always read, which is why neither live site can break
 * mid-rollout and why rollback is just publishing an older version.
 */

export type StudioResult =
  | { ok: true; id?: string; changes?: string[]; dropped?: string[]; note?: string }
  | { ok: false; error: string };

type VersionRow = { id: string; v: number; doc: unknown; status: string };

async function nextVersionNumber(supabase: SupabaseClient): Promise<number> {
  const { data } = await supabase
    .from("site_versions")
    .select("v")
    .order("v", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Number((data as { v?: number } | null)?.v ?? 0) + 1;
}

/** Snapshot the LIVE site as a new draft version — the seed of every studio session, and the
 *  answer to "someone edited outside the studio": capture, and the drift becomes a version. */
export async function captureSiteVersion(note?: string): Promise<StudioResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Staff only." };
  const { data: org } = await ctx.supabase.from("organizations").select("id, settings").limit(1).maybeSingle();
  if (!org) return { ok: false, error: "Organization not found." };
  const doc = extractSiteDoc((org as { settings?: unknown }).settings);
  const v = await nextVersionNumber(ctx.supabase);
  const { data: row, error } = await ctx.supabase
    .from("site_versions")
    .insert({ v, doc, status: "draft", note: (note ?? "Captured from the live site").slice(0, 200), created_by: ctx.userId })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/site-studio");
  return { ok: true, id: (row as { id: string }).id };
}

/**
 * ONE DESIGN PASS: an instruction in plain words → a new draft version. The model proposes a
 * whole doc; coerceSiteDoc is the trust boundary (own-library images only, on-site links only,
 * reviews untouchable, every string clamped) and everything it refuses is NAMED in the result.
 */
export async function designSitePass(instruction: string, baseVersionId: string | null): Promise<StudioResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Staff only." };
  const ask = String(instruction ?? "").trim().slice(0, 2000);
  if (!ask) return { ok: false, error: "Tell it what to change first." };
  if (await rateLimited(`site-designer:${ctx.userId}`, 15, 900, { failClosed: true }))
    return { ok: false, error: "A lot of design passes in a row — give it a minute." };
  if (await aiSpendExceeded(ctx.orgId)) {
    return { ok: false, error: "Your company has reached this month's AI ceiling — it resets at the start of the month." };
  }

  const { data: org } = await ctx.supabase
    .from("organizations")
    .select("id, name, phone, license, settings")
    .limit(1)
    .maybeSingle();
  if (!org) return { ok: false, error: "Organization not found." };
  const settings = getOrgSettings((org as { settings?: unknown }).settings);

  // The base: a chosen version, else the live site. Stored docs share the settings key-space,
  // so extractSiteDoc reads them with the same tolerant merge.
  let base: SiteDoc;
  if (baseVersionId) {
    const { data: ver } = await ctx.supabase
      .from("site_versions")
      .select("id, doc")
      .eq("id", baseVersionId)
      .maybeSingle();
    if (!ver) return { ok: false, error: "That version wasn't found." };
    base = extractSiteDoc((ver as { doc: unknown }).doc);
  } else {
    base = extractSiteDoc((org as { settings?: unknown }).settings);
  }

  const library = [
    ...(base.splash_bg_url ? [{ url: base.splash_bg_url, caption: "(current hero background)" }] : []),
    ...base.portfolio.map((p) => ({ url: p.url, caption: p.caption ?? "" })),
  ];

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 8192,
      system:
        `You are the design lead for a ${settings.trade_label?.trim() || "contractor"}'s public website, working INSIDE a fixed design system. You edit a SITE DOCUMENT (JSON) that a trusted renderer draws — you never write HTML pages.\n` +
        "THE LAWS:\n" +
        "· Copy serves a local contractor's customers: plain, confident, specific about the work and the towns. No hype, no invented claims, no invented credentials or reviews.\n" +
        "· IMAGES: use ONLY urls from the IMAGE LIBRARY, verbatim. You may reorder, re-caption, choose the hero, build galleries — never invent or modify a url.\n" +
        "· LINKS in buttons/banners must be on-site: '#contact-form' (the lead form anchor) or a path starting '/'. Never external.\n" +
        "· reviews, google_business_url and calendly_url are wiring — return them EXACTLY as given.\n" +
        "· Never remove the customer's ability to make contact: if you compose home_blocks, include a {type:'section',props:{key:'contact'}} block (and 'estimate' where it fits).\n" +
        "DOCUMENT FIELDS: splash_headline (the H1 + Google title — keep it keyword-real: trade + place), splash_tagline (the meta-description-ish line, ≤160 chars ideally), splash_bg_url (hero image url from library or \"\"), splash_bullets (the services list, ONE service per line, plain text), splash_credentials (license/insurance line), splash_headline_size ('s'|'m'|'l'), show_name_with_logo (bool), specialty_headline + specialty_blurb (the signature-work section), service_area (towns, ' · ' separated), site_theme ('classic'|'bold'|'minimal' — hero framing), social_instagram (handle only), portfolio (ordered [{url, caption}] from the library — order matters, first is the fallback hero), home_blocks (the page body below the hero; [] means the standard template: specialty, services grid, photos, reviews, estimate, contact).\n" +
        "HOME_BLOCKS PALETTE: {type:'heading',props:{text,align?}}, {type:'text',props:{html}} (simple p/strong/em/ul/li html only), {type:'image',props:{url,alt,caption}}, {type:'button',props:{label,href,align?}}, {type:'gallery',props:{images:[{url,alt}]}}, {type:'banner',props:{bgUrl,heading,text?,buttonLabel?,buttonHref?}}, {type:'section',props:{key:'" +
        SECTION_KEYS.join("'|'") +
        "'}} (live org sections). Optional style per block: {align,size:'s'|'m'|'l'|'xl',font:'sans'|'serif'|'mono',color:'#rrggbb'}.\n" +
        'Respond with ONLY a JSON object: {"doc": {<the COMPLETE document, every field>}, "changes": ["what changed and why, one plain sentence each — the owner reads these"], "note": "≤12 words naming this version"}. No prose outside the JSON.',
      messages: [
        {
          role: "user",
          content:
            `THE BUSINESS: ${String((org as { name?: string }).name ?? "")}` +
            `${(org as { license?: string | null }).license ? ` · ${(org as { license: string }).license}` : ""}` +
            `${settings.public_city ? ` · ${settings.public_city}, ${settings.public_state ?? ""}` : ""}` +
            ` · trade: ${settings.trade_label?.trim() || "contractor"}\n\n` +
            `THE CURRENT DOCUMENT:\n${JSON.stringify(base)}\n\n` +
            `IMAGE LIBRARY (the ONLY usable urls):\n${library.map((i, n) => `${n + 1}. ${i.url}${i.caption ? ` — ${i.caption}` : ""}`).join("\n") || "(no photos yet — design without imagery)"}\n\n` +
            `THE OWNER'S INSTRUCTION:\n"""${ask}"""`,
        },
      ],
    });
    void recordAiUsage({ orgId: ctx.orgId, model: DEFAULT_MODEL, surface: "site-designer", usage: msg.usage as never });
    if (msg.stop_reason === "max_tokens")
      return { ok: false, error: "That pass ran long — ask for the change in smaller steps." };
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    const parsed = (await parseAiJson(client, text, ctx.orgId)) as {
      doc?: unknown;
      changes?: unknown;
      note?: unknown;
    };
    const { doc, dropped } = coerceSiteDoc(parsed.doc, base);
    const changes = Array.isArray(parsed.changes)
      ? parsed.changes.map((c) => String(c).trim()).filter(Boolean).slice(0, 20)
      : [];
    const note = String(parsed.note ?? "Design pass").replace(/\s+/g, " ").trim().slice(0, 120) || "Design pass";

    const v = await nextVersionNumber(ctx.supabase);
    const { data: row, error } = await ctx.supabase
      .from("site_versions")
      .insert({ v, doc, status: "draft", note, created_by: ctx.userId })
      .select("id")
      .single();
    if (error) return { ok: false, error: dbError(error) };
    revalidatePath("/site-studio");
    return { ok: true, id: (row as { id: string }).id, changes, dropped, note };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The design pass failed.";
    return {
      ok: false,
      error: /ANTHROPIC_API_KEY/i.test(message) ? "AI isn't configured on this server." : `Design pass failed: ${message.slice(0, 300)}`,
    };
  }
}

/**
 * GO LIVE: materialize a version's doc onto the live settings. The one write the public ever
 * sees. Archives the previously-published version in the same action; the unique partial index
 * makes a double-publish race lose loudly instead of leaving two "live" rows.
 */
export async function publishSiteVersion(versionId: string): Promise<StudioResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Staff only." };
  const { data: ver } = await ctx.supabase
    .from("site_versions")
    .select("id, v, doc, status")
    .eq("id", versionId)
    .maybeSingle();
  if (!ver) return { ok: false, error: "That version wasn't found." };
  const doc = extractSiteDoc((ver as VersionRow).doc);

  const { data: org } = await ctx.supabase.from("organizations").select("id, settings").limit(1).maybeSingle();
  if (!org) return { ok: false, error: "Organization not found." };
  const merged = applySiteDoc((org as { settings?: unknown }).settings, doc);

  const { data: wrote, error: wErr } = await ctx.supabase
    .from("organizations")
    .update({ settings: merged, updated_at: new Date().toISOString() })
    .eq("id", (org as { id: string }).id)
    .select("id");
  if (wErr) return { ok: false, error: dbError(wErr) };
  if (!wrote?.length) return { ok: false, error: "The publish didn't land — try again." };

  // Old live version steps down, this one steps up. Order matters for the partial unique index.
  await ctx.supabase.from("site_versions").update({ status: "archived" }).eq("status", "published");
  const { error: pErr } = await ctx.supabase
    .from("site_versions")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", versionId);
  if (pErr) return { ok: false, error: `The site is live, but the version bookkeeping failed: ${dbError(pErr)}` };
  revalidatePath("/site-studio");
  return { ok: true };
}

/** A draft that didn't work out. Draft-only — published/archived rows are the history. */
export async function discardSiteVersion(versionId: string): Promise<StudioResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Staff only." };
  const { data, error } = await ctx.supabase
    .from("site_versions")
    .delete()
    .eq("id", versionId)
    .eq("status", "draft")
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Only drafts can be discarded — published versions are the history." };
  revalidatePath("/site-studio");
  return { ok: true };
}

/** The studio page's data: versions + the live doc + drift vs the published version. */
export async function studioState(): Promise<
  | {
      ok: true;
      handle: string | null;
      versions: { id: string; v: number; note: string | null; status: string; created_at: string }[];
      liveDrift: string[];
    }
  | { ok: false; error: string }
> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Staff only." };
  const [{ data: org }, { data: versions }] = await Promise.all([
    ctx.supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    ctx.supabase
      .from("site_versions")
      .select("id, v, note, status, created_at, doc")
      .order("v", { ascending: false })
      .limit(50),
  ]);
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const liveDoc = extractSiteDoc((org as { settings?: unknown } | null)?.settings);
  const published = (versions ?? []).find((r) => (r as VersionRow).status === "published") as VersionRow | undefined;
  const liveDrift = published ? diffSiteDoc(extractSiteDoc(published.doc), liveDoc) : [];
  return {
    ok: true,
    handle: settings.public_handle?.trim() || null,
    versions: (versions ?? []).map((r) => ({
      id: (r as VersionRow).id,
      v: (r as VersionRow).v,
      note: (r as { note?: string | null }).note ?? null,
      status: (r as VersionRow).status,
      created_at: String((r as { created_at?: string }).created_at ?? ""),
    })),
    liveDrift,
  };
}
