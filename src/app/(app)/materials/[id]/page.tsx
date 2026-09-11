import Link from "next/link";
import { notFound } from "next/navigation";
import { jobSiteLabel } from "@/lib/schedule-options";
import { Briefcase, ListChecks } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";
import { isStaffRole } from "@/lib/actions/perms";
import { TECH_ITEM_COLUMNS } from "@/lib/materials-columns";
import { ItemEditor } from "./item-editor";
import { RenameListButton } from "./rename-list-button";
import { NeedMaterials } from "../need-materials";
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

  // Viewer role rides alongside the list read — same shape as the job hub. RLS is
  // the boundary (0004: <t>_write needs is_org_staff(); reads are org-wide by 0056's
  // choice); this just decides which of the two views of the ONE list to draw.
  const [{ data: list }, { data: { user } }] = await Promise.all([
    supabase
      .from("material_lists")
      .select("*, jobs(id, job_number, name, address, customers(name))")
      .eq("id", id)
      .maybeSingle(),
    supabase.auth.getUser(),
  ]);

  if (!list) notFound();
  const l = list as any;

  const { data: meRow } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  const viewerIsStaff = isStaffRole((meRow as any)?.role ?? "");

  // material_list_items has no created_at column — ordering by it errored the
  // whole query, so items silently never loaded. Order by sort_order only.
  // Pull the org's jobs (RLS-scoped) so the edit control can re-link this list —
  // staff only; a tech has no relink control, so his page doesn't pay for the read.
  const [{ data: items }, { data: jobs }] = await Promise.all([
    supabase
      .from("material_list_items")
      .select(viewerIsStaff ? "*" : TECH_ITEM_COLUMNS)
      .eq("list_id", id)
      .order("sort_order"),
    viewerIsStaff
      ? supabase
          .from("jobs")
          .select("id, job_number, name")
          .order("created_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: null }),
  ]);

  const jobId: string | null = l.jobs?.id ?? l.job_id ?? null;
  // A list with no job is a quote's take-off or a work order's sheet — office paper.
  // A tech can land here from a link, so it renders, but read-only with one sentence
  // saying whose it is rather than an editor whose every save would refuse.
  const techReadOnly = !viewerIsStaff && !jobId;
  const keeperNoun = l.quote_id ? "a quote" : l.work_order_id ? "a work order" : "no job";

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink fallback="/materials" fallbackLabel="Back to Material Lists" />

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            {/* customer · address as the headline (cn-v829); the derived list name steps down to the meta row. */}
            <h1 className="text-2xl font-bold text-slate-900">{l.jobs ? jobSiteLabel({ ...l.jobs, customer_name: l.jobs.customers?.name ?? null }) : l.name}</h1>
            {/* Rename / relink is list-level office work (material_lists write = staff). */}
            {viewerIsStaff && (
              <RenameListButton listId={l.id} name={l.name} jobId={jobId} jobs={jobs ?? []} />
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 text-sm text-slate-400">
            {l.jobs && <span className="text-slate-500">{l.name}</span>}
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
            The job link lives in the meta row above, so it's not duplicated.
            THE WHOLE ROW IS STAFF: the pick-list print carries est. cost, a PO is
            money, Delete is the office's — none of it is a door a tech can go through,
            so none of it is drawn for him (nothing silent, no dead ends). */}
        {viewerIsStaff && (
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/print/pdf-preview?doc=material-list&id=${l.id}&back=/materials/${l.id}`}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <ListChecks className="h-4 w-4 shrink-0" /> Pick List
            </Link>
            <NewPoButton
              jobs={l.jobs ? [{ id: l.jobs.id, job_number: l.jobs.job_number, name: l.jobs.name }] : []}
              lists={[{ id: l.id, name: l.name }]}
              defaultJobId={l.jobs?.id}
              defaultListId={l.id}
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
        )}
      </div>

      {techReadOnly ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            This list belongs to {keeperNoun} &mdash; the office keeps it.
          </p>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {((items ?? []) as any[]).map((it) => (
              <li key={it.id} className="flex items-center gap-2 px-4 py-3 text-sm">
                <span className={it.purchased ? "text-slate-400 line-through" : "text-slate-800"}>{it.description}</span>
                <span className="ml-auto shrink-0 text-xs text-slate-400">
                  {it.part_number ? `#${it.part_number} · ` : ""}
                  {it.quantity ?? ""} {it.unit ?? ""}
                </span>
              </li>
            ))}
            {(items ?? []).length === 0 && <li className="px-4 py-6 text-center text-slate-400">No items on this list.</li>}
          </ul>
        </div>
      ) : (
        <div className="space-y-3">
          {/* THE SAME editor for both roles (Erik, 2026-09-11) — viewerIsStaff only
              strips the money. My Day's "Materials" button lands a clocked-in tech
              right here, so the ask-the-office door rides under the list here too,
              exactly as it does on the job's Materials tab. */}
          <ItemEditor listId={l.id} items={(items ?? []) as any} viewerIsStaff={viewerIsStaff} />
          {!viewerIsStaff && jobId && <NeedMaterials jobId={jobId} />}
        </div>
      )}
    </div>
  );
}
