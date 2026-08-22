"use server";

import { revalidatePath } from "next/cache";
import { DEFAULT_MODEL, getAnthropic } from "@/lib/anthropic";
import { aiSpendExceeded, recordAiUsage } from "@/lib/ai-cost";
import { parseAiJson } from "@/lib/ai-json";
import { dbError } from "@/lib/db-error";
import { getOrgSettings } from "@/lib/org-settings";
import { rateLimited } from "@/lib/rate-limit";
import { coerceSiteDoc, diffSiteDoc, extractSiteDoc, knownImageUrls, type SiteDoc } from "@/lib/site-doc";
import { SECTION_KEYS } from "@/lib/site-blocks";
import { requireStaff } from "@/lib/staff-guard";
import { sanitizeModelHtml } from "@/lib/sanitize-html";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * THE DESIGN STUDIO'S VERBS. Versions, never edits: every pass writes a NEW draft row; the live
 * site changes only in publishSiteVersion, which materializes a doc onto organizations.settings
 * — the renderer keeps reading what it has always read, which is why neither live site can break
 * mid-rollout and why rollback is just publishing an older version.
 */

export type StudioResult =
  | { ok: true; id?: string; changes?: string[]; dropped?: string[]; cannot?: string[]; note?: string }
  | { ok: false; error: string };

type VersionRow = { id: string; v: number; doc: unknown; status: string };

/**
 * Insert a version with a per-org sequence number. select-max+1 races against a concurrent
 * insert and the unique(org_id, v) makes the loser ERROR — which must never cost the caller
 * the work (a design pass has already paid for its model call by the time it inserts), so the
 * loser re-reads and retries a couple of times before giving up.
 */
async function insertVersion(
  supabase: SupabaseClient,
  fields: { doc: unknown; note: string; created_by: string | null },
): Promise<{ id: string } | { error: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: top } = await supabase
      .from("site_versions")
      .select("v")
      .order("v", { ascending: false })
      .limit(1)
      .maybeSingle();
    const v = Number((top as { v?: number } | null)?.v ?? 0) + 1;
    const { data: row, error } = await supabase
      .from("site_versions")
      .insert({ v, doc: fields.doc, status: "draft", note: fields.note, created_by: fields.created_by })
      .select("id")
      .single();
    if (!error) return { id: (row as { id: string }).id };
    if ((error as { code?: string }).code !== "23505") return { error: dbError(error) };
  }
  return { error: "Couldn't number the new version — try again." };
}

/** Snapshot the LIVE site as a new draft version — the seed of every studio session, and the
 *  answer to "someone edited outside the studio": capture, and the drift becomes a version. */
export async function captureSiteVersion(note?: string): Promise<StudioResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Staff only." };
  const { data: org } = await ctx.supabase.from("organizations").select("id, settings").limit(1).maybeSingle();
  if (!org) return { ok: false, error: "Organization not found." };
  const doc = extractSiteDoc((org as { settings?: unknown }).settings);
  const ins = await insertVersion(ctx.supabase, {
    doc,
    note: (note ?? "Captured from the live site").slice(0, 200),
    created_by: ctx.userId,
  });
  if ("error" in ins) return { ok: false, error: ins.error };
  revalidatePath("/site-studio");
  return { ok: true, id: ins.id };
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

  // EVERY image the org owns on its site — hero, portfolio, and images already placed in blocks
  // by the old builder (review: the first cut omitted block images, so a pass would lose them).
  const captions = new Map(base.portfolio.map((p) => [p.url, p.caption ?? ""]));
  if (base.splash_bg_url && !captions.has(base.splash_bg_url)) captions.set(base.splash_bg_url, "(current hero background)");
  const library = [...knownImageUrls(base)].map((url) => ({ url, caption: captions.get(url) ?? "" }));

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 12288,
      system:
        `You are the design lead for a ${settings.trade_label?.trim() || "contractor"}'s public website, working INSIDE a fixed design system. You edit a SITE DOCUMENT (JSON) that a trusted renderer draws — you never write HTML pages.\n` +
        "THE LAWS:\n" +
        "· Copy serves a local contractor's customers: plain, confident, specific about the work and the towns. No hype, no invented claims, no invented credentials or reviews.\n" +
        "· IMAGES: use ONLY urls from the IMAGE LIBRARY, verbatim. You may reorder, re-caption, choose the hero, build galleries — never invent or modify a url.\n" +
        "· LINKS in buttons/banners must be on-site: '#contact-form' (the lead form anchor) or a path starting '/'. Never external.\n" +
        "· reviews, google_business_url and calendly_url are wiring — return them EXACTLY as given.\n" +
        "· Never remove the customer's ability to make contact: if you compose home_blocks, include a {type:'section',props:{key:'contact'}} block (and 'estimate' where it fits).\n" +
        "WHAT EACH FIELD ACTUALLY RENDERS (never guess these semantics — a wrong-lever change reads as 'it didn't understand me'):\n" +
        "· site_theme is THE HERO FRAMING and nothing else. 'classic' = the hero IMAGE full-bleed BEHIND the headline with a dark overlay (the photo-backdrop look). 'bold' = dark accent-gradient background, two columns, photo as a framed card on the right. 'minimal' = light airy background, two columns, photo right. The page below the hero is identical across themes.\n" +
        "· splash_bg_url = the hero image; when it is \"\", the FIRST portfolio photo is the hero AND the link-preview image — so portfolio order matters.\n" +
        "· site_accent = '#rrggbb': the ONE color every band, button and gradient leans on ('' = the default derivation). The single biggest mood lever you have.\n" +
        "· site_font = 'default'|'serif'|'grotesk'|'soft': the HEADING typeface preset (serif=editorial Fraunces, grotesk=modern Space Grotesk, soft=rounded Nunito). Headings only; body text is fixed.\n" +
        "· site_density = 'default'|'compact'|'airy': the WHOLE PAGE's vertical rhythm (all section paddings rescale together). For breathing room on ONE section, use style.pad on that section block instead.\n" +
        "· estimate_cta_label (≤40 chars) = the wording on EVERY estimate button — header, hero, bands, footer. '' = the built-in wording.\n" +
        "· home_blocks = ONLY the page body BELOW the hero. [] = the standard template (specialty, services grid, photos, reviews, estimate, contact). Non-empty replaces those bands with your blocks.\n" +
        "· splash_headline (the H1 + Google title — keyword-real: trade + place), splash_tagline (meta-description-ish, ≤160 chars ideally), splash_bullets (services, ONE per line), splash_credentials (license line), splash_headline_size ('s'|'m'|'l'), show_name_with_logo (bool), specialty_headline/specialty_blurb (signature-work section), service_area (towns, ' · ' separated), social_instagram (handle only), portfolio (ordered [{url, caption}] from the library).\n" +
        "WHAT NO FIELD CONTROLS (be honest, never fake the nearest thing): body-text fonts and letter-spacing (headings ARE controllable via site_font), page backgrounds outside the hero, animations, nav layout, footer layout, the trust band, page URLs. (Spacing IS controllable now: site_density for the whole page, style.pad per block/section. Side-by-side image+text IS controllable: the split block.) When the owner asks for one of these, name it in \"cannot\" in plain words and change only what they ALSO asked for.\n" +
        "HOME_BLOCKS PALETTE: {type:'heading',props:{text,align?}}, {type:'text',props:{html}} (simple p/strong/em/ul/li html only), {type:'image',props:{url,alt,caption}}, {type:'button',props:{label,href,align?}}, {type:'gallery',props:{images:[{url,alt}]}}, {type:'banner',props:{bgUrl,heading,text?,buttonLabel?,buttonHref?}}, {type:'split',props:{url,heading,html,imageSide:'left'|'right'}} (image BESIDE text, side by side — the un-stacked layout; stacks on phones), {type:'section',props:{key:'" +
        SECTION_KEYS.join("'|'") +
        "'}} (live org sections — 'services' renders the what-we-do grid, 'specialty' the signature-work band; a block homepage that omits them LOSES them). Optional style per block: {align,size:'s'|'m'|'l'|'xl',font:'sans'|'serif'|'mono',color:'#rrggbb',pad:'s'|'m'|'l'} — pad adds vertical breathing room around that block or section.\n" +
        'Respond with ONLY a JSON object: {"doc": {<ONLY the fields you are CHANGING — an omitted field keeps its current value; include a field only to change it>}, "changes": ["what changed and why, one plain sentence each — the owner reads these"], "cannot": ["anything asked for that no field controls — plain words; empty array when nothing"], "note": "≤12 words naming this version"}. No prose outside the JSON.',
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
      cannot?: unknown;
      note?: unknown;
    };
    const { doc, dropped } = coerceSiteDoc(parsed.doc, base);
    // THE MODEL LANE'S HTML obeys the same laws as its urls (review: an <img>/<a> INSIDE
    // text/split html walked around the own-library and on-site-link checks). Server-side here —
    // site-doc is client-bundled, the sanitizer is not. Removals are NAMED.
    let htmlStripped = false;
    doc.home_blocks = doc.home_blocks.map((b) => {
      if (b.type !== "text" && b.type !== "split") return b;
      const { html, removed } = sanitizeModelHtml(b.props.html);
      if (removed) htmlStripped = true;
      return b.type === "text" ? { ...b, props: { ...b.props, html } } : { ...b, props: { ...b.props, html } };
    });
    if (htmlStripped) dropped.push("links or images written inside block html (use image blocks and buttons instead)");
    const changes = Array.isArray(parsed.changes)
      ? parsed.changes.map((c) => String(c).trim()).filter(Boolean).slice(0, 20)
      : [];
    // What the instruction asked for that NO field controls — the honesty channel. Erik's read
    // of the timid first passes was "it doesnt seem to understand the command"; it understood,
    // it just had no lever and no way to say so.
    const cannot = Array.isArray(parsed.cannot)
      ? parsed.cannot.map((c) => String(c).trim()).filter(Boolean).slice(0, 10)
      : [];
    const note = String(parsed.note ?? "Design pass").replace(/\s+/g, " ").trim().slice(0, 120) || "Design pass";

    // A PASS THAT CHANGES NOTHING MINTS NOTHING (v6 and v8 were both empty "no change" rows —
    // version-list noise). The honest answer rides back in `cannot`; no version is created.
    if (diffSiteDoc(base, doc).length === 0) {
      return { ok: true, changes: [], dropped, cannot: cannot.length ? cannot : ["Nothing in that request maps to a design field — no version created."], note };
    }
    const ins = await insertVersion(ctx.supabase, { doc, note, created_by: ctx.userId });
    if ("error" in ins) return { ok: false, error: ins.error };
    revalidatePath("/site-studio");
    return { ok: true, id: ins.id, changes, dropped, cannot, note };
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
  // extractSiteDoc bounds the doc to the site-document keys and shapes, HOWEVER the row was
  // written — a direct PostgREST insert can't smuggle protected keys through this merge.
  const doc = extractSiteDoc((ver as VersionRow).doc);
  if (JSON.stringify(doc).length > 1_600_000) return { ok: false, error: "This version is too large to publish." };

  // One transaction (0209): settings merge + archive old + mark new, RLS-enforced, zero-row
  // writes RAISE. Replaces three interleavable PostgREST writes whose half-failures left the
  // drift banner blaming "edits made outside the studio".
  const { error } = await ctx.supabase.rpc("publish_site_version", { p_version_id: versionId, p_doc: doc });
  if (error) return { ok: false, error: dbError(error) };
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
