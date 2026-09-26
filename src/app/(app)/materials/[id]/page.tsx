import Link from "next/link";
import { notFound } from "next/navigation";
import { jobSiteLabel } from "@/lib/schedule-options";
import { Briefcase, ListChecks } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/utils";
import { isStaffRole } from "@/lib/actions/perms";
import { TECH_ITEM_COLUMNS } from "@/lib/materials-columns";
import { ItemEditor } from "./item-editor";
import { RenameListButton } from "./rename-list-button";
import { NeedMaterials } from "../need-materials";
import { NewPoButton } from "../../purchasing/new-po-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { materialListSectionTree } from "@/lib/nav-tree";
import { canonicalMaterialListId, deleteMaterialList } from "../actions";
import { TookFromStock } from "../took-from-stock";
import { jobTakes } from "@/lib/stock-ledger";
import { reportError } from "@/lib/observe";

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

  const jobId: string | null = l.jobs?.id ?? l.job_id ?? null;

  // material_list_items has no created_at column — ordering by it errored the
  // whole query, so items silently never loaded. Order by sort_order only.
  // Pull the org's jobs (RLS-scoped) so the edit control can re-link this list —
  // staff only; a tech has no relink control, so his page doesn't pay for the read.
  // The canonical-list read rides the same wave rather than adding a fourth serial trip.
  const [{ data: items }, { data: jobs }, canonical, takes] = await Promise.all([
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
    jobId ? canonicalMaterialListId(jobId) : Promise.resolve({ id: null as string | null }),
    // The job's takes from stock (0344), for the Took From Stock door under the list. No cost.
    jobId ? jobTakes(supabase, jobId) : Promise.resolve({ takes: [], missing: true, error: null }),
  ]);
  // A takes read that fails is logged and said in the list's place, never an empty list.
  if (takes.error) reportError("materials.page.stockTakes", takes.error, { jobId, listId: id });

  // A list with no job is a quote's take-off or a work order's sheet — office paper.
  // A tech can land here from a link, so it renders, but read-only with one sentence
  // saying whose it is rather than an editor whose every save would refuse.
  const techReadOnly = !viewerIsStaff && !jobId;
  const keeperNoun = l.quote_id ? "a quote" : l.work_order_id ? "a work order" : "no job";

  // A SUPERSEDED LIST IS A TRAP, SO IT STOPS BEING AN EDITOR (for every role).
  //
  // A job can end up with two lists — somebody types one by hand, then the accepted quote's
  // take-off is built and lands newer (createMaterialListFromQuote keys its own idempotence on the
  // QUOTE, so it mints a second list rather than merging). Everything that reads the job — the job
  // hub's Materials tab, ensureJobMaterialList, My Day's Materials button — resolves to the NEWEST
  // list. This page did not: it happily drew the full editor on the old one, for techs too. A man
  // adding six items to it at the supply house was writing to rows nobody else opens, and nothing
  // on screen said so. That breaks the one-list-per-job law at the only door where it was still
  // breakable, so the old list becomes read-only here and says where the live one is.
  //
  // Canonical is decided in ONE place (canonicalMaterialListId) so this page and the job hub can
  // never disagree about which list is the job's.
  const canonicalId: string | null = (canonical as { id: string | null }).id;
  const supersededBy = jobId && canonicalId && canonicalId !== l.id ? canonicalId : null;
  const readOnly = techReadOnly || !!supersededBy;

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
            {/* A superseded list keeps only the office's clean-up doors. Printing a pick list from
                it would send somebody to the supply house with the wrong sheet, and a PO seeded
                from it would ORDER off rows the job no longer reads — so neither is offered.
                Delete stays: removing the stray is the whole point of landing here. */}
            {!supersededBy && (
              <>
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
              </>
            )}
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

      {readOnly ? (
        <div className="space-y-3">
          {supersededBy ? (
            /* NO DEAD ENDS: say what happened and where the live list is, in one breath. */
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-sm text-amber-900">
                This list was replaced. The job&rsquo;s materials list is a newer one, and that is the
                list everybody works from. Anything added here would not show up on the job. The
                items below are kept so nothing is lost.
              </p>
              <Link
                href={`/materials/${supersededBy}`}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
              >
                <ListChecks className="h-4 w-4 shrink-0" /> Open the Job&rsquo;s List
              </Link>
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              This list belongs to {keeperNoun} &mdash; the office keeps it.
            </p>
          )}
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {((items ?? []) as any[]).map((it) => (
              <li key={it.id} className="flex items-center gap-2 px-4 py-3 text-sm">
                <span className={it.purchased ? "text-slate-400 line-through" : "text-slate-800"}>{it.description}</span>
                <span className="ml-auto shrink-0 text-xs text-slate-400">
                  {it.part_number ? `#${it.part_number} · ` : ""}
                  {it.quantity ?? ""} {it.unit ?? ""}
                  {/* The office reads this view too now (a superseded list is read-only for
                      everyone), and it may be reading it to decide what to carry across, so the
                      cost stays visible to staff. A tech's projection never selects the column. */}
                  {viewerIsStaff && it.est_cost != null && ` · ${formatCurrency(Number(it.est_cost))}`}
                </span>
              </li>
            ))}
            {(items ?? []).length === 0 && <li className="px-4 py-6 text-center text-slate-400">No items on this list.</li>}
          </ul>
        </div>
      ) : (
        <div className="space-y-3">
          {/* TOOK FROM STOCK (Phase 3): the job's list is a job's, so the shelf door rides here too,
              the same button and the same takes as the job's Materials tab. */}
          {jobId && <TookFromStock jobId={jobId} takes={takes.takes} viewerIsStaff={viewerIsStaff} readFailed={!!takes.error} />}
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
