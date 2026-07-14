import Link from "next/link";
import { ListChecks } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { NewListButton } from "./new-list-button";
import { jobLabel } from "@/lib/schedule-options";

export const dynamic = "force-dynamic";

export default async function MaterialsPage() {
  const supabase = await createClient();

  const [{ data: lists }, { data: jobs }] = await Promise.all([
    supabase
      .from("material_lists")
      .select("*, jobs(job_number, name), material_list_items(id)")
      .order("created_at", { ascending: false }),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const materialLists = lists ?? [];

  return (
    <div>
      <PageHeader
        title="Material lists"
        description="Take-offs for jobs — build by hand or generate with AI."
      >
        <NewListButton jobs={jobs ?? []} />
      </PageHeader>

      {materialLists.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No material lists yet"
          description="Generate a take-off from a scope of work, or start an empty list."
        >
          <NewListButton jobs={jobs ?? []} />
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {materialLists.map((l: any) => (
            <Link key={l.id} href={`/materials/${l.id}`}>
              <Card className="h-full p-5 transition-shadow hover:shadow-md">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-light">
                    <ListChecks className="h-5 w-5 text-brand" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-900">
                      {l.name}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      {l.material_list_items?.length ?? 0} items ·{" "}
                      {formatDate(l.created_at)}
                    </div>
                    {l.jobs?.name && (
                      <div className="mt-1 truncate text-xs text-slate-500">
                        {jobLabel(l.jobs)}
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
