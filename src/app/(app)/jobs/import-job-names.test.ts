import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AN IMPORTED JOB'S NAME (Erik 2026-09-28, "street number and name as always"). The sheet's job name is
 * a name a person typed: kept exactly as typed, unless it is only a source tag (or a tag and who or
 * where). Then the street number and name; with no street, the card the job lands on, named after it
 * is found or made (importJobs once named it from the sheet's bare text and cut a business down to
 * its last word, "Acme Property Management" → "Management").
 *
 *   - a card already in the book is named as it is stored (its company, else its whole name);
 *   - a card the import makes keeps the whole name.
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
import { parseCsv, previewName } from "./job-import-button";

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

describe("importJobs: the sheet's name as typed, else the street, else the card it lands on", () => {
  it("a blank or tag-only name with a street is the street number and name", async () => {
    await importJobs([row("Acme Property Management", ""), row("Acme Property Management", "Service call — Acme Property Management"), row("Rita Moss", "Inspection")]);
    expect(db.jobs.map((j) => j.name)).toEqual(["12 Elm St", "12 Elm St", "12 Elm St"]);
  });

  it("no street: an existing card by its whole name, the way New Job names it", async () => {
    await importJobs([{ ...row("Rita Moss", ""), address: "" }, { ...row("Acme Property Management", "Inspection"), address: "" }]);
    expect(db.jobs.map((j) => j.name)).toEqual(["Rita Moss", "Acme Property Management"]);
  });

  it("no street: a card the import makes is never cut to a last word", async () => {
    await importJobs([{ ...row("Smith Electric Inc", ""), address: "" }, { ...row("Tahoe Test HOA", "Inspection"), address: "" }]);
    expect(db.jobs.map((j) => j.name)).toEqual(["Smith Electric Inc", "Tahoe Test HOA"]);
  });

  it("the sheet's own name stays exactly as typed, a tag and real words included", async () => {
    await importJobs([row("Acme Property Management", "Service call — Panel swap"), row("Rita Moss", "RV Inspection"), row("Rita Moss", "TTP #56")]);
    expect(db.jobs.map((j) => j.name)).toEqual(["Service call — Panel swap", "RV Inspection", "TTP #56"]);
  });
});

describe("parseCsv: the job's name column is never the customer's", () => {
  it("'Customer Name' with no job column: no job name, so the street names the job", async () => {
    const rows = parseCsv("Customer Name,Address,Status\nRita Moss,12 Elm St,Scheduled\n");
    expect(rows).toMatchObject([{ customer: "Rita Moss", job_name: "", address: "12 Elm St" }]);
    expect(previewName(rows[0])).toBe("12 Elm St");
    await importJobs(rows);
    expect(db.jobs.map((j) => j.name)).toEqual(["12 Elm St"]);
  });

  it("'Client Name' the same", () => {
    expect(parseCsv("Client Name,Address\nRita Moss,12 Elm St\n")).toMatchObject([{ customer: "Rita Moss", job_name: "" }]);
  });

  it("'Customer Name, Job Name': the job's own column, never skipped for the customer's", () => {
    expect(parseCsv("Customer Name,Job Name,Address\nRita Moss,Back porch,12 Elm St\n")).toMatchObject([
      { customer: "Rita Moss", job_name: "Back porch", address: "12 Elm St" },
    ]);
    expect(parseCsv("Customer,Project,Address\nRita Moss,Back porch,12 Elm St\n")).toMatchObject([{ customer: "Rita Moss", job_name: "Back porch" }]);
  });

  it("the documented 'Customer, Job Name' and a sheet with only 'Name' read as before", () => {
    expect(parseCsv("Customer,Job Name,Address\nRita Moss,TTP #56,12 Elm St\n")).toMatchObject([{ customer: "Rita Moss", job_name: "TTP #56" }]);
    expect(parseCsv("Name,Address\nBack porch,12 Elm St\n")).toMatchObject([{ customer: "", job_name: "Back porch" }]);
  });
});
