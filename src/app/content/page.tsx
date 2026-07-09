import { redirect } from "next/navigation";
import { FileText, LogOut, Megaphone, Images, Star } from "lucide-react";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getOrgSettings, orgPublicBaseUrl, accentHex } from "@/lib/org-settings";
import { marketingSettingsFor } from "@/lib/site-editor-guard";
import { signOut } from "@/app/login/actions";
import { PostsManager } from "../(app)/settings/posts-manager";
import { SplashSettings } from "../(app)/settings/splash-settings";
import { SiteSeoFields } from "../(app)/settings/site-seo-fields";
import { ReviewsManager } from "../(app)/settings/reviews-manager";
import { PortfolioManager } from "../(app)/settings/portfolio-manager";

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

export const dynamic = "force-dynamic";

/**
 * The site-collaborator workspace. An invited external SEO/content pro lands here (never the app)
 * and manages ONLY the Articles of the org(s) they were granted. Security posture:
 *  - Their profile.org_id is NULL → auth_org_id() is null → RLS denies every operational table.
 *  - Access to this org's articles comes solely from a site_collaborators grant (RLS-checked).
 *  - The org's public chrome (name/logo/handle) is read with the SERVICE client, scoped to the ONE
 *    granted org we just verified — the collaborator can't read the organizations table themselves.
 */
export default async function ContentEditorPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/content");

  // First visit after signing up: claim any grants sent to this verified email.
  await supabase.rpc("claim_site_collaborations");

  const { data: me } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
  // Oldest grant first = a stable default when a collaborator holds several (an org switcher is a
  // later add). MVP shows the first; the post actions are told which org via the orgId prop.
  const { data: grants } = await supabase
    .from("site_collaborators")
    .select("org_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  const orgId = grants?.[0]?.org_id as string | undefined;

  if (!orgId) {
    // Not a collaborator. A real org member goes to the app; a no-org signed-in user finishes
    // onboarding (a coherent destination, not a login bounce).
    redirect(me?.org_id ? "/planner" : "/onboarding");
  }

  // Org display chrome — service client, scoped to the single verified granted org.
  const svc = createServiceClient();
  const { data: org } = await svc
    .from("organizations")
    .select("name, logo_url, settings")
    .eq("id", orgId)
    .maybeSingle();
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const siteUrl = settings.public_handle ? orgPublicBaseUrl(settings) : null;
  const brand = accentHex(settings.glass_tint);
  const orgName = (org as { name?: string } | null)?.name ?? "Your site";
  const logo = (org as { logo_url?: string } | null)?.logo_url ?? null;
  // Only the whitelisted marketing fields ever reach the collaborator's browser (never pricing,
  // playbook, secrets, thresholds). accentHex/siteUrl above are computed server-side and not passed.
  const marketing = marketingSettingsFor(settings);

  // Posts via the collaborator's OWN RLS-bound client — proves the grant, not the service key.
  const { data: posts } = await supabase
    .from("site_posts")
    .select("id, path, title, description, cover_url, body_html, published, published_at")
    .eq("org_id", orgId)
    .order("published_at", { ascending: false });

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2.5">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt={orgName} className="h-8 w-auto" />
            ) : (
              <span className="text-base font-bold" style={{ color: brand }}>{orgName}</span>
            )}
            <span className="hidden text-sm text-slate-400 sm:inline">· Content workspace</span>
          </div>
          <form action={signOut}>
            <button className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{orgName} — website content &amp; SEO</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Manage everything on {orgName}&apos;s public site — articles, homepage copy, portfolio,
            reviews, and the on-page SEO. This is the only area you can access.
          </p>
        </div>

        <Panel icon={FileText} title="Articles" brand={brand}>
          <PostsManager initial={(posts ?? []) as never} siteUrl={siteUrl} orgId={orgId} />
        </Panel>

        <Panel icon={Megaphone} title="Homepage" brand={brand}>
          <SplashSettings settings={marketing} orgId={orgId} />
        </Panel>

        <Panel icon={FileText} title="SEO &amp; specialty" brand={brand}>
          <SiteSeoFields settings={marketing} orgId={orgId} />
        </Panel>

        <Panel icon={Images} title="Portfolio photos" brand={brand}>
          <PortfolioManager orgId={orgId} initial={marketing.portfolio ?? []} />
        </Panel>

        <Panel icon={Star} title="Reviews" brand={brand}>
          <ReviewsManager initial={marketing.reviews ?? []} orgId={orgId} />
        </Panel>
      </main>
    </div>
  );
}
