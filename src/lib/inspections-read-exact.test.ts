import { describe, it, expect, vi, beforeEach } from "vitest";
import { client, makeDb, type Db, type Row } from "@/lib/appointments/visit-db.test-util";

/**
 * THE OFFER FINDS A JOB BY NAME AND STREET FOR A VISIT WITH NO RECORD (cn-v1181, I3). The owner's case,
 * in stand-ins: an inspection put in by hand ("Site inspection: Dana Rook", 410 Larkspur Lane, no
 * customer record, no lead), marked Won with no job picked, and a job made by hand later for Dana Rook at
 * 410 Larkspur Ln. The row offered nothing, because the offer read a customer RECORD only. Now the reader
 * reads the jobs an exact match can name (bounded, said when cut) and the row offers that job. On a
 * stand-in that honours every filter and select list.
 */
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
const { readInspectionBuckets, OFFER_EXACT_CAP } = await import("./inspections-read");
const { reportError } = await import("@/lib/observe");

const NOW = new Date("2026-11-22T20:00:00Z");
const visit = (id: string, over: Row = {}): Row => ({
  id,
  type: "inspection",
  title: "Site inspection: Dana Rook",
  status: "completed",
  outcome: "won",
  starts_at: "2026-11-08T18:00:00Z",
  ends_at: null,
  created_at: "2026-11-01T18:00:00Z",
  location: "410 Larkspur Lane, Truckee, CA 96161",
  capture: null,
  inquiry_id: null,
  job_id: null,
  customer_id: null,
  ...over,
});
const job = (id: string, over: Row = {}): Row => ({
  id,
  customer_id: "cust-dana",
  created_at: "2026-11-15T18:00:00Z",
  job_number: "J-900",
  name: "Larkspur panel",
  address: "410 Larkspur Ln",
  // jobs.unit (the job's own unit column; the exact match reads it beside the street, skeptic #84 M5).
  unit: null,
  status: "scheduled",
  inquiry_id: null,
  ...over,
});
let db: Db;
const read = () => readInspectionBuckets(client(db) as never, { now: NOW });

beforeEach(() => {
  vi.mocked(reportError).mockClear();
  db = makeDb(
    {
      appointments: [visit("v-dana")],
      quotes: [],
      invoices: [],
      organizations: [{ settings: { timezone: "America/Los_Angeles" } }],
      customers: [
        { id: "cust-dana", name: "Dana Rook" },
        { id: "cust-theo", name: "Theo Vance" },
      ],
      inquiries: [],
      jobs: [job("job-900")],
    },
    {
      appointments: Object.keys(visit("x")),
      quotes: ["id", "inquiry_id", "job_id"],
      invoices: ["id", "job_id", "status", "invoice_kind"],
      organizations: ["settings"],
      customers: ["id", "name"],
      inquiries: ["id", "name", "converted_at", "customer_id"],
      jobs: Object.keys(job("x")),
    },
  );
});

describe("the offer for a visit with no customer record", () => {
  it("the job that matches it exactly is offered", async () => {
    const r = await read();
    expect(r.error).toBeNull();
    expect(r.offers.get("v-dana")).toEqual({ kind: "job", id: "job-900", label: "J-900 Larkspur panel", others: [] });
  });

  it("not exact (another person, another street, made before the visit, cancelled): nothing", async () => {
    for (const over of [{ customer_id: "cust-theo" }, { address: "9 Snowbell Ct" }, { created_at: "2026-11-02T18:00:00Z" }, { status: "cancelled" }]) {
      db.tables.jobs = [job("job-900", over)];
      expect((await read()).offers.get("v-dana"), JSON.stringify(over)).toBeUndefined();
    }
  });

  it("a read cut at the cap is said to the ops sink; a failed one offers nothing and is said too, the page still reads", async () => {
    db.tables.jobs = Array.from({ length: OFFER_EXACT_CAP }, (_, i) => job(`job-${i}`, { address: `${i + 1} Bayberry Rd` }));
    await read();
    expect(reportError).toHaveBeenCalledWith("inspections:offers:exact-capped", expect.anything());
    db.fail!.read!.add("jobs");
    const r = await read();
    expect(r.offers.size).toBe(0);
    expect(reportError).toHaveBeenCalledWith("inspections:offers:exact", expect.anything());
  });
});
