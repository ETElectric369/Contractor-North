import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PageHeader } from "@/components/page-header";
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

  return (
    <div>
      <PageHeader
        title="Resources"
        description="Contacts for local building departments, inspectors, utilities, suppliers, and permit/records portals."
      />
      <ResourcesManager resources={(resources ?? []) as any} canEdit={canEdit} />
    </div>
  );
}
