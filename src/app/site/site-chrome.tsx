import Link from "next/link";
import { Phone, Mail, MapPin, ArrowRight, Instagram, Star, Menu } from "lucide-react";
import { accentHex } from "@/lib/org-settings";
import type { PublicOrg } from "@/lib/public-org";
import { navPageLinks, pageSlugFromHref, sectionAnchor, type SiteNavLink } from "@/lib/site-nav";
import { renderReadyBlocks, getNavPages } from "@/lib/public-pages";
import { getPublicPosts } from "@/lib/public-posts";

/**
 * The org site's shared CHROME — the sticky header (logo home, section nav, builder-page links,
 * mobile disclosure menu, estimate CTA) and the dark contact footer. Extracted from the homepage
 * (org-site.tsx) so builder pages and articles wear the SAME shell instead of rendering as
 * dead-ends: every public page now links home, to its siblings, and to the estimate CTA — for
 * visitors and for Google's internal-link graph alike. 100% data-driven from the org record, so
 * it serves every hosted site (Tahoe Deck included) with zero org-specific branches.
 *
 * `deriveSiteChrome` is the ONE derivation of the header/footer inputs. `onHomepage` controls the
 * anchor shape: on the homepage the section links stay bare ("#work") so the rendered output is
 * byte-identical to the pre-extraction header; on any other page they become `${home}#work` so
 * they actually resolve (the sections only exist on the homepage). "#contact" alone stays bare
 * everywhere — the footer it targets is part of this chrome, so every page has one.
 */

export type SiteNav = { articlesHref: string | null; pageLinks: SiteNavLink[] };

/** The nav data every chrome-wearing route needs: the Articles link (only when the org has
 *  published posts) and the builder pages that opted into the nav. Both reads are React-cache()d,
 *  so a route that already fetched posts/pages pays nothing extra. */
export async function getSiteNav(orgId: string, base: string): Promise<SiteNav> {
  const [posts, navPages] = await Promise.all([getPublicPosts(orgId), getNavPages(orgId)]);
  return {
    articlesHref: posts.length ? `${base}/blog` : null,
    pageLinks: navPageLinks(base, navPages),
  };
}

export type SiteChrome = ReturnType<typeof deriveSiteChrome>;

export function deriveSiteChrome(org: PublicOrg, { base = "", onHomepage = false }: { base?: string; onHomepage?: boolean }) {
  const s = org.settings;
  const brand = accentHex(s.glass_tint);
  const home = base || "/";
  const anchorBase = onHomepage ? "" : home;
  // Show the business NAME as text (not just the logo image) when the org opts in — so the name is
  // actually stated on the page even when the logo is a wordless emblem.
  const showName = s.show_name_with_logo === true;
  const telHref = org.phone ? `tel:${org.phone.replace(/[^0-9+]/g, "")}` : null;
  const portfolio = (s.portfolio ?? []).filter((p) => p.url);
  const services = String(s.splash_bullets || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const creds = String(s.splash_credentials || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const reviews = (s.reviews ?? []).filter((r) => r && r.text && r.name);
  // Fallback chain stops at the PUBLIC address fields — the org record's city is a business/
  // mailing address (often the owner's home base) and must never leak onto the public site.
  const area = s.service_area || [s.public_city, s.public_state].filter(Boolean).join(", ");
  const ig = (s.social_instagram || "").replace(/^@/, "").trim();
  const gbpUrl = (s.google_business_url || "").trim();
  const homeBlocks = renderReadyBlocks(s.home_blocks);
  const hasBlocks = homeBlocks.length > 0;
  // Which wired sections the custom layout actually renders — nav links and anchors key off this
  // so no link ever points at a section the block homepage left out.
  const blockSections = new Set(homeBlocks.flatMap((b) => (b.type === "section" ? [b.props.key] : [])));
  const showWorkLink = portfolio.length > 0 && (!hasBlocks || blockSections.has("portfolio"));
  const showServicesLink = services.length > 0 && !hasBlocks;
  const showReviewsLink = reviews.length > 0 && (!hasBlocks || blockSections.has("reviews"));
  // Primary CTA: orgs that price from a catalog get the instant configurator; everyone else routes
  // to the homepage contact form (or the footer when a block homepage carries no contact-form
  // section — never a dead anchor). Off the homepage, the anchors travel home via anchorBase.
  const hasConfigurator = s.estimating_mode === "catalog" && !!s.public_handle;
  const contactAnchor: `#${string}` = !hasBlocks || blockSections.has("contact") ? "#contact-form" : "#contact";
  const estimateHref = hasConfigurator ? `/estimate/${s.public_handle}` : sectionAnchor(anchorBase, contactAnchor);
  const ctaLabel = hasConfigurator ? "Get your free instant estimate" : "Request a free estimate";
  return {
    org, onHomepage, brand, home, anchorBase, showName, telHref,
    portfolio, services, creds, reviews, area, ig, gbpUrl,
    homeBlocks, hasBlocks, blockSections,
    showWorkLink, showServicesLink, showReviewsLink,
    hasConfigurator, estimateHref, ctaLabel,
  };
}

/** Is this nav link the page being viewed? `current` is the builder-page slug, or "articles" on
 *  the blog index / an article. */
function isCurrent(link: SiteNavLink, current?: string): boolean {
  return !!current && pageSlugFromHref(link.href) === current;
}

export function SiteHeader({
  chrome,
  articlesHref,
  pageLinks = [],
  current,
}: {
  chrome: SiteChrome;
  articlesHref?: string | null;
  pageLinks?: SiteNavLink[];
  current?: string;
}) {
  const { org, onHomepage, brand, home, anchorBase, showName, telHref, estimateHref } = chrome;
  const logo = (
    <>
      {org.logo_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={org.logo_url} alt={org.name} className="h-9 w-auto" />
      )}
      {(!org.logo_url || showName) && (
        <span className="text-lg font-extrabold tracking-tight">{org.name}</span>
      )}
    </>
  );
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        {onHomepage ? (
          <a href="#top" className="flex items-center gap-2">{logo}</a>
        ) : (
          <Link href={home} className="flex items-center gap-2">{logo}</Link>
        )}
        <nav className="hidden items-center gap-6 text-sm font-medium text-slate-600 md:flex">
          {chrome.showWorkLink && <a href={sectionAnchor(anchorBase, "#work")} className="hover:text-slate-900">Our work</a>}
          {chrome.showServicesLink && <a href={sectionAnchor(anchorBase, "#services")} className="hover:text-slate-900">Services</a>}
          {chrome.showReviewsLink && <a href={sectionAnchor(anchorBase, "#reviews")} className="hover:text-slate-900">Reviews</a>}
          {articlesHref && (
            <Link
              href={articlesHref}
              aria-current={current === "articles" ? "page" : undefined}
              className={current === "articles" ? "font-semibold text-slate-900" : "hover:text-slate-900"}
            >
              Articles
            </Link>
          )}
          {pageLinks.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              aria-current={isCurrent(p, current) ? "page" : undefined}
              className={isCurrent(p, current) ? "font-semibold text-slate-900" : "hover:text-slate-900"}
            >
              {p.label}
            </Link>
          ))}
          {/* "#contact" targets the footer, which is part of this chrome — resolves on EVERY page. */}
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
          {/* Mobile nav — the link row above is hidden below md, which stranded builder pages on
              phones. A <details> disclosure keeps this a server component (no client JS). */}
          <details className="relative md:hidden">
            <summary className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-lg border border-slate-200 text-slate-700 [&::-webkit-details-marker]:hidden" aria-label="Menu">
              <Menu className="h-5 w-5" />
            </summary>
            <nav className="absolute right-0 top-full z-50 mt-2 flex w-56 flex-col rounded-xl border border-slate-200 bg-white py-2 text-sm font-medium text-slate-700 shadow-lg">
              {telHref && (
                <a href={telHref} className="flex items-center gap-2 px-4 py-2 hover:bg-slate-50 sm:hidden">
                  <Phone className="h-4 w-4" style={{ color: brand }} /> {org.phone}
                </a>
              )}
              {!onHomepage && <Link href={home} className="px-4 py-2 hover:bg-slate-50">Home</Link>}
              {chrome.showWorkLink && <a href={sectionAnchor(anchorBase, "#work")} className="px-4 py-2 hover:bg-slate-50">Our work</a>}
              {chrome.showServicesLink && <a href={sectionAnchor(anchorBase, "#services")} className="px-4 py-2 hover:bg-slate-50">Services</a>}
              {chrome.showReviewsLink && <a href={sectionAnchor(anchorBase, "#reviews")} className="px-4 py-2 hover:bg-slate-50">Reviews</a>}
              {articlesHref && (
                <Link
                  href={articlesHref}
                  aria-current={current === "articles" ? "page" : undefined}
                  className={`px-4 py-2 hover:bg-slate-50 ${current === "articles" ? "font-semibold text-slate-900" : ""}`}
                >
                  Articles
                </Link>
              )}
              {pageLinks.map((p) => (
                <Link
                  key={p.href}
                  href={p.href}
                  aria-current={isCurrent(p, current) ? "page" : undefined}
                  className={`px-4 py-2 hover:bg-slate-50 ${isCurrent(p, current) ? "font-semibold text-slate-900" : ""}`}
                >
                  {p.label}
                </Link>
              ))}
              <a href="#contact" className="px-4 py-2 hover:bg-slate-50">Contact</a>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ chrome }: { chrome: SiteChrome }) {
  const { org, brand, showName, telHref, area, ig, gbpUrl, creds, estimateHref } = chrome;
  const s = org.settings;
  return (
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
          {gbpUrl && (
            <a href={gbpUrl} target="_blank" rel="noopener" className="flex items-center gap-2 hover:text-white">
              <Star className="h-4 w-4" style={{ color: brand }} /> Review us on Google
            </a>
          )}
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
  );
}
