import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/geocode-server", () => ({ geocodeAddress: vi.fn(async () => ({ status: "unconfigured" })) }));

import { reportError } from "@/lib/observe";
import { coordinatesOfJobs, jobAddressLine, jobsNearFix, median } from "./job-coordinates";

/**
 * WHERE EACH JOB IS (0404), pinned with a fake client: the stored place first, the address
 * geocoded once and stamped (org-scoped, checked), an address that will not geocode stamped empty,
 * a failure never stamped and said once, and the median of the last five punches when there is no
 * address answer.
 */
type Q = { table: string; verb: string; cols: string; payload?: any; filters: any[] };
function fake(route: (q: Q) => { data?: any; error?: any }, calls: Q[]) {
  return {
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const chain: any = {
        select(c?: string) { q.cols = c ?? ""; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; q.cols = ""; return chain; },
        maybeSingle() { return Promise.resolve(route(q)); },
        then(res: any, rej: any) { try { res({ data: null, error: null, ...route(q) }); } catch (e) { rej?.(e); } },
      };
      for (const m of ["eq", "in", "is", "not", "order", "limit"]) chain[m] = (...a: any[]) => { q.filters.push([m, ...a]); return chain; };
      return chain;
    },
  };
}
const has = (q: Q, ...f: any[]) => q.filters.some((x) => JSON.stringify(x) === JSON.stringify(f));
const NOW = () => new Date("2026-11-04T16:00:00Z");

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
  vi.mocked(reportError).mockClear();
});

describe("coordinatesOfJobs", () => {
  it("a stored place is the answer, read for this company only, and nothing is geocoded", async () => {
    const geocode = vi.fn();
    const sb = fake((q) => (q.table === "jobs" ? { data: [{ id: "larkspur", address: "1 Larkspur Ln", geo_lat: "39.300000", geo_lng: "-120.200000", geocoded_at: "2026-10-01T00:00:00Z" }] } : { data: [] }), calls);
    const m = await coordinatesOfJobs(sb, "org-1", ["larkspur"], { geocode });
    expect(m.get("larkspur")).toEqual({ lat: 39.3, lng: -120.2, source: "address" });
    expect(has(calls[0], "eq", "org_id", "org-1")).toBe(true);
    expect(geocode).not.toHaveBeenCalled();
  });

  it("an address never asked is geocoded once and stamped on this job in this company, still unasked, checked", async () => {
    const geocode = vi.fn(async () => ({ status: "ok" as const, place: { lat: 39.1234567, lng: -120.7654321, formatted: "", line1: "", city: "", state: "", zip: "" } }));
    const sb = fake((q) => {
      if (q.table === "jobs" && q.verb === "update") return { data: [{ id: "snowbell" }] };
      if (q.table === "jobs") return { data: [{ id: "snowbell", address: "2 Snowbell Way", city: "Truckee", state: "CA", zip: "96161", geo_lat: null, geo_lng: null, geocoded_at: null }] };
      return { data: [] };
    }, calls);
    const m = await coordinatesOfJobs(sb, "org-1", ["snowbell"], { geocode, now: NOW });
    expect(geocode).toHaveBeenCalledWith("2 Snowbell Way, Truckee, CA 96161");
    expect(m.get("snowbell")).toEqual({ lat: 39.123457, lng: -120.765432, source: "address" });
    const upd = calls.find((q) => q.verb === "update")!;
    expect(upd.payload).toEqual({ geo_lat: 39.123457, geo_lng: -120.765432, geocoded_at: "2026-11-04T16:00:00.000Z" });
    expect(has(upd, "eq", "id", "snowbell")).toBe(true);
    expect(has(upd, "eq", "org_id", "org-1")).toBe(true);
    expect(has(upd, "is", "geocoded_at", null)).toBe(true);
    // only while the address is still the one geocoded (an edit mid-ask is cleared by 0404's trigger)
    expect(has(upd, "eq", "address", "2 Snowbell Way")).toBe(true);
    expect(has(upd, "eq", "city", "Truckee")).toBe(true);
    expect(has(upd, "eq", "state", "CA")).toBe(true);
    expect(has(upd, "eq", "zip", "96161")).toBe(true);
    expect(upd.cols).toBe("id");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("an address that will not geocode is stamped empty, so it is not asked again; a stamp that lands on no row is said", async () => {
    const geocode = vi.fn(async () => ({ status: "notfound" as const }));
    const sb = fake((q) => {
      if (q.table === "jobs" && q.verb === "update") return { data: [] };
      if (q.table === "jobs") return { data: [{ id: "bayberry", address: "nowhere", geocoded_at: null }] };
      return { data: [] };
    }, calls);
    await coordinatesOfJobs(sb, "org-1", ["bayberry"], { geocode, now: NOW });
    const upd = calls.find((q) => q.verb === "update")!;
    expect(upd.payload).toEqual({ geo_lat: null, geo_lng: null, geocoded_at: "2026-11-04T16:00:00.000Z" });
    // an empty part is matched as still empty (null), never as "any"
    expect(has(upd, "eq", "address", "nowhere")).toBe(true);
    expect(has(upd, "is", "city", null)).toBe(true);
    expect(has(upd, "is", "zip", null)).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a FAILURE is never stamped and is said once in the server log, however many punches ask", async () => {
    const geocode = vi.fn(async () => ({ status: "failed" as const }));
    const sb = fake((q) => (q.table === "jobs" ? { data: [{ id: "thistlewood", address: "4 Thistlewood Ct", geocoded_at: null }] } : { data: [] }), calls);
    await coordinatesOfJobs(sb, "org-1", ["thistlewood"], { geocode });
    await coordinatesOfJobs(sb, "org-1", ["thistlewood"], { geocode });
    expect(geocode).toHaveBeenCalledTimes(2);
    expect(calls.some((q) => q.verb === "update")).toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a job a stamp already tried, or with no address, is not geocoded; the median of its last five punches places it", async () => {
    const geocode = vi.fn();
    const p = (lat: number, lng: number) => ({ job_id: "catbird", gps_in: { lat, lng, accuracy: 10 } });
    const sb = fake((q) => {
      if (q.table === "jobs") return { data: [{ id: "catbird", address: "5 Catbird Rd", geocoded_at: "2026-10-01T00:00:00Z" }, { id: "larkspur", address: null, geocoded_at: null }] };
      if (q.table === "time_entries") return { data: [p(39.1, -120.1), p(39.3, -120.3), p(39.2, -120.2), p(50, 10), p(39.2, -120.2), p(1, 1)] };
      return { data: [] };
    }, calls);
    const m = await coordinatesOfJobs(sb, "org-1", ["catbird", "larkspur"], { geocode });
    expect(geocode).not.toHaveBeenCalled();
    // The first five: 39.1, 39.3, 39.2, 50, 39.2 → 39.2; the sixth is past the five.
    expect(m.get("catbird")).toEqual({ lat: 39.2, lng: -120.2, source: "punches" });
    expect(m.has("larkspur")).toBe(false);
    const te = calls.find((q) => q.table === "time_entries")!;
    expect(has(te, "eq", "org_id", "org-1")).toBe(true);
    expect(has(te, "not", "gps_in", "is", null)).toBe(true);
  });

  it("no company or no jobs: nothing is read", async () => {
    const sb = fake(() => ({ data: [] }), calls);
    expect((await coordinatesOfJobs(sb, null, ["x"])).size).toBe(0);
    expect((await coordinatesOfJobs(sb, "org-1", [])).size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("jobsNearFix", () => {
  it("lists the company's unfinished jobs on the reader, places them, and ranks them", async () => {
    const reader = fake(() => ({ data: [{ id: "larkspur" }, { id: "snowbell" }] }), calls);
    const places = fake((q) => (q.table === "jobs" ? { data: [{ id: "larkspur", geo_lat: 39.3005, geo_lng: -120.2, geocoded_at: "x" }, { id: "snowbell", geo_lat: 39.4, geo_lng: -120.2, geocoded_at: "x" }] } : { data: [] }), calls);
    const r = await jobsNearFix(reader, places, "org-1", { lat: 39.3, lng: -120.2, accuracy: 10 }, 300);
    expect(r.map((j) => [j.id, j.within])).toEqual([["larkspur", true]]);
    expect(has(calls[0], "eq", "org_id", "org-1")).toBe(true);
    expect(has(calls[0], "in", "status", ["to_be_scheduled", "scheduled", "in_progress"])).toBe(true);
  });
  it("no usable fix: nothing is read", async () => {
    const sb = fake(() => ({ data: [] }), calls);
    expect(await jobsNearFix(sb, sb, "org-1", null, 300)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("the small pure parts", () => {
  it("jobAddressLine and median", () => {
    expect(jobAddressLine({ address: "2 Snowbell Way, Truckee, CA", city: "Truckee", state: "CA", zip: null })).toBe("2 Snowbell Way, Truckee, CA");
    expect(jobAddressLine({ address: "2 Snowbell Way", city: null, state: "CA", zip: "96161" })).toBe("2 Snowbell Way, CA 96161");
    expect(jobAddressLine({ address: "  ", city: "Truckee", state: null, zip: null })).toBe("");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});
