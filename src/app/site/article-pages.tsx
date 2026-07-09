import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowLeft, Phone } from "lucide-react";
import { accentHex, orgPublicBaseUrl } from "@/lib/org-settings";
import { DEFAULT_TIMEZONE } from "@/lib/utils";
import { jsonLdSafe } from "@/lib/jsonld";
import type { PublicOrg } from "@/lib/public-org";
import type { PublicPost } from "@/lib/public-posts";

/**
 * The org-site ARTICLE pages (blog index + single post) — the content layer of the site
 * platform. Shared by both public entry points (/site/[handle]/[...path] and the by-domain
 * catch-all) so they can never drift, exactly like OrgSite itself. Posts render at their
 * ORIGINAL paths on the org's domain (e.g. tahoedeck.com/blog-1-1/redwood), so a migrated
 * site's already-indexed URLs keep serving 200s — the SEO vendor's content keeps its rankings.
 *
 * `base` prefixes internal article links: "" on the org's own host (subdomain / custom domain,
 * where middleware rewrites root-level paths), "/site/<handle>" when browsing on the app host.
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

/** Simplified site header for article pages — logo home, one CTA. Matches the OrgSite header. */
function ArticleHeader({ org, base }: { org: PublicOrg; base: string }) {
  const s = org.settings;
  const brand = accentHex(s.glass_tint);
  const home = base || "/";
  const hasConfigurator = s.estimating_mode === "catalog" && !!s.public_handle;
  const estimateHref = hasConfigurator ? `/estimate/${s.public_handle}` : `${home}#contact-form`;
  const telHref = org.phone ? `tel:${org.phone.replace(/[^\d+]/g, "")}` : null;
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href={home} className="flex items-center gap-2">
          {org.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={org.logo_url} alt={org.name} className="h-9 w-auto" />
          ) : (
            <span className="text-lg font-extrabold tracking-tight">{org.name}</span>
          )}
        </Link>
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
  );
}

function ArticleFooter({ org, base }: { org: PublicOrg; base: string }) {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-sm text-slate-500">
        <span>
          {/* license is stored display-ready ("CA Lic # 1111315") — no prefix, same as OrgSite */}
          © {new Date().getFullYear()} {org.name}
          {org.license ? ` · ${org.license}` : ""}
        </span>
        <Link href={base || "/"} className="font-medium text-slate-600 hover:text-slate-900">
          {org.name} home
        </Link>
      </div>
    </footer>
  );
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

export function BlogIndex({ org, posts, base }: { org: PublicOrg; posts: PublicPost[]; base: string }) {
  const brand = accentHex(org.settings.glass_tint);
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <ArticleHeader org={org} base={base} />
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
      <ArticleFooter org={org} base={base} />
    </div>
  );
}

export function ArticlePage({ org, post, base }: { org: PublicOrg; post: PublicPost; base: string }) {
  const brand = accentHex(org.settings.glass_tint);
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
      <ArticleHeader org={org} base={base} />
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
        {/* body_html is sanitized at WRITE time (sanitize-html.ts) — the manager + importer are
            the only write paths, both org-staff-gated. */}
        <article
          className="prose-article mt-8 space-y-4 text-[1.05rem] leading-relaxed text-slate-700 [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-slate-200 [&_blockquote]:pl-4 [&_blockquote]:italic [&_h2]:mt-8 [&_h2]:text-2xl [&_h2]:font-bold [&_h2]:text-slate-900 [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-slate-900 [&_img]:rounded-xl [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc"
          dangerouslySetInnerHTML={{ __html: post.body_html }}
        />
        <div className="mt-12 rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center">
          <p className="text-lg font-semibold">Ready to start your project?</p>
          <Link
            href={
              org.settings.estimating_mode === "catalog" && org.settings.public_handle
                ? `/estimate/${org.settings.public_handle}`
                : `${base || "/"}#contact-form`
            }
            className="mt-3 inline-flex items-center gap-2 rounded-lg px-6 py-3 text-base font-semibold text-white"
            style={{ backgroundColor: brand }}
          >
            Get a free estimate <ArrowRight className="h-5 w-5" />
          </Link>
        </div>
      </main>
      <ArticleFooter org={org} base={base} />
    </div>
  );
}
