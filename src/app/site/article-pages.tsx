import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowLeft } from "lucide-react";
import { orgPublicBaseUrl } from "@/lib/org-settings";
import { DEFAULT_TIMEZONE } from "@/lib/utils";
import { jsonLdSafe } from "@/lib/jsonld";
import type { PublicOrg } from "@/lib/public-org";
import type { PublicPost } from "@/lib/public-posts";
import { deriveSiteChrome, SiteHeader, SiteFooter, type SiteNav } from "./site-chrome";

/**
 * The org-site ARTICLE pages (blog index + single post) — the content layer of the site
 * platform. Shared by both public entry points (/site/[handle]/[...path] and the by-domain
 * catch-all) so they can never drift, exactly like OrgSite itself. Posts render at their
 * ORIGINAL paths on the org's domain (e.g. tahoedeck.com/blog-1-1/redwood), so a migrated
 * site's already-indexed URLs keep serving 200s — the SEO vendor's content keeps its rankings.
 *
 * Both pages wear the FULL shared site chrome (site-chrome.tsx) — the same header/footer as the
 * homepage, with the Articles nav item marked current — so no article is a navigation dead-end.
 *
 * `base` prefixes internal article links: "" on the org's own host (subdomain / custom domain,
 * where middleware rewrites root-level paths), "/site/<handle>" when browsing on the app host.
 * `nav` is the route-fetched site nav (getSiteNav) — the Articles link + builder-page links.
 */

function fmtDate(iso: string): string {
  // Render in the business timezone (not the server's UTC) so an evening-Pacific publish doesn't
  // read a day ahead — the same off-by-one rule the rest of the app follows.
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function blogIndexMetadata(org: PublicOrg): Metadata {
  const title = `Articles — ${org.name}`;
  const description = `Guides and articles from ${org.name}.`;
  return {
    title,
    description,
    alternates: { canonical: `${orgPublicBaseUrl(org.settings)}/blog` },
    openGraph: { title, description, type: "website" },
  };
}

export function articleMetadata(org: PublicOrg, post: PublicPost): Metadata {
  const title = `${post.title} — ${org.name}`;
  const description = post.description || `${post.title} — from ${org.name}.`;
  return {
    title,
    description,
    alternates: { canonical: `${orgPublicBaseUrl(org.settings)}/${post.path}` },
    openGraph: { title, description, type: "article", images: post.cover_url ? [post.cover_url] : [] },
    twitter: { card: "summary_large_image", title, description, images: post.cover_url ? [post.cover_url] : [] },
  };
}

export function BlogIndex({ org, posts, base, nav }: { org: PublicOrg; posts: PublicPost[]; base: string; nav: SiteNav }) {
  const chrome = deriveSiteChrome(org, { base, onHomepage: false });
  const brand = chrome.brand;
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <SiteHeader chrome={chrome} articlesHref={nav.articlesHref} pageLinks={nav.pageLinks} current="articles" />
      <section className="border-b border-slate-100 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <p className="text-sm font-semibold uppercase tracking-[0.25em]" style={{ color: brand }}>
            {org.name}
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Articles &amp; guides</h1>
        </div>
      </section>
      <main className="mx-auto max-w-6xl px-4 py-10">
        {posts.length === 0 ? (
          <p className="py-16 text-center text-slate-500">No articles yet — check back soon.</p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((p) => (
              <Link
                key={p.id}
                href={`${base}/${p.path}`}
                className="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md"
              >
                {p.cover_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.cover_url} alt={p.title} className="aspect-[16/9] w-full object-cover" />
                )}
                <div className="p-5">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{fmtDate(p.published_at)}</p>
                  <h2 className="mt-1.5 text-lg font-semibold leading-snug group-hover:underline">{p.title}</h2>
                  {p.description && <p className="mt-2 line-clamp-3 text-sm text-slate-600">{p.description}</p>}
                  <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold" style={{ color: brand }}>
                    Read more <ArrowRight className="h-4 w-4" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
      <SiteFooter chrome={chrome} />
    </div>
  );
}

export function ArticlePage({ org, post, base, nav }: { org: PublicOrg; post: PublicPost; base: string; nav: SiteNav }) {
  const chrome = deriveSiteChrome(org, { base, onHomepage: false });
  const brand = chrome.brand;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.description || undefined,
    image: post.cover_url || undefined,
    datePublished: post.published_at,
    author: { "@type": "Organization", name: org.name },
    publisher: { "@type": "Organization", name: org.name, logo: org.logo_url || undefined },
    mainEntityOfPage: `${orgPublicBaseUrl(org.settings)}/${post.path}`,
  };
  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* jsonLdSafe escapes `<` so a title/description containing `</script>` can't break out of
          the JSON-LD block (title/description aren't HTML-sanitized — they render as text elsewhere). */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdSafe(jsonLd) }} />
      <SiteHeader chrome={chrome} articlesHref={nav.articlesHref} pageLinks={nav.pageLinks} current="articles" />
      <main className="mx-auto max-w-3xl px-4 py-12">
        <Link href={`${base}/blog`} className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
          <ArrowLeft className="h-4 w-4" /> All articles
        </Link>
        <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{post.title}</h1>
        <p className="mt-3 text-sm text-slate-400">
          {fmtDate(post.published_at)} · {org.name}
        </p>
        {post.cover_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.cover_url} alt={post.title} className="mt-8 w-full rounded-2xl object-cover" />
        )}
        {/* body_html is sanitized on READ in getPublicPostByPath (sanitize-html.ts) — safe here
            regardless of write path, since RLS (not just the staff-gated action) governs writes. */}
        <article
          className="prose-article mt-8 space-y-4 text-[1.05rem] leading-relaxed text-slate-700 [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-slate-200 [&_blockquote]:pl-4 [&_blockquote]:italic [&_h2]:mt-8 [&_h2]:text-2xl [&_h2]:font-bold [&_h2]:text-slate-900 [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-slate-900 [&_img]:rounded-xl [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc"
          dangerouslySetInnerHTML={{ __html: post.body_html }}
        />
        <div className="mt-12 rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center">
          <p className="text-lg font-semibold">Ready to start your project?</p>
          <Link
            href={chrome.estimateHref}
            className="mt-3 inline-flex items-center gap-2 rounded-lg px-6 py-3 text-base font-semibold text-white"
            style={{ backgroundColor: brand }}
          >
            Get a free estimate <ArrowRight className="h-5 w-5" />
          </Link>
        </div>
      </main>
      <SiteFooter chrome={chrome} />
    </div>
  );
}
