import { signDocumentUrls } from "@/lib/signed-docs";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { InsuranceManager } from "./insurance-manager";
import { INSURANCE_FILTER } from "@/lib/compliance-types";

export const dynamic = "force-dynamic";

export default async function InsurancePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", user?.id ?? "")
    .maybeSingle();

  // Insurance lives in the shared compliance tracker (compliance_items). This view routes the
  // policy types here; the default-typed legacy "Insurance" rows come along too.
  const { data: items } = await supabase
    .from("compliance_items")
    .select("id, type, name, policy_number, amount, issued_date, expires_date, notes, file_url")
    .in("type", INSURANCE_FILTER)
    .order("expires_date", { ascending: true, nullsFirst: false });

  // Certificates live in the private "documents" bucket — sign view links server-side
  // (the employee-docs rails), in ONE batch call (2026-09-08 phone-lag sweep).
  const urls = await signDocumentUrls(supabase, ((items ?? []) as any[]).map((i) => i.file_url));
  const withDocs = ((items ?? []) as any[]).map((i) => ({
    ...i,
    signedUrl: ((i.file_url && urls.get(i.file_url)) || null) as string | null,
  }));

  return (
    <div>
      <PageHeader
        title="Insurance"
        description="Policies & coverage — workers' comp, general liability, auto — with renewal alerts so nothing lapses."
      />
      <InsuranceManager items={withDocs as any} orgId={me?.org_id ?? ""} />
    </div>
  );
}
