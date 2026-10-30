import { signDocumentUrls } from "@/lib/signed-docs";
import { redirect } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { currentLangFor } from "@/lib/current-lang";
import { EmployeeDocsManager } from "./employee-docs-manager";

export const dynamic = "force-dynamic";

export default async function EmployeeDocsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("org_id, role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  if (!me || !isStaffRole(me.role)) redirect("/planner");

  const [{ data: employees }, { data: docRows }] = await Promise.all([
    supabase.from("profiles").select("id, full_name").order("full_name"),
    supabase
      .from("employee_documents")
      .select("id, profile_id, type, name, file_url, expires_date, notes, created_at")
      .order("created_at", { ascending: false }),
  ]);

  // ONE signing call for the whole list (2026-09-08 phone-lag sweep).
  const urls = await signDocumentUrls(supabase, (docRows ?? []).map((d: any) => d.file_url));
  const docs = (docRows ?? []).map((d: any) => ({
    ...d,
    signedUrl: (d.file_url && urls.get(d.file_url)) || null,
  }));

  // The title and its line in the person's language (cn-v1139): nv_page_ / nv_desc_ in lib/words/nav.
  const t = translator(await currentLangFor(user?.id));

  return (
    <div>
      <PageHeader title={t("nv_page_employeeDocs")} description={t("nv_desc_employeeDocs")} />
      <EmployeeDocsManager orgId={me.org_id} employees={employees ?? []} docs={docs as any} />
    </div>
  );
}
