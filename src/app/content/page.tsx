import Link from "next/link";
import { redirect } from "next/navigation";
import { FileText, FileStack, LogOut, Megaphone, Images, Star, ArrowLeft, ExternalLink, ChevronRight } from "lucide-react";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getOrgSettings, orgPublicBaseUrl, accentHex } from "@/lib/org-settings";
import { marketingSettingsFor } from "@/lib/site-editor-guard";
import { signOut } from "@/app/login/actions";
import { PostsManager } from "../(app)/settings/posts-manager";
import { PagesManager } from "../(app)/settings/pages-manager";
import { SplashSettings } from "../(app)/settings/splash-settings";
import { SiteSeoFields } from "../(app)/settings/site-seo-fields";
import { ReviewsManager } from "../(app)/settings/reviews-manager";
import { PortfolioManager } from "../(app)/settings/portfolio-manager";
import { normalizeBlocks } from "@/lib/site-blocks";

function Panel({ icon: Icon, title, brand, children }: { icon: typeof FileText; title: string; brand: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-4 w-4" style={{ color: brand }} />
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <span className="text-base font-bold text-slate-800">Contractor North · Content</span>
          <form action={signOut}>
            <button className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
}

export const dynamic = "force-dynamic";

/**
 * The external content-collaborator / agency workspace. An invited SEO/content pro lands here (never
 * the app) and manages the public site of the org(s) they were granted — and NOTHING else. Security:
 *  - profile.org_id is NULL → auth_org_id() is null → RLS denies every operational table.
 *  - Access to a site comes solely from a site_collaborators grant (RLS/RPC-checked per org).
 *  - Org chrome + counts are read with the SERVICE client, always scoped to the caller's OWN
 *    granted org ids (validated first) — never arbitrary orgs.
 *
 * One pro can hold grants to several contractor sites: with >1 (and no ?org) this shows an AGENCY
 * dashboard of all their clients; ?org=<id> opens one client's editor (validated against grants).
 */
export default async function ContentWorkspace({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/content");

  // First visit after signing up: claim any grants sent to this verified email.
  await supabase.rpc("claim_site_collaborations");

  const { data: me } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
  const { data: grants } = await supabase
    .from("site_collaborators")
    .select("org_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  const grantedOrgs = [...new Set((grants ?? []).map((g) => (g as { org_id: string }).org_id))];

  if (!grantedOrgs.length) {
    redirect(me?.org_id ? "/planner" : "/onboarding");
  }

  // Which client is selected: a valid ?org grant, or the only grant. Otherwise (multi-grant, no
  // ?org) fall through to the agency dashboard.
  const selected = orgParam && grantedOrgs.includes(orgParam) ? orgParam : grantedOrgs.length === 1 ? grantedOrgs[0] : null;
  const svc = createServiceClient();

  // ── AGENCY DASHBOARD (multiple clients, none selected) ──────────────────────────────────────
  if (!selected) {
    const { data: orgs } = await svc.from("organizations").select("id, name, logo_url, settings").in("id", grantedOrgs);
    const { data: allPosts } = await svc.from("site_posts").select("org_id").in("org_id", grantedOrgs);
    const counts = new Map<string, number>();
    for (const p of (allPosts ?? []) as { org_id: string }[]) counts.set(p.org_id, (counts.get(p.org_id) ?? 0) + 1);
    const clients: { id: string; name: string; logo: string | null; brand: string; articles: number }[] = (orgs ?? []).map((o: any) => ({
      id: o.id as string,
      name: (o.name as string) ?? "Untitled",
      logo: (o.logo_url as string) ?? null,
      brand: accentHex(getOrgSettings(o.settings).glass_tint),
      articles: counts.get(o.id) ?? 0,
    }));
    return (
      <Shell>
        <h1 className="text-xl font-bold text-slate-900">Your client sites</h1>
        <p className="mt-1 mb-6 text-sm text-slate-500">Pick a site to manage its content, articles, and on-page SEO.</p>
        <ul className="space-y-2">
          {clients.map((c) => (
            <li key={c.id}>
              <Link
                href={`/content?org=${c.id}`}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-shadow hover:shadow-md"
              >
                {c.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.logo} alt={c.name} className="h-9 w-auto" />
                ) : (
                  <span className="text-base font-bold" style={{ color: c.brand }}>{c.name}</span>
                )}
                <div className="min-w-0 flex-1">
                  {c.logo && <div className="truncate text-sm font-semibold text-slate-800">{c.name}</div>}
                  <div className="text-xs text-slate-400">{c.articles} article{c.articles === 1 ? "" : "s"}</div>
                </div>
                <ChevronRight className="h-5 w-5 text-slate-300" />
              </Link>
            </li>
          ))}
        </ul>
      </Shell>
    );
  }

  // ── ONE CLIENT'S EDITOR ─────────────────────────────────────────────────────────────────────
  const { data: org } = await svc.from("organizations").select("name, logo_url, settings").eq("id", selected).maybeSingle();
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const siteUrl = settings.public_handle ? orgPublicBaseUrl(settings) : null;
  const brand = accentHex(settings.glass_tint);
  const orgName = (org as { name?: string } | null)?.name ?? "Your site";
  const logo = (org as { logo_url?: string } | null)?.logo_url ?? null;
  const marketing = marketingSettingsFor(settings); // only whitelisted fields reach the browser

  // Posts via the collaborator's OWN RLS-bound client — proves the grant, not the service key.
  const { data: posts } = await supabase
    .from("site_posts")
    .select("id, path, title, description, cover_url, body_html, published, published_at")
    .eq("org_id", selected)
    .order("published_at", { ascending: false });

  // Custom builder pages (same RLS-bound client).
  const { data: rawPages } = await supabase
    .from("site_pages")
    .select("id, slug, title, description, blocks, published, nav_label, nav_order")
    .eq("org_id", selected)
    .order("nav_order", { ascending: true })
    .order("created_at", { ascending: true });
  const pages = (rawPages ?? []).map((p) => ({
    ...(p as Record<string, unknown>),
    blocks: normalizeBlocks((p as { blocks?: unknown }).blocks),
  }));

  const multi = grantedOrgs.length > 1;

  return (
    <Shell>
      {multi && (
        <Link href="/content" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
          <ArrowLeft className="h-4 w-4" /> All client sites
        </Link>
      )}
      <div className="mb-6 flex items-center gap-3">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt={orgName} className="h-9 w-auto" />
        ) : (
          <h1 className="text-xl font-bold" style={{ color: brand }}>{orgName}</h1>
        )}
        <div className="min-w-0">
          {logo && <div className="text-lg font-bold text-slate-900">{orgName}</div>}
          <div className="text-xs text-slate-400">Website content &amp; SEO</div>
        </div>
        {siteUrl && (
          <a href={siteUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800">
            View site <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      <div className="space-y-6">
        <Panel icon={FileText} title="Articles" brand={brand}>
          <PostsManager initial={(posts ?? []) as never} siteUrl={siteUrl} orgId={selected} />
        </Panel>
        <Panel icon={FileStack} title="Custom pages" brand={brand}>
          <PagesManager initial={pages as never} siteUrl={siteUrl} orgId={selected} />
        </Panel>
        <Panel icon={Megaphone} title="Homepage" brand={brand}>
          <SplashSettings settings={marketing} orgId={selected} />
        </Panel>
        <Panel icon={FileText} title="SEO &amp; specialty" brand={brand}>
          <SiteSeoFields settings={marketing} orgId={selected} />
        </Panel>
        <Panel icon={Images} title="Portfolio photos" brand={brand}>
          <PortfolioManager orgId={selected} initial={marketing.portfolio ?? []} />
        </Panel>
        <Panel icon={Star} title="Reviews" brand={brand}>
          <ReviewsManager initial={marketing.reviews ?? []} orgId={selected} />
        </Panel>
      </div>
    </Shell>
  );
}
