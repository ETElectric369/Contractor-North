import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readReconcileWork } from "./reconcile-read";
import { reconcileBadge } from "@/lib/reconcile-kinds";

/**
 * THE RECONCILE BADGE READS ONLY WHAT ITS COUNT READS (cn-v1190, P3).
 *
 * The dock's badge is read on every page the office opens. It used to pull every bill (up to 5,000)
 * with its job, the job's customer and every line's description. The job and the customer only NAME
 * a row; whether a row is open never reads them. So the badge's read (countsOnly) leaves them out, and
 * the count is still worked out by readReconcileWork, the one function the page reads. The lines stay:
 * a same-ticket pair is matched by its line count and by the invoice number read out of its lines.
 *
 * THE PROOF: the page's shape and the badge's shape read over the same stand-in rows give the same
 * count for every kind of work the page lists, and the same badge. The stand-in honours the select:
 * a read that does not ask for the job gets rows without it. SYNTHETIC: every name is invented.
 */

const ORG = "org-synthetic";
const ACCOUNT = "acct-tupelo";

const bill = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  supplier: "Tupelo Panel Supply",
  supplier_account_id: null,
  bill_number: null,
  amount: 100,
  amount_paid: 0,
  status: "unpaid",
  bill_date: "2026-09-01",
  job_id: "job-901",
  category: null,
  notes: null,
  supplier_invoice_number: null,
  superseded_by_bill_id: null,
  both_real_at: null,
  duplicate_dismissed_at: null,
  jobs: { job_number: "J-901", name: "Larkspur", customers: { name: "Larkspur" } },
  bill_line_items: [{ description: "1/2 conduit" }],
  ...over,
});

const TICKET = [{ description: "Lever connector" }, { description: "1/2 conduit" }, { description: "Staples" }];
// The supplier's invoice number read out of a line (lib/supplier-identity IN_LINE): the two copies have
// different line counts, so only the number in the lines makes them a pair.
const NUMBERED = [{ description: "Wire nuts (Invoice 77001)" }, { description: "Tape" }];

const BOOKS: Record<string, Record<string, unknown[]>> = {
  "every kind open": {
    supplier_accounts: [{ id: ACCOUNT, name: "Tupelo Panel Supply", account_number: "SYN-1", branch_code: null }],
    supplier_aliases: [{ alias: "Tupelo Panel Supply", supplier_account_id: ACCOUNT }, { alias: "TPS", supplier_account_id: ACCOUNT }],
    bills: [
      bill("b-on", { amount: 400, supplier_account_id: ACCOUNT }),
      // Same initials as the account, a different first word: the matcher asks rather than files it.
      bill("b-q", { supplier: "Thornwood Panel Supply", amount: 33 }),
      bill("b-m1", { supplier: "Snowbell Pipe & Fitting", amount: 50 }),
      bill("b-m2", { supplier: "Snowbell Pipe and Fitting", amount: 70 }),
      bill("b-loose", { supplier: "Quarry Lane Rentals", amount: 90 }),
      bill("b-noname", { supplier: "", amount: 12 }),
      bill("b-d1", { amount: 21.75, supplier_account_id: ACCOUNT, bill_line_items: TICKET, notes: "one.pdf" }),
      bill("b-d2", { amount: 21.75, supplier_account_id: ACCOUNT, bill_line_items: TICKET, notes: "two.pdf", job_id: "job-902", jobs: { job_number: "J-902", name: "Snowbell", customers: { name: "Snowbell" } } }),
    ],
  },
  "a pair answered, one dismissed, one found by the number in its lines": {
    supplier_accounts: [{ id: ACCOUNT, name: "Tupelo Panel Supply", account_number: "SYN-1", branch_code: null }],
    supplier_aliases: [{ alias: "Tupelo Panel Supply", supplier_account_id: ACCOUNT }],
    bills: [
      bill("b-a1", { amount: 30, supplier_account_id: ACCOUNT, bill_line_items: TICKET }),
      bill("b-a2", { amount: 30, supplier_account_id: ACCOUNT, bill_line_items: TICKET, superseded_by_bill_id: "b-a1", job_id: "job-902" }),
      bill("b-x1", { amount: 44, supplier_account_id: ACCOUNT, bill_line_items: TICKET }),
      bill("b-x2", { amount: 44, supplier_account_id: ACCOUNT, bill_line_items: TICKET, superseded_by_bill_id: "b-x1", duplicate_dismissed_at: "2026-11-20T00:00:00Z", job_id: "job-903" }),
      bill("b-n1", { amount: 61, supplier_account_id: ACCOUNT, bill_line_items: NUMBERED }),
      bill("b-n2", { amount: 61, supplier_account_id: ACCOUNT, bill_line_items: [...NUMBERED, { description: "Staples" }], job_id: "job-904" }),
      bill("b-paid", { supplier: "Hollin Street Fuel Stop", amount: 48.3, status: "paid", category: "Fuel", job_id: null, jobs: null }),
    ],
  },
  "nothing open": {
    supplier_accounts: [{ id: ACCOUNT, name: "Tupelo Panel Supply", account_number: "SYN-1", branch_code: null }],
    supplier_aliases: [{ alias: "Tupelo Panel Supply", supplier_account_id: ACCOUNT }],
    bills: [bill("b-on", { supplier_account_id: ACCOUNT })],
  },
};

/** A PostgREST stand-in that answers the columns asked for: no `jobs(` in the select, no job on the row. */
function fakeDb(book: Record<string, unknown[]>, selects: string[]) {
  return {
    from: (table: string) => {
      let cols = "";
      const c: Record<string, unknown> = {};
      for (const m of ["eq", "neq", "in", "is", "not", "or", "order", "limit", "gte", "lte"]) c[m] = () => c;
      c.select = (s: string) => {
        cols = String(s ?? "");
        if (table === "bills") selects.push(cols);
        return c;
      };
      const rows = () =>
        (book[table] ?? []).map((r) => {
          const row = { ...(r as Record<string, unknown>) };
          if (table === "bills" && !/\bjobs\(/.test(cols)) delete row.jobs;
          return row;
        });
      c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok, err);
      return c;
    },
  } as any;
}

describe("the badge's slim read counts what the page counts", () => {
  for (const [name, book] of Object.entries(BOOKS)) {
    it(name, async () => {
      const pageSelects: string[] = [];
      const badgeSelects: string[] = [];
      const page = await readReconcileWork(fakeDb(book, pageSelects), ORG, null);
      const badge = await readReconcileWork(fakeDb(book, badgeSelects), ORG, null, { countsOnly: true });
      expect(badge.counts).toEqual(page.counts);
      expect(reconcileBadge(badge.counts)).toBe(reconcileBadge(page.counts));
      expect(badge.failed).toEqual(page.failed);
      // The page's read still carries the job and the customer (its rows name them); the badge's does not.
      expect(pageSelects[0]).toContain("jobs(job_number, name, customers(name))");
      expect(badgeSelects[0]).not.toContain("jobs(");
      // The lines ride both: the same-ticket count reads them.
      expect(badgeSelects[0]).toContain("bill_line_items(description)");
    });
  }

  it("the first book has every kind the badge counts open, so the proof is not over zeros", async () => {
    const work = await readReconcileWork(fakeDb(BOOKS["every kind open"], []), ORG, null, { countsOnly: true });
    expect(work.counts["supplier-names"]).toBeGreaterThan(0);
    expect(work.counts["same-supplier-or-two"]).toBeGreaterThan(0);
    expect(work.counts["not-on-an-account"]).toBeGreaterThan(0);
    expect(work.counts["same-ticket-two-jobs"]).toBeGreaterThan(0);
  });

  it("the layout's badge asks for the slim read", () => {
    const layout = readFileSync(join(process.cwd(), "src/app/(app)/layout.tsx"), "utf8");
    expect(layout).toContain("const work = await readReconcileWork(supabase, profile.org_id, null, { countsOnly: true });");
  });
});
