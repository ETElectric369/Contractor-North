import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PageHeader } from "@/components/page-header";
import { FeatureOffLineFor } from "@/components/feature-off-line-for";
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
  // Audits ride on the shared compliance tracker (compliance_items), filtered to audit types.
  const { data: items } = await supabase
    .from("compliance_items")
    .select("id, type, name, policy_number, amount, issued_date, expires_date, notes")
    .in("type", AUDIT_TYPES)
    .order("expires_date", { ascending: true, nullsFirst: false });

  return (
    <div>
      <PageHeader
        title="Audits"
        description="Safety, OSHA, insurance & financial audits — findings, follow-up dates, nothing missed."
      />
      <FeatureOffLineFor feature="licenses" />
      <AuditsManager items={(items ?? []) as any} canEdit={canEdit} />
    </div>
  );
}
