import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Briefcase, ListChecks } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";
import { ItemEditor } from "./item-editor";
import { RenameListButton } from "./rename-list-button";
import { NewPoButton } from "../../purchasing/new-po-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { materialListSectionTree } from "@/lib/nav-tree";
import { deleteMaterialList } from "../actions";

export const dynamic = "force-dynamic";

export default async function MaterialListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: list } = await supabase
    .from("material_lists")
    .select("*, jobs(id, job_number, name)")
    .eq("id", id)
    .maybeSingle();

  if (!list) notFound();
  const l = list as any;

  // material_list_items has no created_at column — ordering by it errored the
  // whole query, so items silently never loaded. Order by sort_order only.
  // Pull the org's jobs (RLS-scoped) so the edit control can re-link this list.
  const [{ data: items }, { data: jobs }] = await Promise.all([
    supabase
      .from("material_list_items")
      .select("*")
      .eq("list_id", id)
      .order("sort_order"),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/materials"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Material Lists
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-bold text-slate-900">{l.name}</h1>
            <RenameListButton listId={l.id} name={l.name} jobId={l.jobs?.id ?? l.job_id ?? null} jobs={jobs ?? []} />
          </div>
          <div className="mt-1 flex items-center gap-3 text-sm text-slate-400">
            <span>Created {formatDate(l.created_at)}</span>
            {l.jobs && (
              <Link
                href={`/jobs/${l.jobs.id}`}
                className="flex items-center gap-1 hover:text-brand"
              >
                <Briefcase className="h-3.5 w-3.5" /> {l.jobs.name}
              </Link>
            )}
          </div>
        </div>
        {/* Impulse verbs stay visible (Pick list / New PO); the ⋯ Actions menu
            rides LAST as the seek door — source estimate + Delete (danger, last).
            The job link lives in the meta row above, so it's not duplicated. */}
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/print/material-list/${l.id}`}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <ListChecks className="h-4 w-4 shrink-0" /> Pick List
          </Link>
          <NewPoButton
            jobs={l.jobs ? [{ id: l.jobs.id, job_number: l.jobs.job_number, name: l.jobs.name }] : []}
            lists={[{ id: l.id, name: l.name }]}
          />
          <SectionActionsMenu
            tree={materialListSectionTree(
              l.name,
              { quoteId: (l as any).quote_id ?? null },
              {
                run: deleteMaterialList.bind(null, l.id),
                confirm: "Delete this material list and all its items?",
              },
            )}
          />
        </div>
      </div>

      <ItemEditor listId={l.id} items={items ?? []} />
    </div>
  );
}
