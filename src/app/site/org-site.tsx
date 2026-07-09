import type { Metadata } from "next";
import Link from "next/link";
import { Phone, Mail, MapPin, ArrowRight, Check, ShieldCheck, Clock, Zap, Instagram, Star } from "lucide-react";
import { accentHex, orgPublicBaseUrl, parseGeoFromMapUrl, type OrgSettings } from "@/lib/org-settings";
import type { PublicOrg } from "@/lib/public-org";
import { jsonLdSafe } from "@/lib/jsonld";
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
  const hero = s.splash_bg_url || s.portfolio[0]?.url;
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
            <img src={hero} alt="" className="aspect-[4/3] w-full rounded-2xl object-cover shadow-2xl ring-1 ring-white/20" />
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
            <img src={hero} alt="" className="aspect-[4/3] w-full rounded-[2rem] object-cover shadow-xl lg:aspect-[4/5]" />
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
        <img src={hero} alt="" aria-hidden className="absolute inset-0 -z-10 h-full w-full object-cover" />
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
  const brand = accentHex(s.glass_tint);
  const portfolio = (s.portfolio ?? []).filter((p) => p.url);
  const photos = portfolio.map((p) => p.url);
  const hero = s.splash_bg_url || photos[0] || "";
  const services = String(s.splash_bullets || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const creds = String(s.splash_credentials || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const area = s.service_area || [org.city, org.state].filter(Boolean).join(", ");
  // Show the business NAME as text (not just the logo image) when the org opts in — so the name is
  // actually stated on the page even when the logo is a wordless emblem.
  const showName = s.show_name_with_logo === true;
  const ig = (s.social_instagram || "").replace(/^@/, "").trim();
  const reviews = (s.reviews ?? []).filter((r) => r && r.text && r.name);
  // Primary CTA: orgs that price from a catalog get the instant configurator; everyone else
  // (e.g. an electrician on the research method) routes to the branded inquiry form.
  const hasConfigurator = s.estimating_mode === "catalog";
  // Catalog orgs → the instant configurator; everyone else → the on-page contact form.
  const estimateHref = hasConfigurator ? `/estimate/${handle}` : "#contact-form";
  const ctaLabel = hasConfigurator ? "Get your free instant estimate" : "Request a free estimate";
  const telHref = org.phone ? `tel:${org.phone.replace(/[^0-9+]/g, "")}` : null;

  // schema.org LocalBusiness markup — how Google connects this site to the real-world business.
  // The linchpin is `sameAs`/`hasMap` pointing at the org's Google Business Profile: it tells
  // Google "this website IS that map listing," so the site's trust and the GBP's reviews/rank
  // reinforce each other instead of looking like two separate entities. `geo` is parsed from the
  // GBP link when it carries coordinates. NAP (name/phone/address) mirrors the org record, which
  // must match the GBP verbatim for the binding to hold.
  const siteUrl = orgPublicBaseUrl(s);
  const gbpUrl = (s.google_business_url || "").trim();
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
    ...(hero ? { image: hero } : {}),
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

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <a href="#top" className="flex items-center gap-2">
            {org.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={org.logo_url} alt={org.name} className="h-9 w-auto" />
            )}
            {(!org.logo_url || showName) && (
              <span className="text-lg font-extrabold tracking-tight">{org.name}</span>
            )}
          </a>
          <nav className="hidden items-center gap-6 text-sm font-medium text-slate-600 md:flex">
            {photos.length > 0 && <a href="#work" className="hover:text-slate-900">Our work</a>}
            {services.length > 0 && <a href="#services" className="hover:text-slate-900">Services</a>}
            {reviews.length > 0 && <a href="#reviews" className="hover:text-slate-900">Reviews</a>}
            {articlesHref && <Link href={articlesHref} className="hover:text-slate-900">Articles</Link>}
            {pageLinks.map((p) => (
              <Link key={p.href} href={p.href} className="hover:text-slate-900">{p.label}</Link>
            ))}
            <a href="#contact" className="hover:text-slate-900">Contact</a>
          </nav>
          <div className="flex items-center gap-2">
            {telHref && (
              <a href={telHref} className="hidden items-center gap-1.5 text-sm font-semibold text-slate-700 sm:flex">
                <Phone className="h-4 w-4" style={{ color: brand }} /> {org.phone}
              </a>
            )}
            <Link href={estimateHref} className="rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: brand }}>
              Get an estimate
            </Link>
          </div>
        </div>
      </header>

      {/* Hero — presentation varies by settings.site_theme; the copy/CTA/data are identical. */}
      <Hero
        theme={s.site_theme}
        name={showName ? org.name : undefined}
        headline={s.splash_headline}
        headlineSize={s.splash_headline_size}
        tagline={s.splash_tagline}
        brand={brand}
        hero={hero}
        area={area}
        estimateHref={estimateHref}
        ctaLabel={ctaLabel}
        hasPhotos={photos.length > 0}
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

      {/* Portfolio */}
      {photos.length > 0 && (
        <div id="work" className="border-t border-slate-100 bg-slate-50/60 pt-14">
          <PortfolioGallery photos={portfolio} brand={brand} orgName={org.name} />
        </div>
      )}

      {/* Reviews */}
      {reviews.length > 0 && (
        <section id="reviews" className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-3xl font-extrabold tracking-tight">What our customers say</h2>
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
      )}

      {/* Instant-estimate CTA */}
      <section className="px-4 py-20" style={{ background: `linear-gradient(160deg, ${brand}12, transparent 70%)` }}>
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            {hasConfigurator ? "Know your number in two minutes" : "Ready to get started?"}
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-lg text-slate-600">
            {hasConfigurator
              ? "Answer a few quick questions and get a real ballpark instantly — no waiting days for a callback."
              : "Tell us about your project and we'll get right back to you with a free estimate."}
          </p>
          <Link href={estimateHref} className="mt-8 inline-flex items-center gap-2 rounded-lg px-7 py-4 text-base font-semibold text-white shadow-lg" style={{ backgroundColor: brand }}>
            {ctaLabel} <ArrowRight className="h-5 w-5" />
          </Link>
        </div>
      </section>

      {/* On-page contact / estimate-request form */}
      <section id="contact-form" className="border-t border-slate-100 bg-slate-50 px-4 py-16">
        <ContactForm orgId={org.id} brand={brand} heading={hasConfigurator ? "Prefer to just message us?" : "Request a free estimate"} />
      </section>

      {/* Footer / contact */}
      <footer id="contact" className="border-t border-slate-200 bg-slate-900 text-slate-300">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 sm:grid-cols-2">
          <div>
            {org.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={org.logo_url} alt={org.name} className="h-10 w-auto brightness-0 invert" />
            )}
            {(!org.logo_url || showName) && (
              <span className={`text-xl font-extrabold text-white ${org.logo_url ? "mt-2 block" : ""}`}>{org.name}</span>
            )}
            {s.splash_tagline && <p className="mt-3 max-w-sm text-sm text-slate-400">{s.splash_tagline}</p>}
            {creds.length > 0 && <p className="mt-4 text-xs text-slate-500">{creds.join("  ·  ")}</p>}
          </div>
          <div className="space-y-3 text-sm sm:justify-self-end">
            <h3 className="font-semibold uppercase tracking-wide text-slate-400">Get in touch</h3>
            {telHref && <a href={telHref} className="flex items-center gap-2 hover:text-white"><Phone className="h-4 w-4" style={{ color: brand }} /> {org.phone}</a>}
            {org.email && <a href={`mailto:${org.email}`} className="flex items-center gap-2 hover:text-white"><Mail className="h-4 w-4" style={{ color: brand }} /> {org.email}</a>}
            {area && <p className="flex items-center gap-2"><MapPin className="h-4 w-4" style={{ color: brand }} /> {area}</p>}
            {ig && <a href={`https://www.instagram.com/${ig}`} className="flex items-center gap-2 hover:text-white"><Instagram className="h-4 w-4" style={{ color: brand }} /> @{ig}</a>}
            <Link href={estimateHref} className="mt-2 inline-flex items-center gap-2 rounded-lg px-4 py-2 font-semibold text-white" style={{ backgroundColor: brand }}>
              Get an estimate <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
        <div className="border-t border-white/10">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-5 text-xs text-slate-500 sm:flex-row">
            <span>© {org.name}. All rights reserved.</span>
            <span className="flex items-center gap-4">
              <Link href="/login" className="hover:text-slate-300">Team login</Link>
              <span>Powered by Contractor North</span>
            </span>
          </div>
        </div>
      </footer>

      {handle && <AskNort handle={handle} orgName={org.name} brand={brand} />}
    </div>
  );
}
