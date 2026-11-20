import { describe, it, expect } from "vitest";
import {
  BILLED_JOB_COLUMNS,
  ESTIMATE_LINK_COLUMNS,
  ORG_COLUMNS,
  VISIT_COLUMNS,
  VISIT_READ_CAP,
  readInspectionBuckets,
} from "./inspections-read";
import { PAGE_ROWS } from "./read-all-pages";
import { ESTIMATE_VISIT_TYPES } from "./statuses";

/**
 * THE ONE READER FOR THE INSPECTION BUCKETS (cn-v1172), against a stand-in client that records every
 * call. Both the Inspections page and the Estimates page's top list read through it, so the two can
 * never disagree about who is where. Made-up people and streets.
 */

type Call = { table: string; ops: [string, unknown[]][] };

function standIn(tables: Record<string, unknown[]>, opts: { fail?: string; org?: unknown } = {}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    let range: [number, number] | null = null;
    const result = () => {
      if (opts.fail === table) return { data: null, error: { message: "boom" } };
      const rows = tables[table] ?? [];
      return { data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null };
    };
    const q: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (ok: any, err: any) => Promise.resolve(result()).then(ok, err);
          if (prop === "maybeSingle")
            return async () => (opts.fail === table ? { data: null, error: { message: "boom" } } : { data: opts.org ?? null, error: null });
          return (...args: unknown[]) => {
            call.ops.push([prop, args]);
            if (prop === "range") range = [args[0] as number, args[1] as number];
            return q;
          };
        },
      },
    );
    return q;
  };
  return { client: { from } as any, calls };
}

const NOW = new Date("2026-11-10T18:00:00Z");
const ORG = { settings: { timezone: "America/Los_Angeles" } };
const visit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "inspection",
  title: "Inspection",
  status: "completed",
  starts_at: "2026-11-03T18:00:00Z",
  ends_at: null,
  created_at: "2026-10-20T18:00:00Z",
  location: "12 Larkspur Ln",
  capture: null,
  inquiry_id: null,
  job_id: null,
  customer_id: null,
  outcome: null,
  ...over,
});

describe("readInspectionBuckets", () => {
  it("pins every read's columns, filters and order; no money column anywhere", async () => {
    const { client, calls } = standIn({}, { org: ORG });
    await readInspectionBuckets(client, { now: NOW });
    const byTable = Object.fromEntries(calls.map((c) => [c.table, c.ops]));
    expect(Object.keys(byTable).sort()).toEqual(["appointments", "invoices", "organizations", "quotes"]);
    expect(byTable.appointments).toEqual([
      ["select", [VISIT_COLUMNS]],
      ["in", ["type", [...ESTIMATE_VISIT_TYPES]]],
      ["order", ["starts_at", { ascending: false, nullsFirst: true }]],
      ["limit", [VISIT_READ_CAP]],
    ]);
    expect(VISIT_COLUMNS).toBe(
      "id, type, title, status, starts_at, ends_at, created_at, location, capture, inquiry_id, job_id, customer_id, outcome, customers(name), inquiries(name)",
    );
    expect(byTable.quotes).toEqual([
      ["select", [ESTIMATE_LINK_COLUMNS]],
      ["order", ["id"]],
      ["range", [0, PAGE_ROWS - 1]],
    ]);
    expect(ESTIMATE_LINK_COLUMNS).toBe("id, inquiry_id, job_id");
    expect(byTable.invoices).toEqual([
      ["select", [BILLED_JOB_COLUMNS]],
      ["not", ["job_id", "is", null]],
      ["not", ["status", "in", "(draft,void)"]],
      ["order", ["id"]],
      ["range", [0, PAGE_ROWS - 1]],
    ]);
    expect(byTable.organizations).toEqual([
      ["select", [ORG_COLUMNS]],
      ["limit", [1]],
    ]);
    for (const cols of [VISIT_COLUMNS, ESTIMATE_LINK_COLUMNS, BILLED_JOB_COLUMNS, ORG_COLUMNS]) expect(cols).not.toMatch(/\*|amount|total|price|rate/);
  });

  it("buckets by the one rule, in the company's clock: priced, billed and on a job file away; the rest waits on a price", async () => {
    const { client } = standIn(
      {
        appointments: [
          visit("v-lead", { inquiry_id: "inq-1" }),
          visit("v-priced", { inquiry_id: "inq-2" }),
          visit("v-capture", { capture: { quote_id: "q-3" } }),
          visit("v-billed", { job_id: "job-4" }),
          visit("v-ahead", { status: "scheduled", starts_at: "2026-11-12T18:00:00Z" }),
        ],
        quotes: [{ id: "q-2", inquiry_id: "inq-2", job_id: null }, { id: "q-3", inquiry_id: null, job_id: null }],
        invoices: [{ job_id: "job-4" }],
      },
      { org: ORG },
    );
    const r = await readInspectionBuckets(client, { now: NOW });
    expect(r.error).toBeNull();
    expect(r.tz).toBe("America/Los_Angeles");
    expect(r.buckets.toWriteUp.map((v) => v.id)).toEqual(["v-lead"]);
    expect(r.buckets.upcoming.map((v) => v.id)).toEqual(["v-ahead"]);
    expect(r.buckets.filed.map((v) => v.id).sort()).toEqual(["v-billed", "v-capture", "v-priced"]);
    expect(r.capped).toBe(false);
  });

  it("reads the estimates WHOLE: an estimate past the first thousand still settles its visit", async () => {
    const many = Array.from({ length: PAGE_ROWS + 5 }, (_, i) => ({ id: `q-${String(i).padStart(5, "0")}`, inquiry_id: `inq-${i}`, job_id: null }));
    const { client, calls } = standIn({ appointments: [visit("v-late", { inquiry_id: `inq-${PAGE_ROWS + 2}` })], quotes: many }, { org: ORG });
    const r = await readInspectionBuckets(client, { now: NOW });
    expect(r.buckets.toWriteUp).toEqual([]);
    expect(r.buckets.filed.map((v) => v.id)).toEqual(["v-late"]);
    expect(calls.filter((c) => c.table === "quotes").length).toBe(3); // two pages and the empty one
  });

  it("exactly the cap read: capped", async () => {
    const { client } = standIn({ appointments: Array.from({ length: VISIT_READ_CAP }, (_, i) => visit(`v-${i}`)) }, { org: ORG });
    expect((await readInspectionBuckets(client, { now: NOW })).capped).toBe(true);
  });

  for (const [table, where] of [
    ["appointments", "visits"],
    ["quotes", "estimates"],
    ["invoices", "billed"],
    ["organizations", "org"],
  ] as const) {
    it(`a failed ${table} read is returned, with empty buckets, never a guess`, async () => {
      const { client } = standIn({ appointments: [visit("v-1")] }, { fail: table, org: ORG });
      const r = await readInspectionBuckets(client, { now: NOW });
      expect(r.error?.where).toBe(where);
      expect(r.visits).toEqual([]);
      expect(r.buckets).toEqual({ toWriteUp: [], upcoming: [], missed: [], filed: [] });
    });
  }
});
