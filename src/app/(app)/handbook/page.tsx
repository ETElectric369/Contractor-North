import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { getOrgSettings } from "@/lib/org-settings";
import { PhoneSetupChecklist } from "@/components/phone-setup-checklist";
import { HandbookView } from "./handbook-view";

export const dynamic = "force-dynamic";

export default async function HandbookPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ data: me }, { data: org }] = await Promise.all([
    supabase.from("profiles").select("role, language").eq("id", user?.id ?? "").maybeSingle(),
    supabase.from("organizations").select("settings, name").limit(1).maybeSingle(),
  ]);
  const settings = getOrgSettings((org as any)?.settings);
  const isAdmin = !!me && ["owner", "admin"].includes(me.role);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Employee handbook"
        description={`Policies and expectations at ${(org as any)?.name ?? "the company"}.`}
      />
      {/* The checklist in the person's language (cn-v1138): profiles.language rides the role read. */}
      <PhoneSetupChecklist lang={(me as { language?: string | null } | null)?.language ?? null} />
      <HandbookView text={settings.employee_handbook} isAdmin={isAdmin} />
    </div>
  );
}
