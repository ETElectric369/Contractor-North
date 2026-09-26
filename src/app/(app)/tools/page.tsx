import { PageHeader } from "@/components/page-header";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { ToolsView } from "./tools-view";

export const dynamic = "force-dynamic";

export default async function ToolsPage() {
  // The org's trade decides which calculator packages open by default. Ten of the twenty-four
  // tools are electrical, so without this a deck builder's tools page is 40% somebody else's job.
  const supabase = await createClient();
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const trade = getOrgSettings((org as { settings?: unknown } | null)?.settings).trade_label;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Tools"
        description="Field calculators — measurements, materials, margins."
      />
      <ToolsView trade={trade} />
    </div>
  );
}
