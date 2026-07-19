import type { Metadata } from "next";
import { orgPublicBaseUrl } from "@/lib/org-settings";
import type { PublicOrg } from "@/lib/public-org";
import type { PublicPage } from "@/lib/public-pages";
import { BlockRenderer } from "./block-renderer";
import { deriveSiteChrome, SiteHeader, SiteFooter, type SiteNav } from "./site-chrome";

/**
 * A custom builder PAGE, rendered inside the org's FULL site chrome (the same header/footer the
 * homepage wears — logo home, section links back to /#work etc., sibling pages, estimate CTA, dark
 * contact footer) so no builder page is a navigation dead-end for visitors or crawlers. Shared by
 * both public entry points (/site/[handle]/p/[slug] and the by-domain variant) so they can't
 * drift. `base` prefixes internal links: "" on the org's own host, "/site/<handle>" when browsing
 * on the app host. `nav` is the route-fetched site nav (getSiteNav) — Articles + builder pages.
 */
export function customPageMetadata(org: PublicOrg, page: PublicPage): Metadata {
  const title = `${page.title} — ${org.name}`;
  const description = page.description || `${page.title} — ${org.name}.`;
  return {
    title,
    description,
    alternates: { canonical: `${orgPublicBaseUrl(org.settings)}/${page.slug}` },
    openGraph: { title, description, type: "website" },
  };
}

export function CustomPageView({ org, page, base, nav }: { org: PublicOrg; page: PublicPage; base: string; nav: SiteNav }) {
  const chrome = deriveSiteChrome(org, { base, onHomepage: false });
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <SiteHeader chrome={chrome} articlesHref={nav.articlesHref} pageLinks={nav.pageLinks} current={page.slug} />
      <main>
        <div className="mx-auto max-w-3xl px-4 pt-10">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{page.title}</h1>
        </div>
        <BlockRenderer blocks={page.blocks} brand={chrome.brand} />
      </main>
      <SiteFooter chrome={chrome} />
    </div>
  );
}
