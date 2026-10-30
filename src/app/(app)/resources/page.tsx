import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PageHeader } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { currentLangFor } from "@/lib/current-lang";
import { ResourcesManager } from "./resources-manager";

export const dynamic = "force-dynamic";
// Fill From Their Site runs in this page's function: up to 8 s reading the site, then at most one
// small model call (12 s budget). 30 s holds both with room.
export const maxDuration = 30;

export default async function ResourcesPage() {
  const supabase = await createClient();
  // A tech reads; every write here is requireStaff, so its doors don't render for him.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  const canEdit = isStaffRole(me?.role);
  const { data: resources } = await supabase
    .from("resources")
    .select("id, name, category, contact_name, phone, email, website, address, notes")
    .order("name");

  // The title and its line in the person's language (cn-v1139): nv_page_ / nv_desc_ in lib/words/nav.
  const t = translator(await currentLangFor(user?.id));

  return (
    <div>
      {/* THE ONE HOME FOR THE PEOPLE A JOB ANSWERS TO (W2-13): suppliers and subcontractors are the
          company's vendors and live in Price List › Vendors (the form says so, office only). */}
      <PageHeader title={t("nv_page_resources")} description={t("nv_desc_resources")} />
      <ResourcesManager resources={(resources ?? []) as any} canEdit={canEdit} />
    </div>
  );
}
