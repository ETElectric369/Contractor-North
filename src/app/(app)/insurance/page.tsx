import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { InsuranceManager } from "./insurance-manager";
import { INSURANCE_FILTER } from "@/lib/compliance-types";

export const dynamic = "force-dynamic";

export default async function InsurancePage() {
  const supabase = await createClient();
  // Insurance lives in the shared compliance tracker (compliance_items). This view routes the
  // policy types here; the default-typed legacy "Insurance" rows come along too.
  const { data: items } = await supabase
    .from("compliance_items")
    .select("id, type, name, policy_number, amount, issued_date, expires_date, notes")
    .in("type", INSURANCE_FILTER)
    .order("expires_date", { ascending: true, nullsFirst: false });

  return (
    <div>
      <PageHeader
        title="Insurance"
        description="Policies & coverage — workers' comp, general liability, auto — with renewal alerts so nothing lapses."
      />
      <InsuranceManager items={(items ?? []) as any} />
    </div>
  );
}
