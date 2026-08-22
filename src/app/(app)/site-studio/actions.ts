"use server";

import { revalidatePath } from "next/cache";
import { DEFAULT_MODEL, getAnthropic } from "@/lib/anthropic";
import { aiSpendExceeded, recordAiUsage } from "@/lib/ai-cost";
import { parseAiJson } from "@/lib/ai-json";
import { dbError } from "@/lib/db-error";
import { getOrgSettings } from "@/lib/org-settings";
import { rateLimited } from "@/lib/rate-limit";
import { coerceSiteDoc, diffSiteDoc, extractSiteDoc, knownImageUrls, type SiteDoc } from "@/lib/site-doc";
import { SECTION_KEYS, normalizeBlocks } from "@/lib/site-blocks";
import { requireStaff } from "@/lib/staff-guard";
import { sanitizeModelHtml, washEditorHtml } from "@/lib/sanitize-html";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * THE DESIGN STUDIO'S VERBS. Versions, never edits: every pass writes a NEW draft row; the live
 * site changes only in publishSiteVersion, which materializes a doc onto organizations.settings
 * — the renderer keeps reading what it has always read, which is why neither live site can break
 * mid-rollout and why rollback is just publishing an older version.
 */

export type StudioResult =
  | { ok: true; id?: string; changes?: string[]; dropped?: string[]; cannot?: string[]; note?: string; options?: { id: string; note: string }[] }
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
 * THE MODEL CORE of one design pass — shared by the single conversational pass and the
 * options fan-out. Returns a coerced doc + the honesty channels; never inserts, never gates.
 */
async function runDesignModel(args: {
  orgId: string | null;
  org: Record<string, unknown>;
  settings: ReturnType<typeof getOrgSettings>;
  base: SiteDoc;
  ask: string;
}): Promise<
  | { ok: true; doc: SiteDoc; changes: string[]; dropped: string[]; cannot: string[]; note: string; noop: boolean }
  | { ok: false; error: string }
> {
  const { org, settings, base, ask } = args;
  const ctx = { orgId: args.orgId };
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
        "· WHEN THE OWNER SAYS TEXT IS 'STACKED' — CHECK THE HERO FIRST. The preview opens on the hero; its headline+tagline+buttons are a text stack in the 'classic' framing, and no body block changes that. The hero-level moves: 'bold' or 'minimal' theme (text goes BESIDE the photo, two columns), a shorter headline, a one-line tagline (move the service list into the services grid below). If earlier versions pinned 'classic', SAY the tradeoff in changes — offer the two-column framings by name; never silently keep dodging the hero.\n" +
        "· 'THE HOME PAGE' MEANS THE WHOLE PAGE, HERO INCLUDED. The field named home_blocks is only the BODY below the hero — when the owner scopes an ask 'on the homepage', that does NOT mean home_blocks-only; the hero, theme, fonts and accent are all the homepage too.\n" +
        "· site_theme is THE HERO FRAMING. 'classic' = the hero IMAGE full-bleed BEHIND the text (the photo-backdrop look) — and on classic TWO MORE LEVERS arrange the text ON the photo: hero_align ('left'|'center'|'right' — where the text block sits) and hero_style ('open' = text straight on the image, 'panel' = a translucent dark card behind the text, 'band' = the words in a solid strip across the BOTTOM with the photo breathing above, 'spread' = the text PIECES separate across the photo: name+area top-left, headline lower-left, tagline+buttons lower-right — use this when the owner wants the text boxes horizontally separated over the image). These give ~9 classic arrangements WITHOUT losing the full-bleed photo — use them FIRST when the owner wants hero text moved but the photo kept. 'bold' = dark accent-gradient background, two columns, photo as a framed card on the right. 'minimal' = light airy background, two columns, photo right. The page below the hero is identical across themes.\n" +
        "· splash_bg_url = the hero image; when it is \"\", the FIRST portfolio photo is the hero AND the link-preview image — so portfolio order matters.\n" +
        "· site_accent = '#rrggbb': the ONE color every band, button and gradient leans on ('' = the default derivation). The single biggest mood lever you have.\n" +
        "· site_font = 'default'|'serif'|'grotesk'|'soft'|'condensed': the HEADING typeface preset (serif=editorial Fraunces, grotesk=modern Space Grotesk, soft=rounded Nunito, condensed=Oswald wordmark). Headings only; body text is fixed.\n" +
        "· brand_font = same presets: the BUSINESS NAME's typeface everywhere it renders — top bar, hero name line, footer — separate from the headings. THE lever when the owner wants the company name itself to look different.\n" +
        "· site_density = 'default'|'compact'|'airy': the WHOLE PAGE's vertical rhythm (all section paddings rescale together). For breathing room on ONE section, use style.pad on that section block instead.\n" +
        "· estimate_cta_label (≤40 chars) = the wording on EVERY estimate button — header, hero, bands, footer. '' = the built-in wording.\n" +
        "· home_blocks = ONLY the page body BELOW the hero. [] = the standard template (specialty, services grid, photos, reviews, estimate, contact). Non-empty replaces those bands with your blocks.\n" +
        "· splash_headline (the H1 + Google title — keyword-real: trade + place), splash_tagline (meta-description-ish, ≤160 chars ideally), splash_bullets (services, ONE per line), splash_credentials (license line), splash_headline_size ('s'|'m'|'l'), show_name_with_logo (bool), specialty_headline/specialty_blurb (signature-work section), service_area (towns, ' · ' separated), social_instagram (handle only), portfolio (ordered [{url, caption}] from the library).\n" +
        "WHAT NO FIELD CONTROLS (be honest, never fake the nearest thing): body-text fonts and letter-spacing (headings ARE controllable via site_font), page backgrounds outside the hero, animations, nav layout, footer layout, the trust band, page URLs. (Spacing IS controllable now: site_density for the whole page, style.pad per block/section. Side-by-side image+text IS controllable: the split block.) When the owner asks for one of these, name it in \"cannot\" in plain words and change only what they ALSO asked for.\n" +
        "HOME_BLOCKS PALETTE: {type:'heading',props:{text,align?}}, {type:'text',props:{html}} (simple p/strong/em/ul/li html only), {type:'image',props:{url,alt,caption}}, {type:'button',props:{label,href,align?}}, {type:'gallery',props:{images:[{url,alt}]}}, {type:'banner',props:{bgUrl,heading,text?,buttonLabel?,buttonHref?}}, {type:'split',props:{url,heading,html,imageSide:'left'|'right'}} (image BESIDE text, side by side — the un-stacked layout; stacks on phones), {type:'section',props:{key:'" +
        SECTION_KEYS.join("'|'") +
        "'}} (live org sections — 'services' renders the what-we-do grid, 'specialty' the signature-work band; a block homepage that omits them LOSES them). Optional style per block: {align,size:'s'|'m'|'l'|'xl',font:'sans'|'serif'|'mono',color:'#rrggbb',pad:'s'|'m'|'l'} — pad adds vertical breathing room around that block or section.\n" +
        'Respond with ONLY a JSON object: {"doc": {<ONLY the fields you are CHANGING — an omitted field keeps its current value; include a field only to change it>}, "changes": ["what changed and why, one plain sentence each, NAMING WHERE IT SHOWS (in the hero / below the hero — say to scroll the preview) — the preview opens on the hero, and a change the owner cannot see reads as no change at all"], "cannot": ["anything asked for that no field controls — plain words; empty array when nothing"], "note": "≤12 words naming this version"}. No prose outside the JSON.',
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

    return { ok: true, doc, changes, dropped, cannot, note, noop: diffSiteDoc(base, doc).length === 0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The design pass failed.";
    return {
      ok: false,
      error: /ANTHROPIC_API_KEY/i.test(message) ? "AI isn't configured on this server." : `Design pass failed: ${message.slice(0, 300)}`,
    };
  }
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

  const run = await runDesignModel({ orgId: ctx.orgId, org: org as Record<string, unknown>, settings, base, ask });
  if (!run.ok) return run;
  if (run.noop) {
    // A PASS THAT CHANGES NOTHING MINTS NOTHING — the honest answer rides back in `cannot`.
    return {
      ok: true,
      changes: [],
      dropped: run.dropped,
      cannot: run.cannot.length ? run.cannot : ["Nothing in that request maps to a design field — no version created."],
      note: run.note,
    };
  }
  const ins = await insertVersion(ctx.supabase, { doc: run.doc, note: run.note, created_by: ctx.userId });
  if ("error" in ins) return { ok: false, error: ins.error };
  revalidatePath("/site-studio");
  return { ok: true, id: ins.id, changes: run.changes, dropped: run.dropped, cannot: run.cannot, note: run.note };
}


/**
 * SHOW ME OPTIONS (Erik, night one: "i want to see options for all the text moved around on the
 * page like i would drag and drop any old editor"). Language is a bad tool for layout; eyes are
 * the right one — so one tap runs FOUR arrangements in parallel and lands them as versions to
 * flip through. Two keep the full-bleed photo backdrop (the thing he explicitly did not want to
 * lose), two show the text-beside-photo framings, all with the text mass redistributed into the
 * body. Every option obeys the same trust boundary as a single pass.
 */
export async function designSiteOptions(baseVersionId: string | null): Promise<StudioResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Staff only." };
  // One batch = four model calls: its own tighter limiter, fail-closed like the rest.
  if (await rateLimited(`site-designer-options:${ctx.userId}`, 4, 900, { failClosed: true }))
    return { ok: false, error: "A lot of option batches in a row — give it a few minutes." };
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

  const DIRECTIVES = [
    "OPTION A — BOTTOM BAND. Keep the classic full-bleed photo EXACTLY as is; hero_style 'band' so the words sit in a strip across the bottom and the photo breathes above; shortest true headline, one-line tagline, no service list in the hero (it lives in the services grid below). Note must start 'Option A:'.",
    "OPTION B — FLOATING PANEL. Keep the classic photo; hero_style 'panel' with hero_align 'right' — a translucent card of text to the right of the frame; short copy. Body: specialty first, then splits. Note must start 'Option B:'.",
    "OPTION C — CENTERED OPEN. Keep the classic photo; hero_align 'center', hero_style 'open', small headline size — a quiet centered title over the image, everything else below. Note must start 'Option C:'.",
    "OPTION D — TEXT BESIDE PHOTO. The bold two-column hero (this one trades the full-bleed photo for a framed card beside the text — say so in changes); shortened copy, body splits kept. Note must start 'Option D:'.",
  ];

  const runs = await Promise.all(
    DIRECTIVES.map((ask) =>
      runDesignModel({ orgId: ctx.orgId, org: org as Record<string, unknown>, settings, base, ask }),
    ),
  );
  const options: { id: string; note: string }[] = [];
  const cannot: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const L = String.fromCharCode(65 + i);
    if (!run.ok) {
      cannot.push(`Option ${L} failed: ${run.error}`);
      continue;
    }
    if (run.noop) {
      cannot.push(`Option ${L} matched the current design — nothing new to show`);
      continue;
    }
    const ins = await insertVersion(ctx.supabase, { doc: run.doc, note: run.note, created_by: ctx.userId });
    if ("error" in ins) {
      cannot.push(`Option ${L} was designed but couldn't be saved: ${ins.error}`);
      continue;
    }
    options.push({ id: ins.id, note: run.note });
    for (const d of run.dropped) dropped.push(`Option ${L}: ${d}`);
    for (const c of run.cannot) cannot.push(`Option ${L}: ${c}`);
  }
  if (!options.length) {
    return { ok: false, error: cannot[0] ?? "No options came back — try again." };
  }
  revalidatePath("/site-studio");
  return { ok: true, options, dropped, cannot, note: `${options.length} of ${runs.length} options ready` };
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


/**
 * ARRANGE BY HAND (Erik: "like i would drag and drop any old editor"). The studio's hand-edit
 * mode: the existing block editor writes the SELECTED DRAFT's body — never the live site, never
 * a published row. Same write-side wash as every builder save (text + split html sanitized,
 * shapes normalized); the version stays a draft you preview and publish like any other.
 */
export async function updateVersionBlocks(versionId: string, blocks: unknown): Promise<StudioResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "Staff only." };
  const { data: ver } = await ctx.supabase
    .from("site_versions")
    .select("id, status, doc")
    .eq("id", versionId)
    .maybeSingle();
  if (!ver) return { ok: false, error: "That version wasn't found." };
  if ((ver as { status: string }).status !== "draft")
    return { ok: false, error: "Only drafts can be hand-edited — make a new version first (Capture or a design pass)." };
  const washed = normalizeBlocks(blocks).map((b) => {
    if (b.type === "text") return { ...b, props: { ...b.props, html: washEditorHtml(b.props.html) } };
    if (b.type === "split") return { ...b, props: { ...b.props, html: washEditorHtml(b.props.html) } };
    return b;
  });
  const doc = extractSiteDoc((ver as { doc: unknown }).doc);
  doc.home_blocks = washed;
  const { data: upd, error } = await ctx.supabase
    .from("site_versions")
    .update({ doc })
    .eq("id", versionId)
    .eq("status", "draft")
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!upd?.length) return { ok: false, error: "The save didn't land — the version may have just been published." };
  revalidatePath("/site-studio");
  return { ok: true, id: versionId };
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
