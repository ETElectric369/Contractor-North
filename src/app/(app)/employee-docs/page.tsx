import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
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
  if (!me || !["owner", "admin", "office"].includes(me.role)) redirect("/dashboard");

  const [{ data: employees }, { data: docRows }] = await Promise.all([
    supabase.from("profiles").select("id, full_name").order("full_name"),
    supabase
      .from("employee_documents")
      .select("id, profile_id, type, name, file_url, expires_date, created_at")
      .order("created_at", { ascending: false }),
  ]);

  const docs = await Promise.all(
    (docRows ?? []).map(async (d: any) => {
      const { data } = await supabase.storage.from("documents").createSignedUrl(d.file_url, 3600);
      return { ...d, signedUrl: data?.signedUrl ?? null };
    }),
  );

  return (
    <div>
      <PageHeader
        title="Employee Documents"
        description="Driver's licenses, I-9, W-2, and certifications — stored securely (staff only)."
      />
      <EmployeeDocsManager orgId={me.org_id} employees={employees ?? []} docs={docs as any} />
    </div>
  );
}
