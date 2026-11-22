import { describe, it, expect, vi, beforeEach } from "vitest";
import { client, makeDb, type Db, type Row } from "./visit-db.test-util";
import type { TieJob } from "./tie-matching-visit";

/**
 * A NEW JOB FINDS ITS VISIT (cn-v1181, I3), on a stand-in database that honours every filter, select
 * list and write it is asked (visit-db.test-util). Stand-ins only: Dana Rook at 410 Larkspur Lane.
 */
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
const { tieMatchingVisit, openForTie, TIE_VISIT_CAP } = await import("./tie-matching-visit");
const { reportError } = await import("@/lib/observe");

const NOW = new Date("2026-11-22T20:00:00Z");
const JOB: TieJob = { id: "job-900", customer_id: "cust-dana", address: "410 Larkspur Ln", created_at: "2026-11-22T19:59:00Z" };
const visit = (id: string, over: Row = {}): Row => ({
  id,
  org_id: "org-1",
  type: "inspection",
  title: "Site inspection: Dana Rook",
  status: "scheduled",
  outcome: null,
  outcome_at: null,
  starts_at: "2026-11-08T18:00:00Z",
  location: "410 Larkspur Lane, Truckee, CA 96161",
  inquiry_id: null,
  customer_id: null,
  job_id: null,
  updated_at: "2026-11-08T19:00:00Z",
  ...over,
});
const COLS = {
  appointments: Object.keys(visit("x")),
  customers: ["id", "org_id", "name"],
  inquiries: ["id", "org_id", "name", "customer_id", "status", "converted_at", "updated_at"],
  jobs: ["id", "org_id", "inquiry_id"],
};
let db: Db;
const sb = () => client(db) as never;
const tie = (over: Partial<typeof JOB> = {}, orgId: string | null = "org-1") => tieMatchingVisit(sb(), { orgId, job: { ...JOB, ...over }, now: NOW });

beforeEach(() => {
  vi.mocked(reportError).mockClear();
  db = makeDb(
    {
      appointments: [visit("v-dana")],
      customers: [
        { id: "cust-dana", org_id: "org-1", name: "Dana Rook" },
        { id: "cust-unknown", org_id: "org-1", name: "Unknown caller" },
      ],
      inquiries: [],
      jobs: [{ id: "job-900", org_id: "org-1", inquiry_id: null }],
    },
    COLS,
  );
});

describe("tieMatchingVisit", () => {
  it("exactly one open sales visit that matches: tied with the attach patch (the job, its customer, Won), read back", async () => {
    const r = await tie();
    expect(r).toMatchObject({ kind: "tied", visit: { id: "v-dana", title: "Site inspection: Dana Rook", starts_at: "2026-11-08T18:00:00Z" } });
    const v = db.tables.appointments[0];
    expect(v).toMatchObject({ job_id: "job-900", customer_id: "cust-dana", outcome: "won" });
    expect(v.outcome_at).toBe(NOW.toISOString());
    // Compare-and-set, in the caller's company.
    const w = db.writes.find((x) => x.table === "appointments")!;
    expect(w.filters).toEqual(expect.arrayContaining(["eq id v-dana", "eq org_id org-1", "is job_id null", "neq status cancelled", "is outcome null"]));
  });

  it("another company's visit is never tied, nor read", async () => {
    db.tables.appointments = [visit("v-other", { org_id: "org-2" })];
    expect(await tie()).toEqual({ kind: "none" });
    expect(db.tables.appointments[0].job_id).toBeNull();
    expect(db.writes).toEqual([]);
  });

  it("a visit whose day is still ahead is not tied; a completed one is, whatever its day", async () => {
    db.tables.appointments = [visit("v-ahead", { starts_at: "2026-11-25T18:00:00Z" })];
    expect(await tie()).toEqual({ kind: "none" });
    expect(db.writes).toEqual([]);
    expect(openForTie({ status: "completed", outcome: null, job_id: null, starts_at: "2026-11-25T18:00:00Z" }, NOW)).toBe(true);
    // The rule itself, beside the match (which would also refuse a job made before the visit's start).
    expect(openForTie({ status: "scheduled", outcome: null, job_id: null, starts_at: "2026-11-25T18:00:00Z" }, NOW)).toBe(false);
    expect(openForTie({ status: "scheduled", outcome: null, job_id: null, starts_at: null }, NOW)).toBe(false);
    expect(openForTie({ status: "scheduled", outcome: null, job_id: null, starts_at: "2026-11-08T18:00:00Z" }, NOW)).toBe(true);
  });

  it("not open: cancelled, Not Sold, or already on a job: nothing", async () => {
    for (const over of [{ status: "cancelled" }, { outcome: "lost" }, { outcome: "no_bid" }, { job_id: "job-1" }]) {
      db.tables.appointments = [visit("v", over)];
      expect(await tie(), JSON.stringify(over)).toEqual({ kind: "none" });
    }
    expect(db.writes).toEqual([]);
  });

  it("two candidates: nothing is written, and it says how many (the rows' offers ask)", async () => {
    db.tables.appointments = [visit("v-1"), visit("v-2", { starts_at: "2026-11-10T18:00:00Z" })];
    expect(await tie()).toEqual({ kind: "several", count: 2 });
    expect(db.writes).toEqual([]);
  });

  it("a placeholder name, another street, or a job with no customer: nothing", async () => {
    db.tables.appointments = [visit("v", { title: "Inspection: Unknown caller" })];
    expect(await tie({ customer_id: "cust-unknown" })).toEqual({ kind: "none" });
    db.tables.appointments = [visit("v")];
    expect(await tie({ address: "412 Larkspur Ln" })).toEqual({ kind: "none" });
    expect(await tie({ customer_id: null })).toEqual({ kind: "none" });
    expect(db.writes).toEqual([]);
  });

  it("a visit already Won keeps its answer; the tie lands on the outcome as read", async () => {
    db.tables.appointments = [visit("v", { outcome: "won", outcome_at: "2026-11-09T00:00:00Z" })];
    expect((await tie()).kind).toBe("tied");
    expect(db.tables.appointments[0]).toMatchObject({ job_id: "job-900", outcome: "won", outcome_at: "2026-11-09T00:00:00Z" });
  });

  it("the lead behind it is won with the job, as the attach door does", async () => {
    db.tables.inquiries = [{ id: "inq-1", org_id: "org-1", name: "Dana Rook", customer_id: null, status: "contacted", converted_at: null, updated_at: null }];
    db.tables.appointments = [visit("v", { inquiry_id: "inq-1", title: "Site inspection" })];
    expect((await tie()).kind).toBe("tied");
    expect(db.tables.inquiries[0].status).toBe("won");
    expect(db.tables.jobs[0].inquiry_id).toBe("inq-1");
  });

  it("a failed read or a write that lands nowhere is `failed`, filed to the ops sink, never thrown", async () => {
    db.fail!.read!.add("appointments");
    expect(await tie()).toEqual({ kind: "failed" });
    expect(reportError).toHaveBeenCalledWith("tieMatchingVisit:read", expect.anything(), { jobId: "job-900" });
    db.fail!.read!.clear();
    db.fail!.write!.add("appointments");
    const r = await tie();
    expect(r).toMatchObject({ kind: "failed", visit: { id: "v-dana" } });
    expect(reportError).toHaveBeenCalledWith("tieMatchingVisit:write", expect.anything(), { jobId: "job-900", appointmentId: "v-dana" });
  });

  it("a read cut at the cap ties nothing (exactly one cannot be told) and is said to the ops sink", async () => {
    db.tables.appointments = Array.from({ length: TIE_VISIT_CAP }, (_, i) => visit(`v-${i}`, { location: `${i + 1} Bayberry Rd` }));
    expect(await tie()).toEqual({ kind: "none" });
    expect(reportError).toHaveBeenCalledWith("tieMatchingVisit:capped", expect.anything(), { jobId: "job-900" });
  });

  it("no company named: nothing is read", async () => {
    expect(await tie({}, null)).toEqual({ kind: "none" });
  });
});

describe("cn-v1181 fixer: the read leaves ended and old visits out, and a different unit is another place (skeptic #84, M5)", () => {
  it("five hundred old Not Sold visits do not fill the cap: they are left out in the query, and the open one is tied", async () => {
    db.tables.appointments = [
      ...Array.from({ length: TIE_VISIT_CAP }, (_, i) => visit(`v-lost-${i}`, { outcome: i % 2 ? "lost" : "no_bid", location: `${i + 1} Bayberry Rd` })),
      visit("v-dana"),
    ];
    expect((await tie()).kind).toBe("tied");
    expect(reportError).not.toHaveBeenCalledWith("tieMatchingVisit:capped", expect.anything(), expect.anything());
  });

  it("a visit whose day is more than 180 days before the job is not tied; one inside is", async () => {
    db.tables.appointments = [visit("v-old", { starts_at: "2026-05-01T18:00:00Z" })];
    expect((await tie()).kind).toBe("none");
    db.tables.appointments = [visit("v-inside", { starts_at: "2026-06-01T18:00:00Z" })];
    expect((await tie()).kind).toBe("tied");
  });

  it("Unit 2 on the visit and Unit 5 on the job: no match; the same unit, or a side with none, still matches", async () => {
    db.tables.appointments = [visit("v-2", { location: "410 Larkspur Lane Unit 2, Truckee, CA 96161" })];
    expect((await tie({ unit: "5" })).kind).toBe("none");
    expect((await tie({ address: "410 Larkspur Ln Apt 5" })).kind).toBe("none");
    expect((await tie({ unit: "Unit 2" })).kind).toBe("tied");
    db.tables.appointments = [visit("v-2b", { location: "410 Larkspur Lane Unit 2, Truckee, CA 96161" })];
    expect((await tie()).kind).toBe("tied");
  });
});

describe("unitOf: the unit's own token", async () => {
  const { unitOf, exactJobMatch } = await import("./visit-offer");
  it("reads unit, apt, apartment, suite, ste and #", () => {
    expect(unitOf("410 Larkspur Lane Unit 2, Truckee")).toBe("2");
    expect(unitOf("410 Larkspur Ln Apt 2B")).toBe("2b");
    expect(unitOf("410 Larkspur Ln, Apartment 2b")).toBe("2b");
    expect(unitOf("410 Larkspur Ln Suite 300")).toBe("300");
    expect(unitOf("410 Larkspur Ln Ste. 300")).toBe("300");
    expect(unitOf("410 Larkspur Ln #5")).toBe("5");
    expect(unitOf("410 Larkspur Lane, Truckee, CA 96161")).toBeNull();
  });
  it("the offered button and the automatic tie share it (exactJobMatch)", () => {
    const v = { starts_at: "2026-11-08T18:00:00Z", job_id: null, customer_id: "cust-dana", location: "410 Larkspur Lane #2, Truckee" };
    expect(exactJobMatch(v, { created_at: "2026-11-20T00:00:00Z", address: "410 Larkspur Ln", unit: "5", customer_id: "cust-dana" })).toBe(false);
    expect(exactJobMatch(v, { created_at: "2026-11-20T00:00:00Z", address: "410 Larkspur Ln", unit: "2", customer_id: "cust-dana" })).toBe(true);
    expect(exactJobMatch(v, { created_at: "2026-11-20T00:00:00Z", address: "410 Larkspur Ln", customer_id: "cust-dana" })).toBe(true);
  });
});
