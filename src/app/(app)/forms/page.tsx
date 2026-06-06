import Link from "next/link";
import { FileSpreadsheet, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { NewFormButton } from "./new-form-button";

export const dynamic = "force-dynamic";

export default async function FormsPage() {
  const supabase = await createClient();

  const { data: forms } = await supabase
    .from("forms")
    .select("id, name, description, schema, form_submissions(id)")
    .eq("active", true)
    .order("created_at", { ascending: false });

  const list = forms ?? [];

  return (
    <div>
      <PageHeader
        title="Forms"
        description="Field forms — safety checklists, inspections, sign-offs."
      >
        <NewFormButton />
      </PageHeader>

      {list.length === 0 ? (
        <EmptyState
          icon={FileSpreadsheet}
          title="No forms yet"
          description="Build a custom form your crew can fill out in the field."
        >
          <NewFormButton />
        </EmptyState>
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
