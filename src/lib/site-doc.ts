import { getOrgSettings, type OrgSettings } from "@/lib/org-settings";
import { normalizeBlocks, type Block } from "@/lib/site-blocks";

/**
 * THE SITE DOCUMENT — the versioned, designable subset of an org's settings.
 *
 * The design studio's whole contract lives in this file: WHICH keys a design may touch (and,
 * by omission, which it may never), how a model's proposal is coerced into a doc the renderer
 * can trust, and what the pre-publish checklist looks at. The renderer itself never changes —
 * publish MATERIALIZES a doc onto organizations.settings and the site serves exactly as today.
 *
 * OUT OF THE DOCUMENT, forever-by-design:
 *   · org identity (name/phone/email/license) — NAP must match the Google Business Profile;
 *   · routing identity (public_handle/custom_domain) — protected keys with dedicated setters;
 *   · behavioral config (estimating_mode, site_inspection_threshold) — the CTA derives from
 *     business reality, not from a design;
 *   · glass_tint — it skins the whole APP, not just the site; a redesign must not restyle the
 *     office's tools as a side effect;
 *   · public_address/city/state/zip — structured NAP data, edited deliberately in settings.
 */

export const SITE_DOC_KEYS = [
  "splash_headline",
  "splash_tagline",
  "splash_bg_url",
  "splash_bullets",
  "splash_credentials",
  "splash_headline_size",
  "show_name_with_logo",
  "specialty_headline",
  "specialty_blurb",
  "service_area",
  "site_theme",
  "hero_align",
  "hero_style",
  "hero_dx",
  "hero_dy",
  "hero_w",
  "hero_scale",
  "spread_area_scale",
  "spread_head_scale",
  "spread_tag_scale",
  "spread_area_dx",
  "spread_area_dy",
  "spread_head_dx",
  "spread_head_dy",
  "spread_head_w",
  "spread_tag_dx",
  "spread_tag_dy",
  "spread_tag_w",
  "site_accent",
  "site_font",
  "brand_font",
  "site_density",
  "estimate_cta_label",
  "social_instagram",
  "google_business_url",
  "calendly_url",
  "reviews",
  "portfolio",
  "home_blocks",
] as const;
export type SiteDocKey = (typeof SITE_DOC_KEYS)[number];

export interface SiteDoc {
  splash_headline: string;
  splash_tagline: string;
  splash_bg_url: string;
  splash_bullets: string;
  splash_credentials: string;
  splash_headline_size: "s" | "m" | "l";
  show_name_with_logo: boolean;
  specialty_headline: string;
  specialty_blurb: string;
  service_area: string;
  site_theme: "classic" | "bold" | "minimal";
  hero_align: "left" | "center" | "right";
  hero_style: "open" | "panel" | "band" | "spread";
  hero_dx: number;
  hero_dy: number;
  hero_w: number;
  hero_scale: number;
  spread_area_scale: number;
  spread_head_scale: number;
  spread_tag_scale: number;
  spread_area_dx: number;
  spread_area_dy: number;
  spread_head_dx: number;
  spread_head_dy: number;
  spread_head_w: number;
  spread_tag_dx: number;
  spread_tag_dy: number;
  spread_tag_w: number;
  site_accent: string;
  site_font: "default" | "serif" | "grotesk" | "soft" | "condensed";
  brand_font: "default" | "serif" | "grotesk" | "soft" | "condensed";
  site_density: "default" | "compact" | "airy";
  estimate_cta_label: string;
  social_instagram: string;
  google_business_url: string;
  calendly_url: string;
  reviews: { name: string; text: string; rating?: number }[];
  /** Extra keys ride verbatim — PortfolioManager stores `path` (the storage key it deletes by),
   *  and the live publish test caught extract dropping it (the projection law, in a jsonb). */
  portfolio: ({ url: string; src?: string; caption?: string } & Record<string, unknown>)[];
  home_blocks: Block[];
}

const LIMITS = {
  headline: 200,
  tagline: 300,
  bullets: 2000,
  credentials: 300,
  specialtyBlurb: 1500,
  serviceArea: 300,
  handle: 100,
  url: 600,
  caption: 300,
  ctaLabel: 40,
  // Parity with update_site_content's 200-element array cap (0118) — a bound, not a target.
  portfolioItems: 200,
} as const;

const HEX6 = /^#[0-9a-f]{6}$/i;

/** ±40% of the text block's own size — enough to reposition, never enough to fling it off-page. */
const nudge = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(40, Math.max(-40, n));
};

/** Box width % — 0 means "the framing's default", else clamped to a readable 30-100. */
/** Text zoom %: 0 = default, else clamped 50-200. Same total-function shape as boxW. */
const zoom = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
  if (n === 0) return 0;
  return Number.isFinite(n) ? Math.min(200, Math.max(50, n)) : fallback;
};
const boxW = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return n <= 0 ? 0 : Math.min(100, Math.max(30, n));
};

/** A headline is ONE LINE by nature — contentEditable Enter keys must not smuggle newlines into
 *  the H1/<title> (the v29 lesson: "Electrical \nTruckee" rendered and would have titled). */
/** A headline may carry DELIBERATE line breaks (Erik shaped a two-line hero and "it keeps
 *  resetting" — the old flatten-to-commas law fought him). Normalize instead: \r\n → \n,
 *  no spaces hugging a break, at most single breaks, trimmed. The ONE-LINE rule still holds
 *  where it matters — flattenHeadline() at the metadata/SEO boundary (<title>, og:title). */
const headlineText = (v: string): string =>
  v.replace(/\r\n?/g, "\n").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n").trim();

/** The metadata boundary's view of a headline: breaks become ", " (a <title> is one line). */
export const flattenHeadline = (v: string): string => v.replace(/\s*\n+\s*/g, ", ").replace(/,\s*,/g, ",");

const s = (v: unknown, max: number) => String(v ?? "").slice(0, max);

/**
 * Reviews are WIRING, carried VERBATIM (review finding, high): the first cut clamped them to
 * 12×600 chars in extractSiteDoc — which meant capture→publish would silently DELETE a 13th
 * review and truncate long ones, and the drift banner (which compares extracts) was blind to
 * exactly the same data. A design may never write reviews, so nothing model-shaped ever reaches
 * this path — structural coercion only, no truncation.
 */
const normalizeReviews = (raw: unknown): SiteDoc["reviews"] =>
  (Array.isArray(raw) ? raw : []).map((r) => ({
    name: String((r as { name?: unknown })?.name ?? ""),
    text: String((r as { text?: unknown })?.text ?? ""),
    ...(typeof (r as { rating?: unknown })?.rating === "number" ? { rating: (r as { rating: number }).rating } : {}),
  }));

/** The live site's current doc — read through the merged settings view, so shape is stable. */
export function extractSiteDoc(rawSettings: unknown): SiteDoc {
  const st: OrgSettings = getOrgSettings(rawSettings);
  return {
    splash_headline: headlineText(s(st.splash_headline, LIMITS.headline)),
    splash_tagline: s(st.splash_tagline, LIMITS.tagline),
    splash_bg_url: s(st.splash_bg_url, LIMITS.url),
    splash_bullets: s(st.splash_bullets, LIMITS.bullets),
    splash_credentials: s(st.splash_credentials, LIMITS.credentials),
    splash_headline_size: st.splash_headline_size === "s" || st.splash_headline_size === "m" ? st.splash_headline_size : "l",
    show_name_with_logo: !!st.show_name_with_logo,
    specialty_headline: s(st.specialty_headline, LIMITS.headline),
    specialty_blurb: s(st.specialty_blurb, LIMITS.specialtyBlurb),
    service_area: s(st.service_area, LIMITS.serviceArea),
    site_theme: st.site_theme === "bold" || st.site_theme === "minimal" ? st.site_theme : "classic",
    hero_align: st.hero_align === "center" || st.hero_align === "right" ? st.hero_align : "left",
    hero_style: st.hero_style === "panel" || st.hero_style === "band" || st.hero_style === "spread" ? st.hero_style : "open",
    hero_dx: nudge(st.hero_dx, 0),
    hero_dy: nudge(st.hero_dy, 0),
    hero_w: boxW(st.hero_w, 0),
    hero_scale: zoom(st.hero_scale, 0),
    spread_area_scale: zoom(st.spread_area_scale, 0),
    spread_head_scale: zoom(st.spread_head_scale, 0),
    spread_tag_scale: zoom(st.spread_tag_scale, 0),
    spread_area_dx: nudge(st.spread_area_dx, 0),
    spread_area_dy: nudge(st.spread_area_dy, 0),
    spread_head_dx: nudge(st.spread_head_dx, 0),
    spread_head_dy: nudge(st.spread_head_dy, 0),
    spread_head_w: boxW(st.spread_head_w, 0),
    spread_tag_dx: nudge(st.spread_tag_dx, 0),
    spread_tag_dy: nudge(st.spread_tag_dy, 0),
    spread_tag_w: boxW(st.spread_tag_w, 0),
    site_accent: (() => {
      const a = typeof st.site_accent === "string" ? st.site_accent.trim() : "";
      return HEX6.test(a) ? a.toLowerCase() : "";
    })(),
    site_font:
      st.site_font === "serif" || st.site_font === "grotesk" || st.site_font === "soft" || st.site_font === "condensed"
        ? st.site_font
        : "default",
    brand_font:
      st.brand_font === "serif" || st.brand_font === "grotesk" || st.brand_font === "soft" || st.brand_font === "condensed"
        ? st.brand_font
        : "default",
    site_density: st.site_density === "compact" || st.site_density === "airy" ? st.site_density : "default",
    estimate_cta_label: s(st.estimate_cta_label, LIMITS.ctaLabel),
    social_instagram: s(st.social_instagram, LIMITS.handle),
    google_business_url: s(st.google_business_url, LIMITS.url),
    calendly_url: s(st.calendly_url, LIMITS.url),
    reviews: normalizeReviews(st.reviews),
    // SPREAD THE ORIGINAL ENTRY FIRST: the first cut projected {url,src,caption} and the live
    // publish test caught it stripping `path` — the storage key PortfolioManager deletes by.
    // Extract only ever reads the org's own stored data, so unknown keys are theirs to keep.
    portfolio: (Array.isArray(st.portfolio) ? st.portfolio : []).slice(0, LIMITS.portfolioItems).map((p) => ({
      ...(p && typeof p === "object" ? (p as Record<string, unknown>) : {}),
      url: s((p as { url?: unknown }).url, LIMITS.url),
      ...(typeof (p as { src?: unknown }).src === "string" ? { src: s((p as { src: string }).src, LIMITS.url) } : {}),
      ...(typeof (p as { caption?: unknown }).caption === "string"
        ? { caption: s((p as { caption: string }).caption, LIMITS.caption) }
        : {}),
    })),
    home_blocks: normalizeBlocks(st.home_blocks),
  };
}

/** Publish/preview materializer: the doc's keys over the raw settings, nothing else touched. */
export function applySiteDoc(rawSettings: unknown, doc: SiteDoc): Record<string, unknown> {
  const base = rawSettings && typeof rawSettings === "object" ? (rawSettings as Record<string, unknown>) : {};
  return { ...base, ...doc };
}

/** Every image URL the org legitimately owns on its site today — the designer may only ever
 *  rearrange these, never introduce a URL of its own (a model-minted URL on a public page is an
 *  injection primitive, hotlink at best). */
export function knownImageUrls(base: SiteDoc): Set<string> {
  const known = new Set<string>();
  if (base.splash_bg_url) known.add(base.splash_bg_url);
  for (const p of base.portfolio) if (p.url) known.add(p.url);
  for (const b of base.home_blocks) {
    if (b.type === "image" && b.props.url) known.add(b.props.url);
    if (b.type === "banner" && b.props.bgUrl) known.add(b.props.bgUrl);
    if (b.type === "gallery") for (const img of b.props.images) if (img.url) known.add(img.url);
    if (b.type === "split" && b.props.url) known.add(b.props.url);
  }
  return known;
}

/** On-site links only: a designer-written href must stay on the org's own site. */
const safeHref = (href: string): boolean => href.startsWith("/") || href.startsWith("#");

/**
 * A MODEL'S PROPOSAL → A DOC THE RENDERER CAN TRUST. Everything enum-checked and clamped; every
 * image URL must already be the org's own; external hrefs dropped; reviews are UNTOUCHABLE (a
 * designer restyles testimonials, it never writes them — an invented five-star review on a real
 * contractor's site is fabrication, full stop). `dropped` names everything refused, because a
 * proposal that silently loses content is the failure the estimator's proposal list exists to
 * prevent.
 */
export function coerceSiteDoc(raw: unknown, base: SiteDoc): { doc: SiteDoc; dropped: string[] } {
  const dropped: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const known = knownImageUrls(base);
  const knownPortfolio = new Map(base.portfolio.map((p) => [p.url, p]));

  // AN ABSENT KEY KEEPS THE BASE VALUE (review, medium): the first cut blanked every string the
  // model didn't return — a pass that answered "make the hero darker" with only the changed
  // fields would silently erase the tagline, the services, the whole portfolio. Absent means
  // untouched; an explicit "" is an intentional clear and passes through.
  const sOr = (v: unknown, fallback: string, max: number) => (v === undefined ? fallback : s(v, max));

  const img = (v: unknown, label: string): string => {
    const u = s(v, LIMITS.url);
    if (!u) return "";
    if (known.has(u)) return u;
    dropped.push(`${label}: an image that isn't in your library`);
    return "";
  };

  // Portfolio: reorder / recaption / subset of the EXISTING photos only. Absent = untouched.
  const portfolio: SiteDoc["portfolio"] = [];
  if (Array.isArray(r.portfolio)) {
    for (const p of r.portfolio) {
      if (portfolio.length >= LIMITS.portfolioItems) break;
      const u = s((p as { url?: unknown })?.url, LIMITS.url);
      const own = knownPortfolio.get(u);
      if (!own) {
        if (u) dropped.push("a portfolio photo that isn't in your library");
        continue;
      }
      portfolio.push({
        ...own,
        ...(typeof (p as { caption?: unknown }).caption === "string"
          ? { caption: s((p as { caption: string }).caption, LIMITS.caption) }
          : {}),
      });
    }
  }

  // Blocks: through the same normalizer as every builder write, then the image/href laws.
  const blocks: Block[] = [];
  for (const b of normalizeBlocks(r.home_blocks)) {
    if (b.type === "image") {
      const url = img(b.props.url, "an image block");
      if (!url) continue;
      blocks.push({ ...b, props: { ...b.props, url } });
    } else if (b.type === "banner") {
      const bgUrl = img(b.props.bgUrl, "a banner");
      if (!bgUrl) continue;
      if (b.props.buttonHref && !safeHref(b.props.buttonHref)) {
        dropped.push("a banner button linking off your site");
        blocks.push({ ...b, props: { ...b.props, buttonLabel: "", buttonHref: "" } });
      } else blocks.push(b);
    } else if (b.type === "gallery") {
      const images = b.props.images.filter((i) => known.has(i.url));
      if (images.length < b.props.images.length) dropped.push("gallery photos that aren't in your library");
      if (images.length) blocks.push({ ...b, props: { images } });
    } else if (b.type === "split") {
      const url = b.props.url ? img(b.props.url, "an image-and-text section") : "";
      if (b.props.url && !url) continue; // its image was refused — the block goes with it, named
      blocks.push({ ...b, props: { ...b.props, url } });
    } else if (b.type === "button") {
      if (!safeHref(b.props.href)) {
        dropped.push(`a button linking off your site (${b.props.label || "unlabeled"})`);
        continue;
      }
      blocks.push(b);
    } else {
      blocks.push(b);
    }
  }

  // Reviews: carried from base VERBATIM. If the model tried to CHANGE them (compared after the
  // same structural normalization, so a re-serialized echo isn't a false refusal), say so.
  if (r.reviews !== undefined && JSON.stringify(normalizeReviews(r.reviews)) !== JSON.stringify(base.reviews)) {
    dropped.push("changes to your reviews (a design may restyle testimonials, never write them)");
  }

  const size = r.splash_headline_size;
  const theme = r.site_theme;
  return {
    doc: {
      splash_headline: headlineText(sOr(r.splash_headline, base.splash_headline, LIMITS.headline)),
      splash_tagline: sOr(r.splash_tagline, base.splash_tagline, LIMITS.tagline),
      splash_bg_url: r.splash_bg_url === undefined ? base.splash_bg_url : img(r.splash_bg_url, "the hero background"),
      splash_bullets: sOr(r.splash_bullets, base.splash_bullets, LIMITS.bullets),
      splash_credentials: sOr(r.splash_credentials, base.splash_credentials, LIMITS.credentials),
      splash_headline_size: size === "s" || size === "m" || size === "l" ? size : base.splash_headline_size,
      show_name_with_logo: typeof r.show_name_with_logo === "boolean" ? r.show_name_with_logo : base.show_name_with_logo,
      specialty_headline: sOr(r.specialty_headline, base.specialty_headline, LIMITS.headline),
      specialty_blurb: sOr(r.specialty_blurb, base.specialty_blurb, LIMITS.specialtyBlurb),
      service_area: sOr(r.service_area, base.service_area, LIMITS.serviceArea),
      site_theme: theme === "classic" || theme === "bold" || theme === "minimal" ? theme : base.site_theme,
      hero_align:
        r.hero_align === "left" || r.hero_align === "center" || r.hero_align === "right"
          ? r.hero_align
          : base.hero_align,
      hero_style:
        r.hero_style === "open" || r.hero_style === "panel" || r.hero_style === "band" || r.hero_style === "spread"
          ? r.hero_style
          : base.hero_style,
      hero_dx: r.hero_dx === undefined ? base.hero_dx : nudge(r.hero_dx, base.hero_dx),
      hero_dy: r.hero_dy === undefined ? base.hero_dy : nudge(r.hero_dy, base.hero_dy),
      hero_w: r.hero_w === undefined ? base.hero_w : boxW(r.hero_w, base.hero_w),
      hero_scale: r.hero_scale === undefined ? base.hero_scale : zoom(r.hero_scale, base.hero_scale),
      spread_area_scale: r.spread_area_scale === undefined ? base.spread_area_scale : zoom(r.spread_area_scale, base.spread_area_scale),
      spread_head_scale: r.spread_head_scale === undefined ? base.spread_head_scale : zoom(r.spread_head_scale, base.spread_head_scale),
      spread_tag_scale: r.spread_tag_scale === undefined ? base.spread_tag_scale : zoom(r.spread_tag_scale, base.spread_tag_scale),
      spread_area_dx: r.spread_area_dx === undefined ? base.spread_area_dx : nudge(r.spread_area_dx, base.spread_area_dx),
      spread_area_dy: r.spread_area_dy === undefined ? base.spread_area_dy : nudge(r.spread_area_dy, base.spread_area_dy),
      spread_head_dx: r.spread_head_dx === undefined ? base.spread_head_dx : nudge(r.spread_head_dx, base.spread_head_dx),
      spread_head_dy: r.spread_head_dy === undefined ? base.spread_head_dy : nudge(r.spread_head_dy, base.spread_head_dy),
      spread_head_w: r.spread_head_w === undefined ? base.spread_head_w : boxW(r.spread_head_w, base.spread_head_w),
      spread_tag_dx: r.spread_tag_dx === undefined ? base.spread_tag_dx : nudge(r.spread_tag_dx, base.spread_tag_dx),
      spread_tag_dy: r.spread_tag_dy === undefined ? base.spread_tag_dy : nudge(r.spread_tag_dy, base.spread_tag_dy),
      spread_tag_w: r.spread_tag_w === undefined ? base.spread_tag_w : boxW(r.spread_tag_w, base.spread_tag_w),
      site_accent:
        r.site_accent === undefined
          ? base.site_accent
          : r.site_accent === "" || HEX6.test(String(r.site_accent).trim())
            ? String(r.site_accent).trim().toLowerCase()
            : base.site_accent,
      site_font:
        r.site_font === "default" || r.site_font === "serif" || r.site_font === "grotesk" || r.site_font === "soft" || r.site_font === "condensed"
          ? r.site_font
          : base.site_font,
      brand_font:
        r.brand_font === "default" || r.brand_font === "serif" || r.brand_font === "grotesk" || r.brand_font === "soft" || r.brand_font === "condensed"
          ? r.brand_font
          : base.brand_font,
      site_density:
        r.site_density === "default" || r.site_density === "compact" || r.site_density === "airy"
          ? r.site_density
          : base.site_density,
      estimate_cta_label: sOr(r.estimate_cta_label, base.estimate_cta_label, LIMITS.ctaLabel),
      social_instagram: sOr(r.social_instagram, base.social_instagram, LIMITS.handle),
      google_business_url: base.google_business_url, // a design never rewrites the GBP link
      calendly_url: base.calendly_url, // nor the booking link — both are wiring, not styling
      reviews: base.reviews,
      portfolio: r.portfolio === undefined ? base.portfolio : portfolio,
      home_blocks: r.home_blocks === undefined ? base.home_blocks : blocks,
    },
    dropped,
  };
}

/** What changed between two docs, as human labels — the publish confirm and the "live site has
 *  edits outside the studio" banner both read from this. */
export function diffSiteDoc(a: SiteDoc, b: SiteDoc): string[] {
  const LABELS: Record<SiteDocKey, string> = {
    splash_headline: "Headline",
    splash_tagline: "Tagline",
    splash_bg_url: "Hero photo",
    splash_bullets: "Services list",
    splash_credentials: "Credentials line",
    splash_headline_size: "Headline size",
    show_name_with_logo: "Name beside logo",
    specialty_headline: "Specialty headline",
    specialty_blurb: "Specialty blurb",
    service_area: "Service area",
    site_theme: "Theme",
    hero_align: "Hero text position",
    hero_style: "Hero text treatment",
    hero_dx: "Hero text nudge (across)",
    hero_dy: "Hero text nudge (down)",
    hero_w: "Hero text box width",
    hero_scale: "Hero text zoom",
    spread_area_scale: "Area piece zoom",
    spread_head_scale: "Headline piece zoom",
    spread_tag_scale: "Tagline piece zoom",
    spread_area_dx: "Area piece nudge (across)",
    spread_area_dy: "Area piece nudge (down)",
    spread_head_dx: "Headline piece nudge (across)",
    spread_head_dy: "Headline piece nudge (down)",
    spread_head_w: "Headline piece width",
    spread_tag_dx: "Tagline piece nudge (across)",
    spread_tag_dy: "Tagline piece nudge (down)",
    spread_tag_w: "Tagline piece width",
    site_accent: "Accent color",
    site_font: "Heading typeface",
    brand_font: "Business-name typeface",
    site_density: "Page density",
    estimate_cta_label: "Estimate button label",
    social_instagram: "Instagram",
    google_business_url: "Google Business link",
    calendly_url: "Booking link",
    reviews: "Reviews",
    portfolio: "Photo order/captions",
    home_blocks: "Homepage layout",
  };
  const out: string[] = [];
  for (const k of SITE_DOC_KEYS) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(LABELS[k]);
  }
  return out;
}

export interface SeoCheck {
  level: "ok" | "warn";
  msg: string;
}

/**
 * The pre-publish checklist — plain words, never jargon. Warnings never block (the owner may
 * know better); they exist so a change that moves what Google shows is a decision, not an
 * accident. URLs can't change from the studio at all, so the checks are about the words.
 */
export function siteDocSeoChecks(doc: SiteDoc, published: SiteDoc | null): SeoCheck[] {
  const out: SeoCheck[] = [];
  if (!doc.splash_headline.trim()) out.push({ level: "warn", msg: "No headline — it's the first thing Google and visitors see." });
  if (!doc.splash_tagline.trim()) out.push({ level: "warn", msg: "No tagline — search results often show it as your description." });
  else if (doc.splash_tagline.length > 160)
    out.push({ level: "warn", msg: "Tagline is longer than 160 characters — Google will cut it off mid-sentence." });
  if (!doc.splash_bullets.trim()) out.push({ level: "warn", msg: "No services listed — the services words are what local searches match." });
  if (!doc.service_area.trim()) out.push({ level: "warn", msg: "No service area — local search leans on the towns you name." });
  if (published && published.splash_headline.trim() && doc.splash_headline !== published.splash_headline)
    out.push({
      level: "warn",
      msg: `Headline changes from "${published.splash_headline.slice(0, 60)}" — this is your page title in Google; expect rankings to re-settle.`,
    });
  if (!doc.splash_bg_url && !doc.portfolio.length)
    out.push({ level: "warn", msg: "No hero photo and no portfolio — the page opens with no imagery at all." });
  // Tahoe Deck's shape: no hero image set, so the FIRST portfolio photo IS the hero (and the
  // link-preview image) — a reorder quietly changes the face of the site. Say so.
  if (
    published &&
    !doc.splash_bg_url &&
    doc.portfolio.length &&
    published.portfolio.length &&
    !published.splash_bg_url &&
    doc.portfolio[0].url !== published.portfolio[0].url
  )
    out.push({
      level: "warn",
      msg: "The hero photo changes — with no hero image set, the first portfolio photo is the hero (and the link preview).",
    });
  if (!out.length) out.push({ level: "ok", msg: "Looks good — nothing risky in this publish." });
  return out;
}
