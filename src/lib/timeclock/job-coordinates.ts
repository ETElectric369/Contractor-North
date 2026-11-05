import { geocodeAddress, type GeocodeResult } from "@/lib/geocode-server";
import { reportError } from "@/lib/observe";
import { MAX_NEAR_M, rankByDistance, usableFix, type Fix, type Ranked } from "./nearest-job";

/**
 * WHERE EACH JOB IS, for the clock-in's nearest step (the owner, 2026-11-04). Server only.
 *
 * Two sources, in order:
 *   (a) "address": the job's address, geocoded ONCE and kept on the job (0404: geo_lat, geo_lng,
 *       geocoded_at). Asked lazily, the first time a job is near a punch. An address that will not
 *       geocode is stamped with null coordinates so it is not asked again every punch; a FAILURE
 *       (Google down, the day's fuse spent, no key) is not stamped, so the next punch tries again,
 *       and it is said once in the server log (reportError), never to the tech. 0404's trigger
 *       clears all three when the address changes.
 *   (b) "punches": the median of the job's last five punches' gps_in, when (a) has nothing.
 *
 * EVERY READ AND WRITE NAMES THE COMPANY (orgId): the caller passes the service client so the
 * stamp lands for a tech too (jobs_write is staff-only) and the punch median sees the crew's
 * punches, not just his own — and the service client has no RLS to fall back on. What leaves this
 * module is a point per job id the caller could already see, never a punch or a person.
 */

export type JobCoordinate = { lat: number; lng: number; source: "address" | "punches" };

type Client = { from: (table: string) => any };

/** How many punches make a job's place when it has no address answer. */
export const PUNCHES_PER_JOB = 5;
/** At most this many addresses are geocoded in one ask, so one punch never fans out to Google. */
export const GEOCODES_PER_ASK = 5;

type JobRow = {
  id: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  geo_lat?: number | string | null;
  geo_lng?: number | string | null;
  geocoded_at?: string | null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** The job's address as one line Google can read: street, then city, state zip. "" = none. */
export function jobAddressLine(j: Pick<JobRow, "address" | "city" | "state" | "zip">): string {
  const street = (j.address ?? "").trim();
  if (!street) return "";
  const city = (j.city ?? "").trim();
  // A street that already carries its town (the one-line address box) is sent as it is.
  if (city && street.toLowerCase().includes(city.toLowerCase())) return street;
  const stateZip = [j.state, j.zip].map((p) => (p ?? "").trim()).filter(Boolean).join(" ");
  const tail = [city, stateZip].filter(Boolean).join(", ");
  return tail ? `${street}, ${tail}` : street;
}

/** The middle value (the mean of the two middles for an even count). */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Said once per job and reason per instance, so a Google brownout is one line, not one per punch. */
const said = new Set<string>();
function sayOnce(key: string, e: unknown, extra: Record<string, unknown>) {
  if (said.has(key)) return;
  if (said.size > 5000) said.clear();
  said.add(key);
  reportError("timeclock.jobCoordinates", e, extra);
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function coordinatesOfJobs(
  sb: Client,
  orgId: string | null | undefined,
  jobIds: readonly string[],
  opts: { geocode?: (address: string) => Promise<GeocodeResult>; maxGeocodes?: number; now?: () => Date } = {},
): Promise<Map<string, JobCoordinate>> {
  const out = new Map<string, JobCoordinate>();
  const ids = [...new Set((jobIds ?? []).filter((x): x is string => typeof x === "string" && !!x))];
  if (!orgId || !ids.length) return out;
  const geocode = opts.geocode ?? geocodeAddress;
  const now = opts.now ?? (() => new Date());

  // (a) the address, stored or found once.
  const { data: rows, error } = await sb
    .from("jobs")
    .select("id, address, city, state, zip, geo_lat, geo_lng, geocoded_at")
    .eq("org_id", orgId)
    .in("id", ids);
  if (error) sayOnce(`read:${orgId}`, error, { orgId, step: "jobs read" });
  const toAsk: { id: string; line: string; row: JobRow }[] = [];
  for (const j of ((rows ?? []) as JobRow[])) {
    const lat = num(j.geo_lat);
    const lng = num(j.geo_lng);
    if (lat !== null && lng !== null) out.set(j.id, { lat, lng, source: "address" });
    else if (!j.geocoded_at) {
      const line = jobAddressLine(j);
      if (line) toAsk.push({ id: j.id, line, row: j });
    }
  }
  const asked = toAsk.slice(0, Math.max(0, opts.maxGeocodes ?? GEOCODES_PER_ASK));
  await Promise.all(
    asked.map(async ({ id, line, row }) => {
      let r: GeocodeResult;
      try {
        r = await geocode(line);
      } catch (e) {
        r = { status: "failed" };
        sayOnce(`threw:${id}`, e, { orgId, jobId: id, step: "geocode" });
      }
      if (r.status !== "ok" && r.status !== "notfound") {
        // Not the address's fault: not stamped, so the next punch asks again.
        sayOnce(`${r.status}:${id}`, new Error(`job address did not geocode: ${r.status}`), { orgId, jobId: id, status: r.status });
        return;
      }
      const place = r.status === "ok" ? { lat: round6(r.place.lat), lng: round6(r.place.lng) } : null;
      if (place) out.set(id, { ...place, source: "address" });
      // The stamp: this job, this company, only while still unasked (a second punch racing this one
      // finds it stamped and writes nothing). A zero-row answer with no error is that race, or a job
      // that left the company; either way it is said once, so a client that cannot write is seen.
      // It also matches the address parts READ: an address changed while Google answered has had its
      // stamp cleared by 0404's trigger, and the OLD address's point must not land on the NEW one.
      let stamp = sb
        .from("jobs")
        .update({ geo_lat: place?.lat ?? null, geo_lng: place?.lng ?? null, geocoded_at: now().toISOString() })
        .eq("id", id)
        .eq("org_id", orgId)
        .is("geocoded_at", null);
      for (const col of ["address", "city", "state", "zip"] as const) {
        const v = row[col];
        stamp = v == null ? stamp.is(col, null) : stamp.eq(col, v);
      }
      const { data: hit, error: werr } = await stamp.select("id");
      if (werr) sayOnce(`write:${id}`, werr, { orgId, jobId: id, step: "stamp" });
      else if (!(Array.isArray(hit) ? hit.length : hit)) sayOnce(`zero:${id}`, new Error("job geocode stamp wrote no row"), { orgId, jobId: id });
    }),
  );

  // (b) the crew's own punches, for the jobs (a) left without a place.
  const missing = ids.filter((id) => !out.has(id));
  if (!missing.length) return out;
  const { data: punches, error: perr } = await sb
    .from("time_entries")
    .select("job_id, gps_in, clock_in")
    .eq("org_id", orgId)
    .in("job_id", missing)
    .not("gps_in", "is", null)
    .order("clock_in", { ascending: false })
    .limit(Math.min(1000, missing.length * PUNCHES_PER_JOB * 4));
  if (perr) {
    sayOnce(`punches:${orgId}`, perr, { orgId, step: "punches read" });
    return out;
  }
  const byJob = new Map<string, { lat: number[]; lng: number[] }>();
  for (const p of ((punches ?? []) as { job_id: string | null; gps_in: unknown }[])) {
    if (!p.job_id) continue;
    const fix = usableFix(p.gps_in as Partial<Fix> | null, MAX_NEAR_M);
    if (!fix) continue;
    const acc = byJob.get(p.job_id) ?? { lat: [], lng: [] };
    if (acc.lat.length >= PUNCHES_PER_JOB) continue;
    acc.lat.push(fix.lat);
    acc.lng.push(fix.lng);
    byJob.set(p.job_id, acc);
  }
  for (const [id, acc] of byJob) {
    if (acc.lat.length) out.set(id, { lat: median(acc.lat), lng: median(acc.lng), source: "punches" });
  }
  return out;
}

/** The statuses the nearest step looks at: work not finished and not on hold. */
export const NEAR_JOB_STATUSES = ["to_be_scheduled", "scheduled", "in_progress"] as const;

/**
 * THE JOBS NEAR A FIX, nearest first (within MAX_NEAR_M), each with its distance and whether it is
 * inside the fence. `reader` lists the jobs (the caller's own RLS client, so a tech is only ever
 * offered a job he can see); `places` finds where they are (the service client, org-scoped).
 */
export async function jobsNearFix(
  reader: Client,
  places: Client,
  orgId: string | null | undefined,
  fix: Partial<Fix> | null | undefined,
  radiusM: number,
  opts: Parameters<typeof coordinatesOfJobs>[3] = {},
): Promise<Ranked<{ id: string; lat: number; lng: number }>[]> {
  const at = usableFix(fix);
  if (!orgId || !at) return [];
  const { data, error } = await reader.from("jobs").select("id").eq("org_id", orgId).in("status", [...NEAR_JOB_STATUSES]);
  if (error) {
    sayOnce(`near:${orgId}`, error, { orgId, step: "near jobs read" });
    return [];
  }
  const ids = ((data ?? []) as { id: string }[]).map((j) => j.id);
  if (!ids.length) return [];
  const where = await coordinatesOfJobs(places, orgId, ids, opts);
  const placed = ids.flatMap((id) => {
    const c = where.get(id);
    return c ? [{ id, lat: c.lat, lng: c.lng }] : [];
  });
  return rankByDistance(at, placed, { radiusM, maxM: MAX_NEAR_M });
}
