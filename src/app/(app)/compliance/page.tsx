import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { ComplianceManager } from "./compliance-manager";
import { EXCLUDED_FROM_COMPLIANCE } from "@/lib/compliance-types";

export const dynamic = "force-dynamic";

export default async function CompliancePage() {
  const supabase = await createClient();
  const { data: all } = await supabase
    .from("compliance_items")
    .select("id, type, name, policy_number, amount, issued_date, expires_date, notes")
    .order("expires_date", { ascending: true, nullsFirst: false });
  // Compliance is the catch-all: insurance lives on /insurance and audits on /audits, so a record
  // shows on exactly one page (no double-listing, no audit mislabeled by the renewal manager).
  const items = (all ?? []).filter((i: { type?: string }) => !EXCLUDED_FROM_COMPLIANCE.has(i.type ?? ""));

  return (
    <div>
      <PageHeader
        title="Compliance"
        description="Licenses, certifications & permits — with renewal alerts so nothing lapses. (Policies live in Insurance; reviews in Audits.)"
      />
      <ComplianceManager items={items as any} />
    </div>
  );
}
