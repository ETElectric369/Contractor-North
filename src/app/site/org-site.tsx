import { flattenHeadline } from "@/lib/site-doc";
import React from "react";
import type { Metadata } from "next";
import { SiteFonts } from "./site-fonts";
import Link from "next/link";
import { MapPin, ArrowRight, Check, ShieldCheck, Clock, Zap, Star } from "lucide-react";
import { orgPublicBaseUrl, parseGeoFromMapUrl, type OrgSettings } from "@/lib/org-settings";
import { pageSlugFromHref } from "@/lib/site-nav";
import type { PublicOrg } from "@/lib/public-org";
import { imageSrcSet, sizedImage, socialImage } from "@/lib/site-image";
import { orgIcons } from "./site-base";
import { jsonLdSafe } from "@/lib/jsonld";
import type { Block } from "@/lib/site-blocks";
import { BlockRenderer } from "./block-renderer";
import { deriveSiteChrome, seaGlassVars, SiteHeader, SiteFooter } from "./site-chrome";
import { PortfolioGallery } from "../estimate/[handle]/portfolio-gallery";
import { SpecialtyShowcase } from "./specialty-showcase";
import { ContactForm } from "./contact-form";
import { AskNort } from "./ask-nort";

/**
 * The org marketing homepage — one template, 100% data-driven from the org record + settings.
 * Rendered by BOTH public entry points: /site/<handle> (free subdomain / direct link) and the
 * by-domain resolver (a custom domain pointed at us). Keeping the render here means those two
 * routes can never drift. Technical SEO lives in orgSiteMetadata() so every hosted site is
 * indexable however it was reached.
 */
export function orgSiteMetadata(org: PublicOrg): Metadata {
  const s = org.settings;
  // A deliberate two-line hero headline is still ONE line here — a <title> has no line breaks.
  const title = `${org.name} — ${flattenHeadline(s.splash_headline) || "Licensed contractor"}`;
  const description = flattenHeadline(s.splash_tagline) || `${org.name} — quality craftsmanship. Get a free estimate.`;
  const hero = socialImage(s.splash_bg_url || s.portfolio[0]?.url);
  return {
    title,
    description,
    icons: orgIcons(org), // the automatic per-tenant favicon — the org's own logo, resized
    // og:url was present on every inner page and missing on the homepage — the one page most
    // likely to be shared. It must be the org's canonical base, not the request host, or a share
    // from the free subdomain would advertise that host as the page's identity.
    openGraph: { title, description, type: "website", url: orgPublicBaseUrl(s), images: hero ? [hero] : [] },
    twitter: { card: "summary_large_image", title, description, images: hero ? [hero] : [] },
  };
}

/** The hero — the one section that carries a site's visual identity, so it's where the theme
 *  lives. All three variants render the SAME headline/tagline/CTA/credentials; only the framing
 *  differs. Body sections below the hero are shared across themes. */
const HEAD_SIZE: Record<"s" | "m" | "l", string> = {
  s: "text-2xl sm:text-3xl",
  m: "text-3xl sm:text-4xl",
  l: "text-4xl sm:text-5xl",
};

function Hero({
  theme,
  headline,
  headlineSize,
  tagline,
  brand,
  hero,
  area,
  estimateHref,
  ctaLabel,
  hasPhotos,
  creds,
  heroAlign = "left",
  heroStyle = "open",
  heroDx = 0,
  heroDy = 0,
  heroW = 0,
  heroS = 0,
  spreadOff = { areaDx: 0, areaDy: 0, areaS: 0, headDx: 0, headDy: 0, headW: 0, headS: 0, tagDx: 0, tagDy: 0, tagW: 0, tagS: 0 },
  headlineColor = "",
  taglineColor = "",
  areaColor = "",
  ghostTint = "",
}: {
  theme: OrgSettings["site_theme"];
  headline: string;
  headlineSize?: OrgSettings["splash_headline_size"];
  tagline: string;
  brand: string;
  hero: string;
  area: string;
  estimateHref: string;
  ctaLabel: string;
  hasPhotos: boolean;
  creds: string[];
  heroAlign?: OrgSettings["hero_align"];
  heroStyle?: OrgSettings["hero_style"];
  heroDx?: number;
  heroDy?: number;
  heroW?: number;
  heroS?: number;
  spreadOff?: { areaDx: number; areaDy: number; areaS: number; headDx: number; headDy: number; headW: number; headS: number; tagDx: number; tagDy: number; tagW: number; tagS: number };
  headlineColor?: string;
  taglineColor?: string;
  areaColor?: string;
  /** The org's own accent, when one is set — washes the ghost "See our work" buttons at ~5%
   *  (Erik: "i love the almost transparent see our work button over the rocks, maybe apply
   *  the sea glass to that as well i bet its at 5% opacity or something"). Empty = the
   *  untouched white/slate ghost, byte-identical. */
  ghostTint?: string;
}) {
  // THE DOCK BUTTON, LITERALLY (Erik: "the idea is simple match the dock buttons on the
  // website and people can adjust the tint"): every CTA carries the shared .seaglass-btn
  // class — the dock tile's own layers, sheen and ink over a white glass base — with the
  // org's accent arriving as the SAME --glass-tint/--glass-ink vars the app shell uses.
  // No hand-rolled approximations; one recipe, one place (globals.css).
  const ghost = ghostTint ? seaGlassVars(ghostTint) : undefined;
  const ghostCls = ghostTint ? " seaglass-btn" : "";
  const dockCta = ghost;
  // Palette overrides: a style attr exists ONLY when a color is set (byte-identical defaults).
  const tColor = (c: string) => (c ? { color: c } : undefined);
  // A lever'd unit carries CSS custom properties + the cn-lever classes; the actual transform/
  // max-width live in ONE desktop-scoped rule (site-fonts.tsx) so phones keep the untouched
  // re-stack (a nudge tuned on a 1200px hero is nonsense at 375px). transform-origin pins the
  // zoom to the unit's natural corner — "like any mac window", not ballooning from the center.
  // All-zero emits nothing: byte-identical to the pre-lever markup.
  const leverVars = (dx: number, dy: number, w: number, sc: number, origin: string) =>
    dx || dy || w || sc
      ? ({
          "--cn-t": [dx || dy ? `translate(${dx}%, ${dy}%)` : "", sc ? `scale(${sc / 100})` : ""].filter(Boolean).join(" ") || "none",
          ...(w ? { "--cn-w": `${w}%` } : {}),
          "--cn-o": origin,
        } as React.CSSProperties)
      : undefined;
  const leverCls = (vars: React.CSSProperties | undefined, w: number) =>
    vars ? (w ? "cn-lever cn-lever-w" : "cn-lever") : "";
  const cta = (
    <Link
      href={estimateHref}
      className={`inline-flex items-center gap-2 rounded-lg px-6 py-3.5 text-base font-semibold${dockCta ? ghostCls : " text-white shadow-lg"}`}
      style={dockCta ?? { backgroundColor: brand }}
    >
      <span data-e="estimate_cta_label">{ctaLabel}</span> <ArrowRight className="h-5 w-5" />
    </Link>
  );
  const hSize = HEAD_SIZE[headlineSize ?? "l"];

  // BOLD — saturated brand color-block, photo as a framed card. Contractor punch.
  if (theme === "bold") {
    return (
      <section id="top" className="relative isolate overflow-hidden text-white" style={{ background: `linear-gradient(135deg, ${brand} 0%, #0f172a 100%)` }}>
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-20 sm:py-24 lg:grid-cols-2">
          <div>
              {area && <p data-e="service_area" style={tColor(areaColor)} className="mb-4 inline-block rounded-full bg-white/15 px-3 py-1 text-xs font-bold uppercase tracking-[0.2em]">{area}</p>}
            {headline && <h1 data-e="splash_headline" style={tColor(headlineColor)} className={`${hSize} whitespace-pre-line font-black leading-[1.05] tracking-tight`}>{headline}</h1>}
            {tagline && <p data-e="splash_tagline" style={tColor(taglineColor)} className="mt-5 max-w-xl whitespace-pre-line text-lg text-white/85">{tagline}</p>}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href={estimateHref} className="inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3.5 text-base font-bold shadow-lg" style={{ color: brand }}>
                <span data-e="estimate_cta_label">{ctaLabel}</span> <ArrowRight className="h-5 w-5" />
              </Link>
              {hasPhotos && (
                <a href="#work" style={ghost} className={`inline-flex items-center gap-2 rounded-lg border border-white/40 px-6 py-3.5 text-base font-semibold hover:bg-white/10${ghostCls}`}>See our work</a>
              )}
            </div>
            {creds.length > 0 && <p className="mt-6 text-sm font-medium text-white/75">{creds.join("  ·  ")}</p>}
          </div>
          {hero && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={sizedImage(hero, 1280)}
              srcSet={imageSrcSet(hero, [640, 1280, 1920])}
              sizes="(min-width: 1024px) 50vw, 100vw"
              fetchPriority="high"
              alt="Recent project"
              className="aspect-[4/3] w-full rounded-2xl object-cover shadow-2xl ring-1 ring-white/20"
            />
          )}
        </div>
      </section>
    );
  }

  // MINIMAL — light, airy, editorial. Photo as a tall rounded card. Upscale remodel/design feel.
  if (theme === "minimal") {
    return (
      <section id="top" className="border-b border-slate-100" style={{ background: `linear-gradient(180deg, ${brand}0a, #ffffff 65%)` }}>
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:py-28 lg:grid-cols-2">
          <div>
              {area && <p data-e="service_area" className="mb-4 text-sm font-semibold uppercase tracking-[0.25em]" style={{ color: areaColor || brand }}>{area}</p>}
            {headline && <h1 data-e="splash_headline" style={tColor(headlineColor)} className={`${hSize} whitespace-pre-line font-semibold leading-[1.1] tracking-tight text-slate-900`}>{headline}</h1>}
            {tagline && <p data-e="splash_tagline" style={tColor(taglineColor)} className="mt-5 max-w-xl whitespace-pre-line text-lg text-slate-600">{tagline}</p>}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href={estimateHref} className="inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-base font-semibold text-white shadow-sm" style={{ backgroundColor: brand }}>
                <span data-e="estimate_cta_label">{ctaLabel}</span> <ArrowRight className="h-5 w-5" />
              </Link>
              {hasPhotos && (
                <a href="#work" style={ghost} className={`inline-flex items-center gap-2 rounded-full border border-slate-300 px-6 py-3.5 text-base font-semibold text-slate-700 hover:border-slate-400${ghostCls}`}>See our work</a>
              )}
            </div>
            {creds.length > 0 && <p className="mt-6 text-sm font-medium text-slate-500">{creds.join("  ·  ")}</p>}
          </div>
          {hero && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={sizedImage(hero, 1280)}
              srcSet={imageSrcSet(hero, [640, 1280, 1920])}
              sizes="(min-width: 1024px) 50vw, 100vw"
              fetchPriority="high"
              alt="Recent project"
              className="aspect-[4/3] w-full rounded-[2rem] object-cover shadow-xl lg:aspect-[4/5]"
            />
          )}
        </div>
      </section>
    );
  }

  // CLASSIC (default) — full-bleed photo hero with a dark overlay. The original — now with the
  // TEXT ARRANGEMENT levers (Erik: "i do not want to change the background image on the top, i
  // want to see options for all the text moved around"): hero_align places the text block
  // left/center/right over the photo; hero_style picks how it sits on it — open (straight on
  // the image), panel (translucent card, text legible anywhere), band (a strip across the
  // bottom, the photo breathing above). Defaults render the original byte-identically.
  const alignWrap =
    heroAlign === "center" ? "flex justify-center text-center" : heroAlign === "right" ? "flex justify-end" : "";
  const alignInner = heroAlign === "center" ? "flex flex-col items-center" : "";
  // The box zooms pinned at its aligned edge (left-aligned grows rightward, etc.).
  const boxVars = leverVars(heroDx, heroDy, heroW, heroS, `${heroAlign} top`);
  const textBlock = (
    <div data-hero-text style={boxVars} className={["max-w-2xl", leverCls(boxVars, heroW), alignInner, heroStyle === "panel" ? "rounded-2xl bg-slate-950/55 p-8 backdrop-blur-sm sm:p-10" : ""].filter(Boolean).join(" ")}>
      {area && <p data-e="service_area" style={tColor(areaColor)} className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-white/80">{area}</p>}
      {headline && <h1 data-e="splash_headline" style={tColor(headlineColor)} className={`${hSize} whitespace-pre-line font-extrabold leading-tight tracking-tight text-white drop-shadow`}>{headline}</h1>}
      {tagline && <p data-e="splash_tagline" style={tColor(taglineColor)} className="mt-4 max-w-xl whitespace-pre-line text-lg text-slate-100">{tagline}</p>}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        {cta}
        {hasPhotos && (
          <a href="#work" style={ghost} className={`inline-flex items-center gap-2 rounded-lg border border-white/40 px-6 py-3.5 text-base font-semibold text-white hover:bg-white/10${ghostCls}`}>See our work</a>
        )}
      </div>
      {creds.length > 0 && <p className="mt-6 text-sm font-medium text-white/85">{creds.join("  ·  ")}</p>}
    </div>
  );
  const heroImg = hero && (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={sizedImage(hero, 1920)}
      srcSet={imageSrcSet(hero, [960, 1920, 2560])}
      sizes="100vw"
      fetchPriority="high"
      alt=""
      aria-hidden
      className="absolute inset-0 -z-10 h-full w-full object-cover"
    />
  );
  if (heroStyle === "band") {
    // The photo breathes on top; the words live in a solid strip across the bottom. With no
    // photo at all the spacer would be an empty slab (review) — the strip alone carries it.
    return (
      <section id="top" className="relative isolate overflow-hidden">
        {hero && (
          <div className="relative min-h-[320px] sm:min-h-[440px]">
            {heroImg}
            <div className="absolute inset-0 -z-10" style={{ background: "linear-gradient(180deg, rgba(2,6,23,.15), rgba(2,6,23,.35))" }} />
          </div>
        )}
        <div className="bg-slate-950/85">
          <div className={["mx-auto max-w-6xl px-4 py-10 sm:py-12", alignWrap].filter(Boolean).join(" ")}>{textBlock}</div>
        </div>
      </section>
    );
  }
  if (heroStyle === "spread") {
    // THE PIECES SEPARATE ACROSS THE PHOTO (Erik: "TRUCKEE-NORTH TAHOE is a separate text box
    // than CUSTOM LIGHTING ... separated horizontally"): name+area anchor top-left, the headline
    // sits lower-left, tagline+buttons lower-right — corners of the image, not a stack on it.
    // Phones re-stack (a 375px screen has no horizontal to separate into).
    return (
      <section id="top" className="relative isolate overflow-hidden">
        {heroImg}
        <div className="absolute inset-0 -z-10" style={{ background: "linear-gradient(180deg, rgba(2,6,23,.45), rgba(2,6,23,.62))" }} />
        <div className="mx-auto flex min-h-[480px] max-w-6xl flex-col justify-between px-4 py-10 sm:min-h-[560px] sm:py-12">
          {(() => {
            const v = leverVars(spreadOff.areaDx, spreadOff.areaDy, 0, spreadOff.areaS, "left top");
            return (
          <div data-spread-piece="area" style={v} className={["w-fit", leverCls(v, 0)].filter(Boolean).join(" ")}>
            {area && <p data-e="service_area" style={tColor(areaColor)} className="text-sm font-semibold uppercase tracking-[0.2em] text-white/80">{area}</p>}
          </div>
            );
          })()}
          <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
            <div className={["max-w-xl", leverCls(leverVars(spreadOff.headDx, spreadOff.headDy, spreadOff.headW, spreadOff.headS, "left bottom"), spreadOff.headW)].filter(Boolean).join(" ")} data-spread-piece="headline" style={leverVars(spreadOff.headDx, spreadOff.headDy, spreadOff.headW, spreadOff.headS, "left bottom")}>
              {headline && <h1 data-e="splash_headline" style={tColor(headlineColor)} className={`${hSize} whitespace-pre-line font-extrabold leading-tight tracking-tight text-white drop-shadow`}>{headline}</h1>}
            </div>
            <div className={["max-w-md sm:text-right", leverCls(leverVars(spreadOff.tagDx, spreadOff.tagDy, spreadOff.tagW, spreadOff.tagS, "right bottom"), spreadOff.tagW)].filter(Boolean).join(" ")} data-spread-piece="tagline" style={leverVars(spreadOff.tagDx, spreadOff.tagDy, spreadOff.tagW, spreadOff.tagS, "right bottom")}>
              {tagline && <p data-e="splash_tagline" style={tColor(taglineColor)} className="whitespace-pre-line text-lg text-slate-100">{tagline}</p>}
              <div className="mt-6 flex flex-wrap items-center gap-3 sm:justify-end">
                {cta}
                {hasPhotos && (
                  <a href="#work" style={ghost} className={`inline-flex items-center gap-2 rounded-lg border border-white/40 px-6 py-3.5 text-base font-semibold text-white hover:bg-white/10${ghostCls}`}>See our work</a>
                )}
              </div>
              {creds.length > 0 && <p className="mt-5 text-sm font-medium text-white/85">{creds.join("  ·  ")}</p>}
            </div>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section id="top" className="relative isolate overflow-hidden">
      {heroImg}
      <div className="absolute inset-0 -z-10" style={{ background: "linear-gradient(180deg, rgba(2,6,23,.55), rgba(2,6,23,.72))" }} />
      <div className={["mx-auto max-w-6xl px-4 py-24 sm:py-32", alignWrap].filter(Boolean).join(" ")}>{textBlock}</div>
    </section>
  );
}

export function OrgSite({ org, articlesHref, pageLinks = [], appHost = false }: { org: PublicOrg; articlesHref?: string | null; pageLinks?: { href: string; label: string }[]; appHost?: boolean }) {
  const s = org.settings;
  const handle = s.public_handle;
  // ONE derivation of the shared header/footer inputs (brand, nav visibility, estimate CTA) —
  // the same call builder pages and articles make, so the chrome can't drift per-surface.
  const chrome = deriveSiteChrome(org, { onHomepage: true });
  const { brand, showName, portfolio, services, creds, reviews, area, gbpUrl, ig, homeBlocks, hasBlocks, showWorkLink, hasConfigurator, estimateHref, ctaLabel } = chrome;
  const hero = s.splash_bg_url || portfolio[0]?.url || "";
  // The banner (hero + trust band) always tops the page — template AND block homepages. Natural
  // opt-out: no hero image (none set, no portfolio fallback) and no headline → no banner at all.
  const showBanner = Boolean(hero || s.splash_headline);
  // A published builder page whose slug is "portfolio"/"contact" (already resolved into pageLinks
  // by the route — no extra query) gets a teaser link appended to the matching homepage section,
  // so those pages are reachable from the content they extend, not just the nav.
  const portfolioPageHref = pageLinks.find((p) => pageSlugFromHref(p.href) === "portfolio")?.href ?? null;
  const contactPageHref = pageLinks.find((p) => pageSlugFromHref(p.href) === "contact")?.href ?? null;

  // schema.org LocalBusiness markup — how Google connects this site to the real-world business.
  // The linchpin is `sameAs`/`hasMap` pointing at the org's Google Business Profile: it tells
  // Google "this website IS that map listing," so the site's trust and the GBP's reviews/rank
  // reinforce each other instead of looking like two separate entities. `geo` is parsed from the
  // GBP link when it carries coordinates. NAP (name/phone/address) mirrors the org record, which
  // must match the GBP verbatim for the binding to hold.
  const siteUrl = orgPublicBaseUrl(s);
  const geo = parseGeoFromMapUrl(gbpUrl);
  const sameAs = [gbpUrl, ig ? `https://www.instagram.com/${ig}` : ""].filter(Boolean);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "HomeAndConstructionBusiness",
    "@id": `${siteUrl}/#business`,
    name: org.name,
    url: siteUrl,
    ...(org.phone ? { telephone: org.phone } : {}),
    ...(org.email ? { email: org.email } : {}),
    ...(org.logo_url ? { logo: org.logo_url } : {}),
    ...(hero ? { image: socialImage(hero) } : {}),
    ...(area ? { areaServed: area } : {}),
    priceRange: "$$",
    // THE ADDRESS RULE, and it is not "never publish one". Whether a business publishes a street
    // address is the BUSINESS'S call: a contractor with a shop or a yard wants a full address on
    // the web and in their Google listing, and a one-truck operator working out of the house must
    // not. So this emits EXACTLY what the owner typed into the public_* fields and nothing else,
    // at whatever level of detail they chose — street, or just city/state, or nothing at all.
    //
    // What is absolute is the SEPARATION: organizations.address_line1/city/state/zip is the
    // mailing/billing address used on invoices and internally, and it is never a source here at
    // any level of detail. (An earlier version fell back to `org.state` when public_state was
    // blank — a small leak of exactly the kind this comment claimed to prevent.)
    ...(s.public_address || s.public_city
      ? {
          address: {
            "@type": "PostalAddress",
            ...(s.public_address ? { streetAddress: s.public_address } : {}),
            ...(s.public_city ? { addressLocality: s.public_city } : {}),
            ...(s.public_state ? { addressRegion: s.public_state } : {}),
            ...(s.public_zip ? { postalCode: s.public_zip } : {}),
            addressCountry: "US",
          },
        }
      : {}),
    ...(geo ? { geo: { "@type": "GeoCoordinates", latitude: geo.lat, longitude: geo.lng } } : {}),
    ...(gbpUrl ? { hasMap: gbpUrl } : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };

  return (
    <div className="site-shell min-h-screen bg-white text-slate-900">
      <SiteFonts settings={s} />
      {/* jsonLdSafe escapes `<` so a collaborator-writable field (service_area, google_business_url,
          social, hero URL) containing `</script>` can't break out and execute — stored-XSS guard. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdSafe(jsonLd) }} />

      {/* Header — the shared site chrome (same header every public page wears). */}
      <SiteHeader chrome={chrome} articlesHref={articlesHref} pageLinks={pageLinks} />

      {/* The banner — hero + trust band — ALWAYS tops the page when it has content; custom
          home_blocks replace only the default sections below it, never the banner. Opting out is
          natural: clear the hero image (and portfolio) and the headline. */}
      {showBanner && (
        <>
          {/* Hero — presentation varies by settings.site_theme; the copy/CTA/data are identical. */}
          <Hero
            theme={s.site_theme}
            // THE NAME RENDERS ONCE — in the sticky top bar (Erik: "i dont want to see ET
            // Electric twice on the top"). The hero's name line only ever appeared when the
            // header already showed the name, so it was a duplicate by construction; the
            // headline (or, with no headline set, the name AS the H1) carries the hero.
            headline={s.splash_headline || org.name}
            headlineSize={s.splash_headline_size}
            tagline={s.splash_tagline}
            brand={brand}
            hero={hero}
            area={area}
            estimateHref={estimateHref}
            ctaLabel={ctaLabel}
            hasPhotos={showWorkLink}
            creds={creds}
            heroAlign={s.hero_align}
            heroStyle={s.hero_style}
            heroDx={s.hero_dx}
            heroDy={s.hero_dy}
            heroW={s.hero_w}
            heroS={s.hero_scale}
            spreadOff={{
              areaDx: s.spread_area_dx,
              areaDy: s.spread_area_dy,
              areaS: s.spread_area_scale,
              headDx: s.spread_head_dx,
              headDy: s.spread_head_dy,
              headW: s.spread_head_w,
              headS: s.spread_head_scale,
              tagDx: s.spread_tag_dx,
              tagDy: s.spread_tag_dy,
              tagW: s.spread_tag_w,
              tagS: s.spread_tag_scale,
            }}
            headlineColor={s.splash_headline_color}
            taglineColor={s.splash_tagline_color}
            areaColor={s.service_area_color}
            ghostTint={s.site_accent}
          />

          {/* Trust band */}
          <section className="border-b border-slate-100 bg-slate-50">
            <div className="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-4 py-8 sm:grid-cols-4">
              {[
                { icon: ShieldCheck, label: org.license || "Licensed & insured" },
                { icon: Zap, label: hasConfigurator ? "Instant online estimates" : "Free estimates" },
                { icon: MapPin, label: area || "Serving your area" },
                { icon: Clock, label: "Free consultation" },
              ].map((f, i) => {
                const Icon = f.icon;
                return (
                  <div key={i} className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: `${brand}1a`, color: brand }}>
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="text-sm font-semibold text-slate-700">{f.label}</span>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* Custom home_blocks replace the DEFAULT SECTIONS (work/services/reviews/contact) below the
          banner; without them the designed template renders. An org "graduates" to the block layout
          just by adding sections — no separate mode, and Tahoe Deck (no blocks) is untouched. */}
      {hasBlocks ? (
        <HomeBlockRenderer
          blocks={homeBlocks}
          org={org}
          brand={brand}
          portfolio={portfolio}
          reviews={reviews}
          services={services}
          estimateHref={estimateHref}
          ctaLabel={ctaLabel}
          hasConfigurator={hasConfigurator}
          gbpUrl={gbpUrl}
          portfolioPageHref={portfolioPageHref}
          contactPageHref={contactPageHref}
        />
      ) : (
        <>
          {/* Signature-specialty showcase — an elegant dark gallery band spotlighting the org's marquee
              offering (e.g. custom lighting). Data-driven: hidden unless a headline is set. Features the
              first several captioned portfolio photos; the full set still shows in "Our work" below. */}
          {s.specialty_headline && portfolio.length > 0 && (
            <SpecialtyShowcase headline={s.specialty_headline} blurb={s.specialty_blurb} brand={brand} photos={portfolio.slice(0, 6)} />
          )}

          {/* Services */}
          <ServicesBand services={services} brand={brand} />

          <PortfolioBand portfolio={portfolio} brand={brand} orgName={org.name} moreHref={portfolioPageHref} />
          <ReviewsBand reviews={reviews} brand={brand} gbpUrl={gbpUrl} appHostExt={appHost} />
          <EstimateBand hasConfigurator={hasConfigurator} estimateHref={estimateHref} ctaLabel={ctaLabel} brand={brand} />
          <ContactBand orgId={org.id} brand={brand} hasConfigurator={hasConfigurator} pageHref={contactPageHref} />
        </>
      )}

      {/* Footer / contact — the shared site chrome (same footer every public page wears). */}
      <SiteFooter chrome={chrome} extInPlace={appHost} />

      {handle && <AskNort handle={handle} orgName={org.name} brand={brand} />}
    </div>
  );
}

// ── The wired homepage sections, as standalone bands. Used by BOTH the default template AND the
// block homepage (as "smart" section blocks), so there's ONE copy of each — no duplicated JSX. ──

function PortfolioBand({ portfolio, brand, orgName, moreHref }: { portfolio: { url: string; caption?: string }[]; brand: string; orgName: string; moreHref?: string | null }) {
  if (!portfolio.length) return null;
  return (
    <div id="work" className="border-t border-slate-100 bg-slate-50/60 pt-14">
      <PortfolioGallery photos={portfolio} brand={brand} orgName={orgName} />
      {/* Teaser to the full builder "portfolio" page, when the org has published one. */}
      {moreHref && (
        <div className="mx-auto -mt-8 max-w-5xl px-4 pb-14">
          <Link href={moreHref} className="inline-flex items-center gap-1.5 font-semibold hover:underline" style={{ color: brand }}>
            See the full portfolio <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      )}
    </div>
  );
}

function ReviewsBand({ reviews, brand, gbpUrl, appHostExt = false }: { reviews: { name: string; text: string; rating?: number }[]; brand: string; gbpUrl?: string; appHostExt?: boolean }) {
  if (!reviews.length) return null;
  return (
    <section id="reviews" className="mx-auto max-w-6xl px-4 py-16">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-3xl font-extrabold tracking-tight">What our customers say</h2>
        {gbpUrl && (
          <a href={gbpUrl} {...(appHostExt ? {} : { target: "_blank", rel: "noopener" })} className="inline-flex items-center gap-1.5 text-sm font-semibold hover:underline" style={{ color: brand }}>
            <Star className="h-4 w-4" fill={brand} /> Review us on Google
          </a>
        )}
      </div>
      <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {reviews.map((r, i) => {
          const stars = Math.max(1, Math.min(5, Math.round(r.rating ?? 5)));
          return (
            <figure key={i} className="flex flex-col rounded-2xl border border-slate-200 p-6">
              <div className="mb-3 flex gap-0.5" aria-label={`${stars} out of 5 stars`}>
                {Array.from({ length: 5 }).map((_, j) => (
                  <Star key={j} className="h-4 w-4" fill={j < stars ? brand : "none"} style={{ color: brand }} />
                ))}
              </div>
              <blockquote className="flex-1 text-slate-700">&ldquo;{r.text}&rdquo;</blockquote>
              <figcaption className="mt-4 text-sm font-semibold text-slate-900">— {r.name}</figcaption>
            </figure>
          );
        })}
      </div>
    </section>
  );
}

function EstimateBand({ hasConfigurator, estimateHref, ctaLabel, brand }: { hasConfigurator: boolean; estimateHref: string; ctaLabel: string; brand: string }) {
  return (
    <section className="px-4 py-20" style={{ background: `linear-gradient(160deg, ${brand}12, transparent 70%)` }}>
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{hasConfigurator ? "Know your number in two minutes" : "Ready to get started?"}</h2>
        <p className="mx-auto mt-3 max-w-xl text-lg text-slate-600">
          {hasConfigurator ? "Answer a few quick questions and get a real ballpark instantly — no waiting days for a callback." : "Tell us about your project and we'll get right back to you with a free estimate."}
        </p>
        <Link href={estimateHref} className="mt-8 inline-flex items-center gap-2 rounded-lg px-7 py-4 text-base font-semibold text-white shadow-lg" style={{ backgroundColor: brand }}>
          {ctaLabel} <ArrowRight className="h-5 w-5" />
        </Link>
      </div>
    </section>
  );
}

function ContactBand({ orgId, brand, hasConfigurator, pageHref }: { orgId: string; brand: string; hasConfigurator: boolean; pageHref?: string | null }) {
  return (
    <section id="contact-form" className="border-t border-slate-100 bg-slate-50 px-4 py-16">
      <ContactForm orgId={orgId} brand={brand} heading={hasConfigurator ? "Prefer to just message us?" : "Request a free estimate"} />
      {/* Teaser to the full builder "contact" page, when the org has published one. */}
      {pageHref && (
        <p className="mt-6 text-center">
          <Link href={pageHref} className="inline-flex items-center gap-1.5 text-sm font-semibold hover:underline" style={{ color: brand }}>
            Visit the contact page <ArrowRight className="h-4 w-4" />
          </Link>
        </p>
      )}
    </section>
  );
}

/** Render the owner's ordered home_blocks. Content blocks group into a BlockRenderer; a "section"
 *  block renders its wired band (gallery/reviews/contact/estimate) with live org data. This replaces
 *  only the DEFAULT SECTIONS below the always-on-top banner once the homepage has blocks. */
/** The what-we-do grid — one component for the default template AND the `services` section
 *  block, so a block homepage stops LOSING it (available is not visible: no services, no band). */
function ServicesBand({ services, brand }: { services: string[]; brand: string }) {
  if (!services.length) return null;
  return (
    <section id="services" className="mx-auto max-w-6xl px-4 py-16">
      <h2 className="text-3xl font-extrabold tracking-tight">What we do</h2>
      <p className="mt-2 max-w-2xl text-slate-600">Quality craftsmanship from the smallest fix to the biggest build — done right, on time.</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {services.map((svc, i) => (
          <div key={i} className="flex items-start gap-3 rounded-2xl border border-slate-200 p-5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: `${brand}1a`, color: brand }}>
              <Check className="h-4 w-4" />
            </span>
            <span className="font-semibold text-slate-800">{svc}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function HomeBlockRenderer({
  blocks, org, brand, portfolio, reviews, services, estimateHref, ctaLabel, hasConfigurator, gbpUrl, portfolioPageHref, contactPageHref,
}: {
  blocks: Block[];
  org: PublicOrg;
  brand: string;
  portfolio: { url: string; caption?: string }[];
  reviews: { name: string; text: string; rating?: number }[];
  services: string[];
  estimateHref: string;
  ctaLabel: string;
  hasConfigurator: boolean;
  gbpUrl?: string;
  portfolioPageHref?: string | null;
  contactPageHref?: string | null;
}) {
  const out: React.ReactNode[] = [];
  let run: Block[] = [];
  let key = 0;
  const flush = () => {
    if (run.length) {
      out.push(<BlockRenderer key={`r${key++}`} blocks={run} brand={brand} />);
      run = [];
    }
  };
  // style.pad on a SECTION block = extra breathing room around that band — the per-section
  // spacing lever Erik asked for twice on night one (the bands' own paddings stay untouched).
  const padWrap = (k: string, pad: "s" | "m" | "l" | undefined, node: React.ReactNode) =>
    pad && pad !== "s" ? (
      // empty:hidden — a band that renders null must not leave a padded ghost gap (review).
      <div key={k} className={pad === "l" ? "py-14 empty:hidden" : "py-6 empty:hidden"}>
        {node}
      </div>
    ) : (
      <React.Fragment key={k}>{node}</React.Fragment>
    );
  for (const b of blocks) {
    if (b.type === "section") {
      flush();
      const k = `s${key++}`;
      const pad = b.style?.pad;
      if (b.props.key === "portfolio") out.push(padWrap(k, pad, <PortfolioBand portfolio={portfolio} brand={brand} orgName={org.name} moreHref={portfolioPageHref} />));
      else if (b.props.key === "reviews") out.push(padWrap(k, pad, <ReviewsBand reviews={reviews} brand={brand} gbpUrl={gbpUrl} />));
      else if (b.props.key === "contact") out.push(padWrap(k, pad, <ContactBand orgId={org.id} brand={brand} hasConfigurator={hasConfigurator} pageHref={contactPageHref} />));
      else if (b.props.key === "estimate") out.push(padWrap(k, pad, <EstimateBand hasConfigurator={hasConfigurator} estimateHref={estimateHref} ctaLabel={ctaLabel} brand={brand} />));
      else if (b.props.key === "services") out.push(padWrap(k, pad, <ServicesBand services={services} brand={brand} />));
      else if (b.props.key === "specialty")
        out.push(
          padWrap(
            k,
            pad,
            org.settings.specialty_headline && portfolio.length > 0 ? (
              <SpecialtyShowcase headline={org.settings.specialty_headline} blurb={org.settings.specialty_blurb} brand={brand} photos={portfolio.slice(0, 6)} />
            ) : null,
          ),
        );
    } else {
      run.push(b);
    }
  }
  flush();
  return <>{out}</>;
}
