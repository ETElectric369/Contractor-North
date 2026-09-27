import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE 6 PM "CLOSE OUT YOUR DAY" PUSH AGREES WITH MY DAY (0357). A closed shift on no job that a live
 * invoice holds (billed by hand on an invoice with no job, TTUSD on INV-055) is billed: My Day drops
 * its Needs You row, and the push no longer names it either. A lost claims read keeps it (a nag too
 * many, never a gap missed).
 */

const sent: { body: string }[] = [];
vi.mock("@/lib/push", () => ({
  pushConfigured: () => true,
  orgStaffIds: async () => ["p-erik"],
  sendPushToProfiles: async (_ids: string[], _kind: string, msg: { body: string }) => {
    sent.push(msg);
  },
}));

import { sendCloseOutNudges } from "./eod-sweep";

const ORG = "60195593-2e18-4230-bc8e-7a32d36d038d";
const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);

type Reply = { data?: unknown; error?: unknown };
function fake(route: (table: string, filters: string[]) => Reply) {
  return {
    from(table: string) {
      const filters: string[] = [];
      const chain: any = {
        select: () => chain,
        then: (res: (r: Reply) => void) => {
          const r = route(table, filters);
          res({ data: r.data ?? null, error: r.error ?? null });
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gte", "order", "limit", "overlaps"])
        chain[m] = (...a: unknown[]) => {
          filters.push(`${m}:${String(a[0])}`);
          return chain;
        };
      return chain;
    },
  };
}

const shift = (id: string, name: string) => ({
  id,
  status: "closed",
  job_id: null,
  clock_in: `${day(2)}T15:00:00Z`,
  clock_out: `${day(2)}T23:00:00Z`,
  job_code: null,
  profiles: { full_name: name },
});

function route(claims: Reply) {
  return (table: string, filters: string[]): Reply => {
    if (table === "organizations") return { data: [{ id: ORG, settings: { timezone: "America/Los_Angeles" } }] };
    if (table === "time_entries") return filters.includes("gte:clock_in") ? { data: [shift("t-ttusd", "JP Prince"), shift("t-open", "Brian Taylor")] } : { data: [] };
    if (table === "invoice_items") return claims;
    return { data: [] };
  };
}

describe("the close-out push and hours on no job billed by hand", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("a shift a live invoice holds is not named; one nobody billed still is", async () => {
    const held = { data: [{ import_key: null, source_ids: ["t-ttusd"], invoices: { id: "inv-55", invoice_number: "INV-055", status: "paid", created_at: day(40), job_id: null } }] };
    await sendCloseOutNudges(fake(route(held)));
    expect(sent.map((m) => m.body)).toEqual(["Brian's entry has no job"]);
  });

  it("every one billed: no push at all", async () => {
    const held = { data: [{ import_key: null, source_ids: ["t-ttusd", "t-open"], invoices: { id: "inv-55", invoice_number: "INV-055", status: "paid", created_at: day(40), job_id: null } }] };
    await sendCloseOutNudges(fake(route(held)));
    expect(sent).toEqual([]);
  });

  it("a lost claims read keeps every finding", async () => {
    await sendCloseOutNudges(fake(route({ error: { message: "timeout" } })));
    expect(sent.map((m) => m.body)).toEqual(["JP's entry has no job · Brian's entry has no job"]);
  });
});
