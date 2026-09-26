import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PageHeader } from "@/components/page-header";
import { SafetyManager } from "./safety-manager";

export const dynamic = "force-dynamic";

export default async function SafetyPage() {
  const supabase = await createClient();
  // A tech reads; every write here is requireStaff, so its doors don't render for him.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  const canEdit = isStaffRole(me?.role);
  const [{ data: records }, { data: employees }, { data: jobs }] = await Promise.all([
    supabase
      .from("safety_records")
      .select("id, kind, record_date, title, profile_id, job_id, severity, recordable, description, attendees, profiles:profile_id(full_name), jobs(name)")
      .order("record_date", { ascending: false })
      .limit(500),
    supabase.from("profiles").select("id, full_name").order("full_name"),
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
  ]);

  return (
    <div>
      <PageHeader title="Safety / OSHA" description="Log incidents (OSHA recordables) and toolbox-talk safety meetings." />
      <SafetyManager employees={employees ?? []} jobs={jobs ?? []} records={(records ?? []) as any} canEdit={canEdit} />
    </div>
  );
}
