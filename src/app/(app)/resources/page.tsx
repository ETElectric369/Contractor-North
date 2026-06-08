import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { ResourcesManager } from "./resources-manager";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const supabase = await createClient();
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
      <ResourcesManager resources={(resources ?? []) as any} />
    </div>
  );
}
