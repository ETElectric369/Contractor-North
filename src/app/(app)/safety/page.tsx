import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { featureOn } from "@/lib/features";
import { viewerSwitches } from "@/lib/viewer-switches";
import { PageHeader } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { currentLangFor } from "@/lib/current-lang";
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
  // The switch off (0352): the page still opens under the shell's Off line, and existing rows keep
  // edit and delete, but nothing new is added here until it's back on.
  const canAdd = canEdit && featureOn((await viewerSwitches()).features, "safety_log");
  const [{ data: records }, { data: employees }, { data: jobs }] = await Promise.all([
    supabase
      .from("safety_records")
      .select("id, kind, record_date, title, profile_id, job_id, severity, recordable, description, attendees, profiles:profile_id(full_name), jobs(name)")
      .order("record_date", { ascending: false })
      .limit(500),
    supabase.from("profiles").select("id, full_name").order("full_name"),
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
  ]);

  // The title and its line in the person's language (cn-v1139): nv_page_ / nv_desc_ in lib/words/nav.
  const t = translator(await currentLangFor(user?.id));

  return (
    <div>
      <PageHeader title={t("nv_page_safety")} description={t("nv_desc_safety")} />
      <SafetyManager employees={employees ?? []} jobs={jobs ?? []} records={(records ?? []) as any} canEdit={canEdit} canAdd={canAdd} />
    </div>
  );
}
