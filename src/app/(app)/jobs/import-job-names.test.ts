import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AN IMPORTED JOB IS NAMED FOR THE CARD IT LANDS ON (Erik 2026-09-27: a job's name says who/where and
 * what, never where it came from). importJobs named the job before the customer was found or made,
 * from the sheet's bare customer text, so a business customer with a blank or tag-only job name was
 * cut down to its last word: "Acme Property Management" → "Management · 12 Elm St".
 *
 *   - a card already in the book is named as it is stored (its company, its type), the same as New Job;
 *   - a card the import makes (the sheet says nothing of its kind) keeps the whole name;
 *   - the sheet's own words still win, with an old system's source tag taken off.
 * Synthetic people and streets.
 */
const db = vi.hoisted(() => ({
  book: [] as { id: string; name: string; company_name: string | null; type: string | null }[],
  jobs: [] as any[],
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: client(), userId: "user-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { importJobs } from "./actions";

function client() {
  return {
    from(table: string) {
      const q: { op: string; payload?: any; ilike: [string, string][] } = { op: "select", ilike: [] };
      const run = async () => {
        if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } }, error: null };
        if (table === "customers" && q.op === "select") {
          const name = q.ilike.find(([c]) => c === "name")?.[1] ?? "";
          return { data: db.book.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null, error: null };
        }
        if (table === "customers" && q.op === "insert") return { data: { id: `cust-new-${db.book.length}` }, error: null };
        if (table === "jobs" && q.op === "insert") {
          db.jobs.push(q.payload);
          return { data: { id: `job-${db.jobs.length}`, job_number: `J-${db.jobs.length}` }, error: null };
        }
        throw new Error(`unrouted: ${table} ${q.op}`);
      };
      const chain: any = {
        select: () => chain,
        insert: (p: any) => ((q.op = "insert"), (q.payload = p), chain),
        ilike: (c: string, v: string) => (q.ilike.push([c, v]), chain),
        eq: () => chain,
        limit: () => chain,
        single: run,
        maybeSingle: run,
        then: (ok: any, bad: any) => run().then(ok, bad),
      };
      return chain;
    },
  };
}

const row = (customer: string, job_name: string) => ({ customer, job_name, address: "12 Elm St", value: 0 });

beforeEach(() => {
  db.book = [
    { id: "cust-acme", name: "Acme Property Management", company_name: null, type: "commercial" },
    { id: "cust-rita", name: "Rita Moss", company_name: null, type: "residential" },
  ];
  db.jobs = [];
});

describe("importJobs: the job is named for the card it lands on", () => {
  it("an existing business card keeps its whole name, blank or tag-only", async () => {
    await importJobs([row("Acme Property Management", ""), row("Acme Property Management", "Service call — Acme Property Management")]);
    expect(db.jobs.map((j) => j.name)).toEqual(["Acme Property Management · 12 Elm St", "Acme Property Management · 12 Elm St"]);
  });

  it("an existing person's card is named the way New Job names it", async () => {
    await importJobs([row("Rita Moss", "")]);
    expect(db.jobs[0].name).toBe("Moss · 12 Elm St");
  });

  it("a card the import makes is never cut to a last word", async () => {
    await importJobs([row("Smith Electric Inc", ""), row("Tahoe Test HOA", "Inspection")]);
    expect(db.jobs.map((j) => j.name)).toEqual(["Smith Electric Inc · 12 Elm St", "Tahoe Test HOA · 12 Elm St"]);
  });

  it("the sheet's own words win, with the source tag off", async () => {
    await importJobs([row("Acme Property Management", "Service call — Panel swap"), row("Rita Moss", "RV Inspection")]);
    expect(db.jobs.map((j) => j.name)).toEqual(["Panel swap", "RV Inspection"]);
  });
});
