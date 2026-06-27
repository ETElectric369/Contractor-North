import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { AuditsManager, AUDIT_TYPES } from "./audits-manager";

export const dynamic = "force-dynamic";

export default async function AuditsPage() {
  const supabase = await createClient();
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
      <AuditsManager items={(items ?? []) as any} />
    </div>
  );
}
