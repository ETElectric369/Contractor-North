import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { isStaffRole } from "@/lib/actions/perms";
import { extractSiteDoc } from "@/lib/site-doc";
import { PageHeader } from "@/components/page-header";
import { SiteStudio } from "./studio";

export const dynamic = "force-dynamic";

/**
 * THE DESIGN STUDIO (Erik: "GO GO") — talk to the designer, watch the actual site, publish when
 * it's right. Versions, never edits: nothing on this page touches the live site except the
 * Publish button, and rollback is publishing an older version.
 */
export default async function SiteStudioPage() {
  const supabase = await createClient();
  // Staff surface, gated like payroll/analytics — the actions are staff-gated anyway; the page
  // matching them keeps a tech from landing on an empty husk of a studio.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  if (!me || !isStaffRole((me as { role?: string }).role)) redirect("/timeclock");

  const [{ data: org }, { data: versions }, { data: publishedRow }] = await Promise.all([
    supabase.from("organizations").select("id, settings").limit(1).maybeSingle(),
    supabase
      .from("site_versions")
      .select("id, v, note, status, created_at, doc")
      .order("v", { ascending: false })
      .limit(50),
    // The published version explicitly — after enough passes it falls off the latest-50 window,
    // and everything downstream (drift banner, "live" badge, publish-diff) keys off it.
    supabase
      .from("site_versions")
      .select("id, v, note, status, created_at, doc")
      .eq("status", "published")
      .maybeSingle(),
  ]);
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const liveDoc = extractSiteDoc((org as { settings?: unknown } | null)?.settings);

  return (
    <div>
      <PageHeader
        title="Design studio"
        description="Describe the change; a new version appears in the preview. Nothing goes live until you publish — and any older version can be published again."
      />
      <SiteStudio
        orgId={String((org as { id?: string } | null)?.id ?? "")}
        handle={settings.public_handle?.trim() || null}
        liveDoc={liveDoc}
        versions={(() => {
          const rows = [...(versions ?? [])];
          // Keep the published row visible even when it ages out of the window.
          if (publishedRow && !rows.some((r) => (r as { id?: unknown }).id === (publishedRow as { id?: unknown }).id))
            rows.push(publishedRow);
          return rows.map((r: Record<string, unknown>) => ({
            id: String(r.id),
            v: Number(r.v),
            note: (r.note as string | null) ?? null,
            status: String(r.status),
            created_at: String(r.created_at ?? ""),
            doc: r.doc,
          }));
        })()}
      />
    </div>
  );
}
