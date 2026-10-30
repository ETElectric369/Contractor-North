import { PageHeader } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { currentLang } from "@/lib/current-lang";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { orgTrade } from "@/lib/org-trade";
import { ToolsView } from "./tools-view";

export const dynamic = "force-dynamic";

export default async function ToolsPage() {
  // The org's trade decides which calculator packages open by default. Ten of the twenty-four
  // tools are electrical, so without this a deck builder's tools page is 40% somebody else's job.
  const supabase = await createClient();
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const trade = orgTrade(getOrgSettings((org as { settings?: unknown } | null)?.settings)).key;
  // The title and its line in the person's language (cn-v1139): nv_page_ / nv_desc_ in lib/words/nav.
  const t = translator(await currentLang());

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("nv_page_tools")} description={t("nv_desc_tools")} />
      <ToolsView trade={trade} />
    </div>
  );
}
