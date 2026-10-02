import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE 6 PM "CLOSE OUT YOUR DAY" PUSH AGREES WITH MY DAY (0357). A closed shift on no job that a live
 * invoice holds (billed by hand on an invoice with no job, TTUSD on INV-055) is billed: My Day drops
 * its Needs You row, and the push no longer names it either. A lost claims read keeps it (a nag too
 * many, never a gap missed).
 */

const sent: { body: string }[] = [];
// The push goes out through notifyPeople (the Bell records every push, 0366 wave): one call, one
// message, the bell line and the buzz together.
const kinds: string[] = [];
vi.mock("@/lib/push", () => ({
  pushConfigured: () => true,
  orgStaffIds: async () => ["p-erik"],
}));
vi.mock("@/lib/notifications", () => ({
  notifyPeople: async (_org: string, _ids: string[], kind: string, msg: { body: string }) => {
    kinds.push(kind);
    sent.push(msg);
    return { bell: true, pushed: ["p-erik"] };
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
    kinds.length = 0;
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

  it("it goes out as the opt-in day_ahead kind, through the one door that also writes the bell line", async () => {
    await sendCloseOutNudges(fake(route({ error: { message: "timeout" } })));
    expect(kinds).toEqual(["day_ahead"]);
  });
});

/**
 * THE JOBS THE PUSH NAMES (NY-feeders and NY-hold, 0366): a job on hold is waiting on purpose, so
 * "nothing scheduled next" is never said about it; and a job whose live invoice bills materials lines
 * has costs on the record (costedJobIds, the one rule My Day uses too), so it is never "no costs".
 */
describe("the close-out push and the jobs it names", () => {
  beforeEach(() => {
    sent.length = 0;
    kinds.length = 0;
  });

  const worked = (id: string, job: string) => ({
    id,
    status: "closed",
    job_id: job,
    clock_in: `${day(1)}T15:00:00Z`,
    clock_out: `${day(1)}T23:00:00Z`,
    job_code: null,
    profiles: { full_name: "Brian Taylor" },
  });
  const routeJobs = (jobs: any[], extra: { bills?: any[]; invoices?: any[] } = {}) => (table: string, filters: string[]): Reply => {
    if (table === "organizations") return { data: [{ id: ORG, settings: { timezone: "America/Los_Angeles" } }] };
    if (table === "time_entries") return filters.includes("gte:clock_in") ? { data: jobs.map((j, i) => worked(`t${i}`, j.id)) } : { data: [] };
    if (table === "jobs") return { data: jobs };
    if (table === "bills") return { data: extra.bills ?? [] };
    if (table === "invoices") return { data: extra.invoices ?? [] };
    return { data: [] };
  };

  it("a held job isn't named: it waits on its own day", async () => {
    const held = { id: "j-held", job_number: "J-048", name: "Tupelo Ln", status: "on_hold", scheduled_start: null };
    await sendCloseOutNudges(fake(routeJobs([held], { bills: [{ job_id: "j-held" }] })));
    expect(sent).toEqual([]);
    // The same job, not held, is asked about.
    await sendCloseOutNudges(fake(routeJobs([{ ...held, status: "in_progress" }], { bills: [{ job_id: "j-held" }] })));
    expect(sent.map((m) => m.body)).toEqual(["Tupelo Ln has nothing scheduled next"]);
  });

  it("a job whose live invoice bills materials lines isn't 'no costs'; labor lines alone, or a void invoice, still are", async () => {
    const job = { id: "j-9", job_number: "J-009", name: "Honeysuckle", status: "in_progress", scheduled_start: `${day(-3)}T16:00:00Z` };
    await sendCloseOutNudges(
      fake(routeJobs([job], { invoices: [{ job_id: "j-9", status: "draft", invoice_items: [{ line_kind: "labor" }, { line_kind: "materials" }] }] })),
    );
    expect(sent).toEqual([]);
    await sendCloseOutNudges(fake(routeJobs([job], { invoices: [{ job_id: "j-9", status: "sent", invoice_items: [{ line_kind: "labor" }] }] })));
    expect(sent.map((m) => m.body)).toEqual(["Honeysuckle has no costs recorded"]);
    sent.length = 0;
    await sendCloseOutNudges(fake(routeJobs([job], { invoices: [{ job_id: "j-9", status: "void", invoice_items: [{ line_kind: "materials" }] }] })));
    expect(sent.map((m) => m.body)).toEqual(["Honeysuckle has no costs recorded"]);
  });
});
