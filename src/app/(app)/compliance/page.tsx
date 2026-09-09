import { signDocumentUrls } from "@/lib/signed-docs";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { ComplianceManager } from "./compliance-manager";
import { EXCLUDED_FROM_COMPLIANCE } from "@/lib/compliance-types";

export const dynamic = "force-dynamic";

export default async function CompliancePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  const { data: all } = await supabase
    .from("compliance_items")
    .select("id, type, name, policy_number, amount, issued_date, expires_date, notes, file_url")
    .order("expires_date", { ascending: true, nullsFirst: false });
  // Compliance is the catch-all: insurance lives on /insurance and audits on /audits, so a record
  // shows on exactly one page (no double-listing, no audit mislabeled by the renewal manager).
  const filtered = (all ?? []).filter((i: { type?: string }) => !EXCLUDED_FROM_COMPLIANCE.has(i.type ?? ""));

  // Imported documents live in the private "documents" bucket — sign view links server-side
  // (same rails as insurance certificates) so a filed license/permit doc is one tap away.
  // ONE batch call (2026-09-08 phone-lag sweep); a storage hiccup or a stale path drops that
  // one link rather than white-screening the page.
  const urls = await signDocumentUrls(supabase, filtered.map((i: { file_url?: string | null }) => i.file_url));
  const items = filtered.map((i: { file_url?: string | null }) => ({
    ...i,
    signedUrl: ((i.file_url && urls.get(i.file_url)) || null) as string | null,
  }));

  return (
    <div>
      <PageHeader
        title="Compliance"
        description="Licenses, certifications & permits — with renewal alerts so nothing lapses. (Policies live in Insurance; reviews in Audits.)"
      />
      <ComplianceManager items={items as any} orgId={me?.org_id ?? ""} />
    </div>
  );
}
