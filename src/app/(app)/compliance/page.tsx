import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { ComplianceManager } from "./compliance-manager";

export const dynamic = "force-dynamic";

export default async function CompliancePage() {
  const supabase = await createClient();
  const { data: items } = await supabase
    .from("compliance_items")
    .select("id, type, name, policy_number, amount, issued_date, expires_date, notes")
    .order("expires_date", { ascending: true, nullsFirst: false });

  return (
    <div>
      <PageHeader
        title="Compliance"
        description="Insurance, workers' comp, bonds & licenses — with renewal alerts so nothing lapses."
      />
      <ComplianceManager items={(items ?? []) as any} />
    </div>
  );
}
