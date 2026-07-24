import type { Metadata } from "next";
import { orgPublicBaseUrl } from "@/lib/org-settings";
import { jsonLdSafe } from "@/lib/jsonld";
import type { PublicOrg } from "@/lib/public-org";
import type { PublicPage } from "@/lib/public-pages";
import { BlockRenderer } from "./block-renderer";
import { deriveSiteChrome, SiteHeader, SiteFooter, type SiteNav } from "./site-chrome";
import { defaultSocialImage } from "./site-base";
import { socialImage } from "@/lib/site-image";

/**
 * A custom builder PAGE, rendered inside the org's FULL site chrome (the same header/footer the
 * homepage wears — logo home, section links back to /#work etc., sibling pages, estimate CTA, dark
 * contact footer) so no builder page is a navigation dead-end for visitors or crawlers. Shared by
 * both public entry points (/site/[handle]/p/[slug] and the by-domain variant) so they can't
 * drift. `base` prefixes internal links: "" on the org's own host, "/site/<handle>" when browsing
 * on the app host. `nav` is the route-fetched site nav (getSiteNav) — Articles + builder pages.
 */
export function customPageMetadata(org: PublicOrg, page: PublicPage): Metadata {
  const title = page.seo_title || `${page.title} — ${org.name}`;
  const description = page.description || `${page.title} — ${org.name}.`;
  const url = `${orgPublicBaseUrl(org.settings)}/${page.slug}`;
  // First image in the page's own blocks beats the org-wide default social image.
  const firstBlockImg = firstImageInBlocks(page.blocks);
  const img = socialImage(firstBlockImg) || defaultSocialImage(org);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, type: "website", url, ...(img ? { images: [img] } : {}) },
    twitter: { card: "summary_large_image", title, description, ...(img ? { images: [img] } : {}) },
  };
}

/** Best-effort scan of builder blocks for a representative image (hero/image/gallery). */
function firstImageInBlocks(blocks: PublicPage["blocks"]): string | null {
  for (const b of blocks ?? []) {
    const p = (b as { props?: Record<string, unknown> }).props ?? {};
    if (typeof p.image_url === "string" && p.image_url) return p.image_url;
    if (typeof p.url === "string" && p.url && /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(p.url)) return p.url;
    if (Array.isArray(p.images) && p.images.length) {
      const first = p.images[0] as { url?: string } | string;
      const u = typeof first === "string" ? first : first?.url;
      if (u) return u;
    }
  }
  return null;
}

export function CustomPageView({ org, page, base, nav }: { org: PublicOrg; page: PublicPage; base: string; nav: SiteNav }) {
  const chrome = deriveSiteChrome(org, { base, onHomepage: false });
  const baseUrl = orgPublicBaseUrl(org.settings);
  // Breadcrumb trail (Home → this page) — SERP breadcrumbs + structure signal.
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: baseUrl },
      { "@type": "ListItem", position: 2, name: page.title, item: `${baseUrl}/${page.slug}` },
    ],
  };
  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* jsonLdSafe escapes `<` so a title containing `</script>` can't break out of the block. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdSafe(breadcrumbs) }} />
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
