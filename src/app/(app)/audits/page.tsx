import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { featureOn } from "@/lib/features";
import { viewerSwitches } from "@/lib/viewer-switches";
import { PageHeader } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { currentLangFor } from "@/lib/current-lang";
import { AuditsManager } from "./audits-manager";
import { AUDIT_TYPES } from "@/lib/compliance-types";

export const dynamic = "force-dynamic";

export default async function AuditsPage() {
  const supabase = await createClient();
  // A tech reads; every write here is requireStaff, so its doors don't render for him.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  const canEdit = isStaffRole(me?.role);
  // The switch off (0352): the page still opens under the shell's Off line, and existing rows keep
  // edit and delete, but nothing new is added here until it's back on.
  const canAdd = canEdit && featureOn((await viewerSwitches()).features, "licenses");
  // Audits ride on the shared compliance tracker (compliance_items), filtered to audit types.
  const { data: items } = await supabase
    .from("compliance_items")
    .select("id, type, name, policy_number, amount, issued_date, expires_date, notes")
    .in("type", AUDIT_TYPES)
    .order("expires_date", { ascending: true, nullsFirst: false });

  // The title and its line in the person's language (cn-v1139): nv_page_ / nv_desc_ in lib/words/nav.
  const t = translator(await currentLangFor(user?.id));

  return (
    <div>
      <PageHeader title={t("nv_page_audits")} description={t("nv_desc_audits")} />
      <AuditsManager items={(items ?? []) as any} canEdit={canEdit} canAdd={canAdd} />
    </div>
  );
}
