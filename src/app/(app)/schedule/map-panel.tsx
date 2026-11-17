import { createClient } from "@/lib/supabase/server";
import { JobsMap } from "@/components/jobs-map";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { jobAddressLine } from "@/lib/timeclock/job-coordinates";
import { storedCoord } from "@/lib/schedule/map-pin";

/** Map view of the unified Schedule hub (was /map). */
export async function MapPanel() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ data: jobs }, { data: me }] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, name, address, city, state, zip, geo_lat, geo_lng, customers(name)") // PROJECTION LAW: every column read below
      .not("address", "is", null)
      .neq("address", "")
      .in("status", ACTIVE_JOB_STATUSES)
      .order("scheduled_start", { ascending: true, nullsFirst: false })
      .limit(60),
    supabase.from("profile_pay").select("home_address").eq("id", user?.id ?? "").maybeSingle(),
  ]);

  const mapJobs = (jobs ?? []).map((j: any) => ({
    id: j.id,
    name: j.name,
    // THE WHOLE ADDRESS, NOT THE STREET LINE (2026-11-16, lib/schedule/map-pin): the same one line the
    // fence's lookup sends, so the map and the fence cannot put one job in two places.
    address: jobAddressLine(j),
    customer: j.customers?.name ?? null,
    lat: storedCoord(j.geo_lat),
    lng: storedCoord(j.geo_lng),
  }));

  return <JobsMap jobs={mapJobs} homeAddress={me?.home_address ?? null} />;
}
