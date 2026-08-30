import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { isStaffRole } from "@/lib/actions/perms";
import { companyFromOrg } from "@/components/doc-letterhead";
import { PageHeader } from "@/components/page-header";
import { DocStudio } from "./studio";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * THE DOCUMENT STUDIO — Erik: "we need have something real built in... see what you can wow me
 * with." A full-page designer where the ACTUAL document components render live and the layout is
 * grabbed directly on the page (margins, column spacing, logo), design-studio spirit. The two
 * settings cards (Document designer's templates + Document layout's knobs) mold into this one
 * surface; Settings keeps a single door that links here.
 */
export default async function DocStudioPage() {
  const supabase = await createClient();
  // Staff surface, same gate as /site-studio — the actions are staff-gated anyway; the page
  // matching them keeps a tech from landing on an empty husk of a studio.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  if (!me || !isStaffRole((me as { role?: string }).role)) redirect("/timeclock");

  const { data: org } = await supabase.from("organizations").select("*").limit(1).maybeSingle();
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const co = companyFromOrg((org as Organization) ?? null);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Document studio"
        description="The real page, in your hands — drag the bars, click the logo, switch templates. Every change saves itself and restyles every estimate, invoice, PDF, and customer link."
      />
      <DocStudio
        co={co as unknown as Record<string, unknown>}
        initialStyle={settings.doc_style}
        initialTemplates={((org as Organization | null)?.doc_templates as Record<string, string>) || {}}
        fallbackTemplate={((org as Organization | null)?.doc_template as string) || "classic"}
        terms={{ invoice: settings.invoice_terms, quote: settings.quote_terms }}
        documentFooter={settings.document_footer}
      />
    </div>
  );
}
