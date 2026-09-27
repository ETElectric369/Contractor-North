import Link from "next/link";
import { FileSpreadsheet, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { FeatureOffLine } from "@/components/feature-off-line";
import { viewerSwitches } from "@/lib/viewer-switches";
import { featureOn } from "@/lib/features";
import { NewFormButton } from "./new-form-button";

export const dynamic = "force-dynamic";

/** A crew checklist: any form that is neither a walk-through sheet (Leads') nor the website's
 *  intake form. The one rule forms/[id]'s Off line and 0355's Safety Log count use. */
const isChecklist = (f: { is_inspection?: boolean | null; is_public_intake?: boolean | null }) =>
  !f.is_inspection && !f.is_public_intake;

export default async function FormsPage() {
  const supabase = await createClient();
  // A tech fills forms (0195) but can't build one: New Form is staff-only.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ data: me }, { data: forms }, sw] = await Promise.all([
    supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle(),
    supabase
      .from("forms")
      .select("id, name, description, schema, is_inspection, is_public_intake, form_submissions(id)")
      .eq("active", true)
      .order("created_at", { ascending: false }),
    viewerSwitches(),
  ]);
  const isStaff = isStaffRole(me?.role);

  // SAFETY LOG (the switch board, 0352) owns the crew checklists, and only those: this page also
  // holds every company's walk-through sheet and intake form, so the dock row carries no switch.
  // Off, the checklists leave the list and New Form goes (a new form is one); each still opens
  // from its link under the Off line (forms/[id]), and the line here says why the list is shorter.
  const safetyOn = featureOn(sw.features, "safety_log");
  const list = (forms ?? []).filter((f) => safetyOn || !isChecklist(f));

  return (
    <div>
      <PageHeader
        title="Forms"
        description="Field forms — safety checklists, inspections, sign-offs."
      >
        {isStaff && safetyOn && <NewFormButton />}
      </PageHeader>

      <FeatureOffLine feature="safety_log" features={sw.features} isOwner={sw.isOwner} />

      {list.length === 0 ? (
        <EmptyState
          icon={FileSpreadsheet}
          title="No forms yet"
          description={
            !safetyOn
              ? "Crew checklists come with Safety Log."
              : isStaff
                ? "Build a custom form your crew can fill out in the field — New Form above."
                : "The office builds these."
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((f: any) => (
            <Link key={f.id} href={`/forms/${f.id}`}>
              <Card className="flex h-full items-start gap-3 p-5 transition-shadow hover:shadow-md">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-light">
                  <FileSpreadsheet className="h-5 w-5 text-brand" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-900">{f.name}</div>
                  {f.description && (
                    <div className="truncate text-xs text-slate-500">
                      {f.description}
                    </div>
                  )}
                  <div className="mt-1 text-xs text-slate-400">
                    {(f.schema?.length ?? 0)} fields ·{" "}
                    {f.form_submissions?.length ?? 0} submissions
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
