import { FileSpreadsheet } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function FormsPage() {
  const supabase = await createClient();
  const { data: forms } = await supabase
    .from("forms")
    .select("id, name, description")
    .eq("active", true);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <ComingSoon
        title="Forms"
        description="Field forms — safety checklists, inspections, sign-offs."
        icon={FileSpreadsheet}
        planned={[
          "Build custom forms with a drag-and-drop editor",
          "Fill forms in the field, attach to jobs",
          "Photo and signature fields",
          "Export submissions to PDF",
        ]}
      />

      {forms && forms.length > 0 && (
        <Card>
          <CardContent className="py-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-900">
              Available form templates
            </h3>
            <ul className="space-y-2">
              {forms.map((f) => (
                <li key={f.id} className="rounded-lg border border-slate-100 px-4 py-3">
                  <div className="text-sm font-medium text-slate-900">{f.name}</div>
                  {f.description && (
                    <div className="text-xs text-slate-500">{f.description}</div>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
