import type { Metadata } from "next";
import Link from "next/link";
import { MapPin, ArrowRight, Check, ShieldCheck, Clock, Zap, Star } from "lucide-react";
import { orgPublicBaseUrl, parseGeoFromMapUrl, type OrgSettings } from "@/lib/org-settings";
import { pageSlugFromHref } from "@/lib/site-nav";
import type { PublicOrg } from "@/lib/public-org";
import { imageSrcSet, sizedImage, socialImage } from "@/lib/site-image";
import { jsonLdSafe } from "@/lib/jsonld";
import type { Block } from "@/lib/site-blocks";
import { BlockRenderer } from "./block-renderer";
import { deriveSiteChrome, SiteHeader, SiteFooter } from "./site-chrome";
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
  const title = `${org.name} — ${s.splash_headline || "Licensed contractor"}`;
  const description = s.splash_tagline || `${org.name} — quality craftsmanship. Get a free estimate.`;
  const hero = socialImage(s.splash_bg_url || s.portfolio[0]?.url);
  return {
    title,
    description,
    openGraph: { title, description, type: "website", images: hero ? [hero] : [] },
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
  name,
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
}: {
  theme: OrgSettings["site_theme"];
  name?: string;
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
}) {
  const cta = (
    <Link href={estimateHref} className="inline-flex items-center gap-2 rounded-lg px-6 py-3.5 text-base font-semibold text-white shadow-lg" style={{ backgroundColor: brand }}>
      {ctaLabel} <ArrowRight className="h-5 w-5" />
    </Link>
  );
  const hSize = HEAD_SIZE[headlineSize ?? "l"];

  // BOLD — saturated brand color-block, photo as a framed card. Contractor punch.
  if (theme === "bold") {
    return (
      <section id="top" className="relative isolate overflow-hidden text-white" style={{ background: `linear-gradient(135deg, ${brand} 0%, #0f172a 100%)` }}>
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-20 sm:py-24 lg:grid-cols-2">
          <div>
            {name && <p className="mb-2 text-2xl font-black tracking-tight">{name}</p>}
            {area && <p className="mb-4 inline-block rounded-full bg-white/15 px-3 py-1 text-xs font-bold uppercase tracking-[0.2em]">{area}</p>}
            {headline && <h1 className={`${hSize} font-black leading-[1.05] tracking-tight`}>{headline}</h1>}
            {tagline && <p className="mt-5 max-w-xl text-lg text-white/85">{tagline}</p>}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href={estimateHref} className="inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3.5 text-base font-bold shadow-lg" style={{ color: brand }}>
                {ctaLabel} <ArrowRight className="h-5 w-5" />
              </Link>
              {hasPhotos && (
                <a href="#work" className="inline-flex items-center gap-2 rounded-lg border border-white/40 px-6 py-3.5 text-base font-semibold hover:bg-white/10">See our work</a>
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
              alt={name ? `${name} — recent project` : "Recent project"}
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
            {name && <p className="mb-2 text-2xl font-bold tracking-tight text-slate-900">{name}</p>}
            {area && <p className="mb-4 text-sm font-semibold uppercase tracking-[0.25em]" style={{ color: brand }}>{area}</p>}
            {headline && <h1 className={`${hSize} font-semibold leading-[1.1] tracking-tight text-slate-900`}>{headline}</h1>}
            {tagline && <p className="mt-5 max-w-xl text-lg text-slate-600">{tagline}</p>}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href={estimateHref} className="inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-base font-semibold text-white shadow-sm" style={{ backgroundColor: brand }}>
                {ctaLabel} <ArrowRight className="h-5 w-5" />
              </Link>
              {hasPhotos && (
                <a href="#work" className="inline-flex items-center gap-2 rounded-full border border-slate-300 px-6 py-3.5 text-base font-semibold text-slate-700 hover:border-slate-400">See our work</a>
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
              alt={name ? `${name} — recent project` : "Recent project"}
              className="aspect-[4/3] w-full rounded-[2rem] object-cover shadow-xl lg:aspect-[4/5]"
            />
          )}
        </div>
      </section>
    );
  }

  // CLASSIC (default) — full-bleed photo hero with a dark overlay. The original.
  return (
    <section id="top" className="relative isolate overflow-hidden">
      {hero && (
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
      )}
      <div className="absolute inset-0 -z-10" style={{ background: "linear-gradient(180deg, rgba(2,6,23,.55), rgba(2,6,23,.72))" }} />
      <div className="mx-auto max-w-6xl px-4 py-24 sm:py-32">
        <div className="max-w-2xl">
          {name && <p className="mb-2 text-2xl font-extrabold tracking-tight text-white drop-shadow">{name}</p>}
          {area && <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-white/80">{area}</p>}
          {headline && <h1 className={`${hSize} font-extrabold leading-tight tracking-tight text-white drop-shadow`}>{headline}</h1>}
          {tagline && <p className="mt-4 max-w-xl text-lg text-slate-100">{tagline}</p>}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {cta}
            {hasPhotos && (
              <a href="#work" className="inline-flex items-center gap-2 rounded-lg border border-white/40 px-6 py-3.5 text-base font-semibold text-white hover:bg-white/10">See our work</a>
            )}
          </div>
          {creds.length > 0 && <p className="mt-6 text-sm font-medium text-white/85">{creds.join("  ·  ")}</p>}
        </div>
      </div>
    </section>
  );
}

export function OrgSite({ org, articlesHref, pageLinks = [] }: { org: PublicOrg; articlesHref?: string | null; pageLinks?: { href: string; label: string }[] }) {
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
    ...(area ? { address: { "@type": "PostalAddress", addressLocality: org.city, addressRegion: org.state, addressCountry: "US" } } : {}),
    ...(geo ? { geo: { "@type": "GeoCoordinates", latitude: geo.lat, longitude: geo.lng } } : {}),
    ...(gbpUrl ? { hasMap: gbpUrl } : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };

  return (
    <div className="min-h-screen bg-white text-slate-900">
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
            // No headline set → the org NAME becomes the H1 (every homepage needs exactly one),
            // and the separate small name line is dropped so it doesn't render twice.
            name={showName && s.splash_headline ? org.name : undefined}
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
          {services.length > 0 && (
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
          )}

          <PortfolioBand portfolio={portfolio} brand={brand} orgName={org.name} moreHref={portfolioPageHref} />
          <ReviewsBand reviews={reviews} brand={brand} gbpUrl={gbpUrl} />
          <EstimateBand hasConfigurator={hasConfigurator} estimateHref={estimateHref} ctaLabel={ctaLabel} brand={brand} />
          <ContactBand orgId={org.id} brand={brand} hasConfigurator={hasConfigurator} pageHref={contactPageHref} />
        </>
      )}

      {/* Footer / contact — the shared site chrome (same footer every public page wears). */}
      <SiteFooter chrome={chrome} />

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

function ReviewsBand({ reviews, brand, gbpUrl }: { reviews: { name: string; text: string; rating?: number }[]; brand: string; gbpUrl?: string }) {
  if (!reviews.length) return null;
  return (
    <section id="reviews" className="mx-auto max-w-6xl px-4 py-16">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-3xl font-extrabold tracking-tight">What our customers say</h2>
        {gbpUrl && (
          <a href={gbpUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-sm font-semibold hover:underline" style={{ color: brand }}>
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
function HomeBlockRenderer({
  blocks, org, brand, portfolio, reviews, estimateHref, ctaLabel, hasConfigurator, gbpUrl, portfolioPageHref, contactPageHref,
}: {
  blocks: Block[];
  org: PublicOrg;
  brand: string;
  portfolio: { url: string; caption?: string }[];
  reviews: { name: string; text: string; rating?: number }[];
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
  for (const b of blocks) {
    if (b.type === "section") {
      flush();
      const k = `s${key++}`;
      if (b.props.key === "portfolio") out.push(<PortfolioBand key={k} portfolio={portfolio} brand={brand} orgName={org.name} moreHref={portfolioPageHref} />);
      else if (b.props.key === "reviews") out.push(<ReviewsBand key={k} reviews={reviews} brand={brand} gbpUrl={gbpUrl} />);
      else if (b.props.key === "contact") out.push(<ContactBand key={k} orgId={org.id} brand={brand} hasConfigurator={hasConfigurator} pageHref={contactPageHref} />);
      else if (b.props.key === "estimate") out.push(<EstimateBand key={k} hasConfigurator={hasConfigurator} estimateHref={estimateHref} ctaLabel={ctaLabel} brand={brand} />);
    } else {
      run.push(b);
    }
  }
  flush();
  return <>{out}</>;
}
