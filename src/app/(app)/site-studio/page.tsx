import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
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
  const [{ data: org }, { data: versions }] = await Promise.all([
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    supabase
      .from("site_versions")
      .select("id, v, note, status, created_at, doc")
      .order("v", { ascending: false })
      .limit(50),
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
        handle={settings.public_handle?.trim() || null}
        liveDoc={liveDoc}
        versions={(versions ?? []).map((r: Record<string, unknown>) => ({
          id: String(r.id),
          v: Number(r.v),
          note: (r.note as string | null) ?? null,
          status: String(r.status),
          created_at: String(r.created_at ?? ""),
          doc: r.doc,
        }))}
      />
    </div>
  );
}
