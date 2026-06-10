import { createClient } from "@/lib/supabase/server";
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
      .in("status", ["estimate", "scheduled", "in_progress", "on_hold"])
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const withUrls: OrganizedItemRow[] = await Promise.all(
    ((items ?? []) as any[]).map(async (i) => {
      const { data } = await supabase.storage.from("documents").createSignedUrl(i.file_url, 3600);
      return { ...i, signedUrl: data?.signedUrl ?? null };
    }),
  );

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
