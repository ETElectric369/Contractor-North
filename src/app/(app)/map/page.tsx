import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { JobsMap } from "@/components/jobs-map";

export const dynamic = "force-dynamic";

export default async function MapPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ data: jobs }, { data: me }] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, name, address, customers(name)")
      .not("address", "is", null)
      .neq("address", "")
      .in("status", ["estimate", "scheduled", "in_progress", "on_hold"])
      .order("scheduled_start", { ascending: true, nullsFirst: false })
      .limit(60),
    supabase.from("profiles").select("home_address").eq("id", user?.id ?? "").maybeSingle(),
  ]);

  const mapJobs = (jobs ?? []).map((j: any) => ({
    id: j.id,
    name: j.name,
    address: j.address,
    customer: j.customers?.name ?? null,
  }));

  return (
    <div>
      <PageHeader title="Map" description="Active jobs plotted by address — route from home through your day." />
      <JobsMap jobs={mapJobs} homeAddress={me?.home_address ?? null} />
    </div>
  );
}
