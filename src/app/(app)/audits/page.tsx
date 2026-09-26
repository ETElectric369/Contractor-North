import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { FeatureOffLine } from "@/components/feature-off-line";
import { readViewerFeatures } from "@/lib/viewer-features";
import { AuditsManager } from "./audits-manager";
import { AUDIT_TYPES } from "@/lib/compliance-types";

export const dynamic = "force-dynamic";

export default async function AuditsPage() {
  const supabase = await createClient();
  // The switches ride beside the page's own reads, not after them.
  const viewerP = readViewerFeatures();
  // Audits ride on the shared compliance tracker (compliance_items), filtered to audit types.
  const { data: items } = await supabase
    .from("compliance_items")
    .select("id, type, name, policy_number, amount, issued_date, expires_date, notes")
    .in("type", AUDIT_TYPES)
    .order("expires_date", { ascending: true, nullsFirst: false });

  const viewer = await viewerP;
  return (
    <div>
      {/* Licenses & Insurance off (0352): still opens from a link, with the Off line on top. */}
      <FeatureOffLine feature="licenses" features={viewer.features} isOwner={viewer.isOwner} />
      <PageHeader
        title="Audits"
        description="Safety, OSHA, insurance & financial audits — findings, follow-up dates, nothing missed."
      />
      <AuditsManager items={(items ?? []) as any} />
    </div>
  );
}
