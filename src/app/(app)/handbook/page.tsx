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
    supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle(),
    supabase.from("organizations").select("settings, name").limit(1).maybeSingle(),
  ]);
  const settings = getOrgSettings((org as any)?.settings);
  const isAdmin = !!me && ["owner", "admin"].includes(me.role);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Employee Handbook"
        description={`Policies and expectations at ${(org as any)?.name ?? "the company"}.`}
      />
      <PhoneSetupChecklist />
      <HandbookView text={settings.employee_handbook} isAdmin={isAdmin} />
    </div>
  );
}
