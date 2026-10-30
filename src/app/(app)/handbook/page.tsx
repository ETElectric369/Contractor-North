import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { fillText, translator } from "@/lib/i18n";
import { currentLangFor } from "@/lib/current-lang";
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
  // The title and its line in the person's language (cn-v1139): the line names the company, or the
  // catalog's stand-in ("the company" / "la empresa") when it has no name yet.
  const t = translator(await currentLangFor(user?.id));

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={t("nv_page_handbook")}
        description={fillText(t("nv_desc_handbook"), { company: (org as any)?.name ?? t("nv_desc_handbookCompany") })}
      />
      {/* The checklist in the person's language (cn-v1138): profiles.language rides the role read. */}
      <PhoneSetupChecklist lang={(me as { language?: string | null } | null)?.language ?? null} />
      <HandbookView text={settings.employee_handbook} isAdmin={isAdmin} />
    </div>
  );
}
