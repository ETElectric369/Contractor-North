import { signDocumentUrls } from "@/lib/signed-docs";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { OrganizeManager, type OrganizedItemRow } from "./organize-manager";
import { SnapOrNoteButton } from "@/components/snap-or-note";
import { loadBooks, loadMarkContext, matchesOnBooks, OPEN_JOBS_FOR_PAPER, PAPER_JOB_STATUSES, rematchTray } from "./paperwork-core";
import { openListViews } from "@/app/(app)/bills/open-list-core";
import { bankLinesStayHere, bankViews } from "@/app/(app)/bills/bank-core";
import { getOrgSettings } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";

export const dynamic = "force-dynamic";
// Read Now and Read Again on a card run inside this page's server actions; the reader's own time,
// not the platform's default, decides when it gives up (audit v994, SI4). A paper put in through
// Snap Or Note is read on its own route (/api/paperwork/read), with the same 60 seconds.
export const maxDuration = 60;

export default async function OrganizePage() {
  const supabase = await createClient();

  // The org row feeds the "already on the books" read, which rides in the same breath as the rest
  // (a serial hop on a page read is the phone-lag class, audit v921).
  // `settings` rides along for the Shop Stock switch (0352): off, and no paper here offers the shelf.
  const orgRead = supabase.from("organizations").select("id, settings").limit(1).maybeSingle();
  const orgIdOf = (r: { data: unknown }) => (r.data as { id?: string } | null)?.id ?? null;
  const [{ data: org }, { data: items }, { data: jobs }, books, markCtx] = await Promise.all([
    orgRead,
    supabase
      .from("organized_items")
      .select("*, jobs(job_number, name)")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("jobs")
      .select("id, job_number, name, status")
      // Open AND finished jobs (audit v994, PR1): a late ticket for a completed job is still that
      // job's cost. The same jobs the reader matches against, so a job it picked is in the list.
      .in("status", PAPER_JOB_STATUSES)
      .order("created_at", { ascending: false })
      .limit(OPEN_JOBS_FOR_PAPER),
    // Every printed number already on the books, for "Same Purchase: Tie Them" (0295).
    Promise.resolve(orgRead).then((r) => loadBooks(supabase, orgIdOf(r))),
    // The open jobs, POs and the company's own names, so a paper already waiting is matched again
    // by the rules it was read before (rematchTray: in memory, no model, nothing written).
    Promise.resolve(orgRead).then((r) => loadMarkContext(supabase, orgIdOf(r))),
  ]);

  // ONE signing call for the page (2026-09-08 phone-lag sweep) — this used to open a Storage
  // connection per row. Voice/typed notes have no file and are skipped, not sent as null.
  // The signing and a waiting supplier list's card ride together (open-list-core: nothing waiting,
  // nothing read).
  const [urls, listViews, bankCards] = await Promise.all([
    signDocumentUrls(supabase, ((items ?? []) as any[]).map((i) => i.file_url)),
    openListViews(supabase, org?.id, (items ?? []) as any[]),
    bankViews(supabase, org?.id, (items ?? []) as any[]),
  ]);
  // A bank download's own lines never go to the browser, waiting or filed: its card is `bank`
  // (bankLinesStayHere).
  const withUrls: OrganizedItemRow[] = rematchTray((items ?? []) as any[], markCtx).map((i) => ({
    ...bankLinesStayHere(i, bankCards[i.id]),
    signedUrl: (i.file_url && urls.get(i.file_url)) || null,
    open_list: listViews[i.id] ?? null,
    bank: bankCards[i.id] ?? null,
  }));

  return (
    <div className="mx-auto max-w-3xl">
      {/* ONE PAPER DOOR (W1-30): papers come in through Snap Or Note, this button or + anywhere. */}
      <PageHeader title="Organize My…" description="Papers you snapped wait here until you file them.">
        <SnapOrNoteButton />
      </PageHeader>
      <OrganizeManager
        items={withUrls}
        jobs={jobs ?? []}
        matches={Object.fromEntries(withUrls.filter((i) => i.status === "needs_review").map((i) => [i.id, matchesOnBooks(i, books)]))}
        shopStock={featureOn(getOrgSettings((org as { settings?: unknown } | null)?.settings).features, "shop_stock")}
      />
    </div>
  );
}
