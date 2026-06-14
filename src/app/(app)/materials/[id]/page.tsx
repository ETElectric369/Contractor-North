import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Briefcase } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";
import { ItemEditor } from "./item-editor";
import { DeleteListButton } from "./delete-list-button";
import { NewPoButton } from "../../purchasing/new-po-button";
import { SectionMapButton } from "@/components/section-map-button";
import { materialListSectionTree } from "@/lib/nav-tree";

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

  const { data: items } = await supabase
    .from("material_list_items")
    .select("*")
    .eq("list_id", id)
    .order("sort_order")
    .order("created_at", { ascending: true });

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/materials"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to material lists
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{l.name}</h1>
          <div className="mt-1 flex items-center gap-3 text-sm text-slate-400">
            <span>Created {formatDate(l.created_at)}</span>
            {l.jobs && (
              <Link
                href={`/work-orders?job=${l.jobs.id}`}
                className="flex items-center gap-1 hover:text-brand"
              >
                <Briefcase className="h-3.5 w-3.5" /> {l.jobs.name}
              </Link>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SectionMapButton tree={materialListSectionTree(l.id, l.name, { jobId: l.jobs?.id ?? null })} />
          <NewPoButton
            jobs={l.jobs ? [{ id: l.jobs.id, job_number: l.jobs.job_number, name: l.jobs.name }] : []}
            lists={[{ id: l.id, name: l.name }]}
          />
          <DeleteListButton listId={l.id} />
        </div>
      </div>

      <ItemEditor listId={l.id} items={items ?? []} />
    </div>
  );
}
