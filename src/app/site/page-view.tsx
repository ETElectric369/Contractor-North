import type { Metadata } from "next";
import Link from "next/link";
import { Phone } from "lucide-react";
import { accentHex, orgPublicBaseUrl } from "@/lib/org-settings";
import type { PublicOrg } from "@/lib/public-org";
import type { PublicPage } from "@/lib/public-pages";
import { BlockRenderer } from "./block-renderer";

/**
 * A custom builder PAGE, rendered inside the org's site chrome. Shared by both public entry points
 * (/site/[handle]/p/[slug] and the by-domain variant) so they can't drift. `base` prefixes internal
 * links: "" on the org's own host, "/site/<handle>" when browsing on the app host.
 */
export function customPageMetadata(org: PublicOrg, page: PublicPage): Metadata {
  const title = `${page.title} — ${org.name}`;
  const description = page.description || `${page.title} — ${org.name}.`;
  return {
    title,
    description,
    alternates: { canonical: `${orgPublicBaseUrl(org.settings)}/p/${page.slug}` },
    openGraph: { title, description, type: "website" },
  };
}

export function CustomPageView({ org, page, base }: { org: PublicOrg; page: PublicPage; base: string }) {
  const s = org.settings;
  const brand = accentHex(s.glass_tint);
  const home = base || "/";
  const hasConfigurator = s.estimating_mode === "catalog" && !!s.public_handle;
  const estimateHref = hasConfigurator ? `/estimate/${s.public_handle}` : `${home}#contact-form`;
  const telHref = org.phone ? `tel:${org.phone.replace(/[^\d+]/g, "")}` : null;

  return (
    <div className="min-h-screen bg-white text-slate-900">
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

      <main>
        <div className="mx-auto max-w-3xl px-4 pt-10">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{page.title}</h1>
        </div>
        <BlockRenderer blocks={page.blocks} brand={brand} />
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-sm text-slate-500">
          <span>
            © {new Date().getFullYear()} {org.name}
            {org.license ? ` · ${org.license}` : ""}
          </span>
          <Link href={home} className="font-medium text-slate-600 hover:text-slate-900">{org.name} home</Link>
        </div>
      </footer>
    </div>
  );
}
