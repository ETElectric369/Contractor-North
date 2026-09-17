import Link from "next/link";
import { ListChecks } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { isStaffRole } from "@/lib/actions/perms";
import { NewListButton } from "./new-list-button";
import { jobLabel, jobSiteLabel } from "@/lib/schedule-options";

export const dynamic = "force-dynamic";

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const supabase = await createClient();
  // ?job= — the job hub's quiet "other lists (N)" link lands here scoped to
  // that job's lists (the hub itself only ever shows the ONE canonical list).
  const [{ job: jobFilter }, { data: { user } }] = await Promise.all([searchParams, supabase.auth.getUser()]);
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  const isStaff = isStaffRole((me as { role?: string } | null)?.role ?? "");

  // created_at DESC then id DESC — the same pick canonicalMaterialListId makes, so "the first row
  // for this job" below is the same list the job hub and the crew's editor resolve to. The id is
  // the tiebreak: an ORDER BY with no tiebreak may come back in either order, and two renders
  // disagreeing about which list is the job's is exactly the bug this page is here to surface.
  let listQuery = supabase
    .from("material_lists")
    .select("*, jobs(job_number, name, address, customers(name)), material_list_items(id)")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (jobFilter) listQuery = listQuery.eq("job_id", jobFilter);
  // A TECH'S INDEX IS THE JOBS' LISTS (Erik, 2026-09-11): the one list per job he can
  // read and write. A list with no job is a quote's take-off or a work order's sheet —
  // office paper he can't do anything with, so it isn't offered. RLS already lets him
  // read them (0056, on purpose); this is the offer, not the boundary.
  if (!isStaff) listQuery = listQuery.not("job_id", "is", null);

  // The jobs read only feeds New List's job picker — a staff door — so a tech's
  // page skips the round trip along with the button.
  const [{ data: lists }, { data: jobs }] = await Promise.all([
    listQuery,
    isStaff
      ? supabase
          .from("jobs")
          .select("id, job_number, name")
          .order("created_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: null }),
  ]);

  // WHICH LIST IS THE JOB'S LIST, SAID OUT LOUD.
  //
  // A job can hold more than one list (a hand-typed one, then the accepted quote's take-off landing
  // newer). Everything that reads a job resolves to the newest, so the others are dead rows that
  // still looked live here — a card you could open and type into while nobody else saw a word of it.
  // The rows arrive newest-first, so the FIRST row for a job is that job's canonical list and every
  // later one is superseded.
  const canonicalByJob = new Map<string, string>();
  for (const l of (lists ?? []) as { id: string; job_id: string | null }[]) {
    if (l.job_id && !canonicalByJob.has(l.job_id)) canonicalByJob.set(l.job_id, l.id);
  }
  const isSuperseded = (l: { id: string; job_id?: string | null }) =>
    !!l.job_id && canonicalByJob.get(l.job_id) !== l.id;

  // A TECH'S INDEX IS ONE LIST PER JOB (Erik's law), so a superseded one is not offered to him at
  // all — for the office it stays visible and badged, because clearing the stray is office work.
  const materialLists = ((lists ?? []) as any[]).filter((l) => isStaff || !isSuperseded(l));

  return (
    <div>
      {/* The cards carry item count + date only — no cost, no total — for either role,
          so there's nothing to strip here; the money lives on the list page, gated there. */}
      <PageHeader
        title="Material lists"
        description={
          isStaff
            ? "Take-offs for jobs — build by hand or generate with AI."
            : "Each job's materials list — the same one the office sees."
        }
      >
        {/* New List is a material_lists INSERT — staff at the policy — so a tech
            never sees a button whose only outcome is a refusal. His lists start
            from the job (the first item added on a job's Materials tab makes one). */}
        {isStaff && <NewListButton jobs={jobs ?? []} />}
      </PageHeader>

      {jobFilter && (
        <div className="-mt-3 mb-4 text-sm text-slate-500">
          Showing this job&rsquo;s lists only ·{" "}
          <Link href="/materials" className="font-medium text-brand hover:underline">
            show all
          </Link>
        </div>
      )}

      {materialLists.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No material lists yet"
          description={
            isStaff
              ? "Generate a take-off from a scope of work, or start an empty list — New List above."
              : "A job's list starts the moment somebody adds the first item on its Materials tab."
          }
        />
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
                    {/* THE ADDRESS IS THE HEADLINE (cn-v829): customer · address, never the job number
                        (Erik, 09-01: "job number in the way, no address"). The list's own name is derived
                        from the number and says nothing a person recognizes. */}
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="min-w-0 truncate font-medium text-slate-900">
                        {l.jobs ? jobSiteLabel({ ...l.jobs, customer_name: l.jobs.customers?.name ?? null }) : l.name}
                      </div>
                      {/* Plain word, not a status code: this list is not the one the job reads. */}
                      {isSuperseded(l) && <Badge tone="amber" className="shrink-0">Replaced</Badge>}
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
