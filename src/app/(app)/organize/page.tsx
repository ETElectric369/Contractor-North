import { signDocumentUrls } from "@/lib/signed-docs";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { PageHeader } from "@/components/page-header";
import { OrganizeManager, type OrganizedItemRow } from "./organize-manager";

export const dynamic = "force-dynamic";

export default async function OrganizePage() {
  const supabase = await createClient();

  const [{ data: org }, { data: items }, { data: jobs }] = await Promise.all([
    supabase.from("organizations").select("id").limit(1).maybeSingle(),
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
        description="Receipts, notes, and job documents — photographed, read, and filed for you."
      />
      <OrganizeManager orgId={org?.id ?? ""} items={withUrls} jobs={jobs ?? []} />
    </div>
  );
}
