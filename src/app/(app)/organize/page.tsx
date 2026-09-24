import { signDocumentUrls } from "@/lib/signed-docs";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { PageHeader } from "@/components/page-header";
import { OrganizeManager, type OrganizedItemRow } from "./organize-manager";
import { loadBooks, matchesOnBooks } from "./paperwork-core";

export const dynamic = "force-dynamic";

export default async function OrganizePage() {
  const supabase = await createClient();

  // The org row feeds the "already on the books" read, which rides in the same breath as the rest
  // (a serial hop on a page read is the phone-lag class, audit v921).
  const orgRead = supabase.from("organizations").select("id").limit(1).maybeSingle();
  const [{ data: org }, { data: items }, { data: jobs }, books] = await Promise.all([
    orgRead,
    supabase
      .from("organized_items")
      .select("*, jobs(job_number, name)")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .in("status", ACTIVE_JOB_STATUSES)
      .order("created_at", { ascending: false })
      .limit(100),
    // Every printed number already on the books, for "Same Purchase: Tie Them" (0295).
    Promise.resolve(orgRead).then((r) => loadBooks(supabase, (r.data as { id?: string } | null)?.id ?? null)),
  ]);

  // ONE signing call for the page (2026-09-08 phone-lag sweep) — this used to open a Storage
  // connection per row. Voice/typed notes have no file and are skipped, not sent as null.
  const urls = await signDocumentUrls(supabase, ((items ?? []) as any[]).map((i) => i.file_url));
  const withUrls: OrganizedItemRow[] = ((items ?? []) as any[]).map((i) => ({
    ...i,
    signedUrl: (i.file_url && urls.get(i.file_url)) || null,
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Organize My…"
        description="Receipts, notes, and job documents — photographed and read for you, filed when you say."
      />
      <OrganizeManager
        orgId={org?.id ?? ""}
        items={withUrls}
        jobs={jobs ?? []}
        matches={Object.fromEntries(withUrls.filter((i) => i.status === "needs_review").map((i) => [i.id, matchesOnBooks(i, books)]))}
      />
    </div>
  );
}
