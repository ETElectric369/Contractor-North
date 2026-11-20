import { describe, it, expect } from "vitest";
import {
  INSPECTION_LIST_ORDER,
  bucketInspections,
  filedWithNobody,
  inspectionFileHref,
  inspectionList,
  type InspectionBuckets,
} from "./inspections";
import { visitStands } from "@/lib/leads/new-intake";

/**
 * THE ONE INSPECTIONS LIST (cn-v1171). The meeting's notes, 2026-11-19: "Just a list of people/leads
 * that Need Inspections", and Erik's answer the same afternoon: "on the inspections page lets have
 * just the lead which will be where all of their info is stored".
 */
type R = {
  id: string;
  status: string;
  starts_at: string | null;
  inquiry_id: string | null;
  job_id: string | null;
  customer_id: string | null;
  outcome?: string | null;
  created_at?: string | null;
  type?: string | null;
};
const row = (id: string, o: Partial<R> = {}): R => ({ id, status: "scheduled", starts_at: null, inquiry_id: null, job_id: null, customer_id: null, ...o });
const piles = (o: Partial<InspectionBuckets<R>>): InspectionBuckets<R> => ({ toWriteUp: [], upcoming: [], missed: [], filed: [], ...o });

// 1 PM Pacific on March 10: the company's "today" began at 07:00Z.
const NOW = new Date("2026-03-10T20:00:00Z");
const TZ = "America/Los_Angeles";

describe("inspectionList: one list, in the order a person works it", () => {
  it("draws who to inspect, then who waits on a day, then who waits on a price, then the ones that need an answer", () => {
    expect([...INSPECTION_LIST_ORDER]).toEqual(["coming_up", "needs_day", "write_up", "missed"]);
    const list = inspectionList(
      piles({
        toWriteUp: [row("w-old", { status: "completed", starts_at: "2026-02-01T17:00:00Z" }), row("w-new", { status: "completed", starts_at: "2026-03-05T17:00:00Z" })],
        // The piles arrive in bucketInspections' own order (upcoming soonest first, missed newest
        // first); the list keeps the order inside a pile and only decides the order OF the piles.
        upcoming: [
          row("no-day", { created_at: "2026-03-01T10:00:00Z" }),
          row("today", { starts_at: "2026-03-10T23:00:00Z" }),
          row("soon", { starts_at: "2026-03-11T17:00:00Z" }),
        ],
        missed: [row("gone-new", { starts_at: "2026-03-08T17:00:00Z" }), row("gone-old", { starts_at: "2026-02-10T17:00:00Z" })],
        filed: [row("filed", { status: "completed", outcome: "won" })],
      }),
      NOW,
      TZ,
    );
    expect(list.map((x) => `${x.state}:${x.row.id}`)).toEqual([
      "coming_up:today",
      "coming_up:soon",
      "needs_day:no-day",
      "write_up:w-old",
      "write_up:w-new",
      "missed:gone-new",
      "missed:gone-old",
    ]);
  });

  it("never lists anything filed, whatever its ending", () => {
    const list = inspectionList(
      piles({
        filed: [
          row("done", { status: "completed", outcome: "won" }),
          row("lost", { status: "completed", outcome: "lost" }),
          row("off", { status: "cancelled" }),
        ],
      }),
      NOW,
      TZ,
    );
    expect(list).toEqual([]);
  });

  it("leaves off a pick request that ran out when it has a lead: that lead is back on the Leads list", () => {
    const ranOut = row("ran-out", { status: "proposed", starts_at: "2026-03-10T17:00:00Z", inquiry_id: "lead-1" }); // 10 AM today, gone by
    const ahead = row("ahead", { status: "proposed", starts_at: "2026-03-12T17:00:00Z", inquiry_id: "lead-2" });
    const stale = row("stale", { status: "proposed", starts_at: "2026-02-20T17:00:00Z", inquiry_id: "lead-3" });
    const list = inspectionList(piles({ upcoming: [ranOut, ahead, stale] }), NOW, TZ);
    expect(list.map((x) => x.row.id)).toEqual(["ahead"]);
    // The two lists split a lead between them by ONE rule: what is left off here does not stand there.
    for (const r of [ranOut, stale]) expect(visitStands({ status: r.status, outcome: null, starts_at: r.starts_at }, NOW.getTime())).toBe(false);
    expect(visitStands({ status: ahead.status, outcome: null, starts_at: ahead.starts_at }, NOW.getTime())).toBe(true);
  });

  it("keeps a pick request that ran out when it has NO lead: it has no other list to be on", () => {
    const list = inspectionList(
      piles({
        upcoming: [
          row("today-no-lead", { status: "proposed", starts_at: "2026-03-10T17:00:00Z", customer_id: "c-1" }),
          row("old-no-lead", { status: "proposed", starts_at: "2026-02-20T17:00:00Z" }),
        ],
      }),
      NOW,
      TZ,
    );
    expect(list.map((x) => `${x.state}:${x.row.id}`)).toEqual(["coming_up:today-no-lead", "missed:old-no-lead"]);
  });

  it("a booked visit whose time went by is still listed, lead or no lead: only a pick request runs out", () => {
    const list = inspectionList(
      piles({
        upcoming: [row("earlier-today", { starts_at: "2026-03-10T16:00:00Z", inquiry_id: "lead-1" })],
        missed: [row("last-week", { starts_at: "2026-03-03T17:00:00Z", inquiry_id: "lead-2" })],
      }),
      NOW,
      TZ,
    );
    expect(list.map((x) => `${x.state}:${x.row.id}`)).toEqual(["coming_up:earlier-today", "missed:last-week"]);
  });

  it("reads the same piles Needs You reads: every open visit bucketInspections makes is on the list exactly once", () => {
    const rows = [
      row("booked", { starts_at: "2026-03-12T17:00:00Z", inquiry_id: "l1" }),
      row("waiting", { inquiry_id: "l2", created_at: "2026-03-01T10:00:00Z" }),
      row("inspected", { status: "completed", starts_at: "2026-03-04T17:00:00Z", inquiry_id: "l3" }),
      row("went-by", { starts_at: "2026-03-02T17:00:00Z", inquiry_id: "l4" }),
      row("written-up", { status: "completed", starts_at: "2026-03-04T17:00:00Z", inquiry_id: "l5" }),
      row("called-off", { status: "cancelled", starts_at: "2026-03-04T17:00:00Z", inquiry_id: "l6" }),
    ];
    const b = bucketInspections(rows, new Set(["l5"]), new Set(), NOW, new Set(), new Set(), TZ);
    const list = inspectionList(b, NOW, TZ);
    expect(list.map((x) => `${x.state}:${x.row.id}`)).toEqual(["coming_up:booked", "needs_day:waiting", "write_up:inspected", "missed:went-by"]);
    expect(b.filed.map((r) => r.id).sort()).toEqual(["called-off", "written-up"]);
  });
});

describe("filedWithNobody: the only filed inspections the page still holds", () => {
  it("keeps a filed visit only when it has no lead, no customer and no job", () => {
    const filed = [
      row("nobody", { status: "completed", outcome: "lost" }),
      row("lead", { status: "completed", inquiry_id: "l1" }),
      row("customer", { status: "cancelled", customer_id: "c1" }),
      row("job", { status: "completed", job_id: "j1" }),
      row("nobody-2", { status: "cancelled" }),
    ];
    expect(filedWithNobody(filed).map((r) => r.id)).toEqual(["nobody", "nobody-2"]);
  });
});

describe("inspectionFileHref: a row's name opens the person's file", () => {
  it("the lead's file first, then the customer's page, then the job", () => {
    expect(inspectionFileHref({ inquiry_id: "l1", customer_id: "c1", job_id: "j1" })).toBe("/leads/l1");
    expect(inspectionFileHref({ inquiry_id: null, customer_id: "c1", job_id: "j1" })).toBe("/crm/c1");
    expect(inspectionFileHref({ inquiry_id: null, customer_id: null, job_id: "j1" })).toBe("/jobs/j1");
  });
  it("the city's Final Inspection is about a job's permit: the job first", () => {
    expect(inspectionFileHref({ type: "final_inspection", inquiry_id: "l1", customer_id: "c1", job_id: "j1" })).toBe("/jobs/j1");
    expect(inspectionFileHref({ type: "final_inspection", customer_id: "c1" })).toBe("/crm/c1");
  });
  it("a visit that hangs on nobody has no file to open", () => {
    expect(inspectionFileHref({})).toBeNull();
    expect(inspectionFileHref({ inquiry_id: null, customer_id: null, job_id: null })).toBeNull();
  });
});
