import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runTemplate } from "@/lib/recurring-engine";

/**
 * A RECURRING TEMPLATE'S TITLE IS A NAME A PERSON TYPED (Erik 2026-09-28): every job it makes keeps
 * it exactly as typed ("Service call — Unit 4B", "Monthly maintenance — Acme"), unless it is ONLY a
 * source tag, or a tag and the customer ("Inspection", "Walk-through", "Site visit: Rita Moss"):
 * that is no name, and the job is named for who, as written ("Rita Moss"), else "New Job · Sep 26"
 * on the company's today. Synthetic people.
 */
function fakeDb(customer: unknown) {
  const inserts: any[] = [];
  const reads: string[] = [];
  const client = {
    from(table: string) {
      let op = "select";
      let payload: any;
      const result = () => {
        if (op === "update") return { data: [{ id: "x" }], error: null };
        if (op === "insert") return (inserts.push({ table, payload }), { data: null, error: null });
        return { data: null, error: null };
      };
      const b: any = {
        select: () => b,
        eq: () => b,
        lte: () => b,
        order: () => b,
        limit: () => b,
        update: () => ((op = "update"), b),
        insert: (p: any) => ((op = "insert"), (payload = p), b),
        maybeSingle: async () => (reads.push(table), { data: table === "customers" ? customer : null, error: null }),
        then: (ok: any, err?: any) => Promise.resolve(result()).then(ok, err),
      };
      return b;
    },
  };
  return { client, inserts, reads };
}

const tpl = (title: string | null, customer_id: string | null = "cust-1") => ({
  id: "tpl-1",
  org_id: "org-a",
  kind: "job",
  customer_id,
  title,
  description: null,
  frequency: "monthly",
  next_date: "2026-10-01",
});
const LA = { timezone: "America/Los_Angeles" };
const rita = { name: "Rita Moss", company_name: null, type: "residential" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T19:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("recurring jobs keep the template's title as typed", () => {
  for (const title of ["Monthly maintenance — Acme", "RV Inspection", "Panel check"]) {
    it(`"${title}" names every job it makes`, async () => {
      const { client, inserts, reads } = fakeDb(rita);
      expect(await runTemplate(client, tpl(title), null, LA)).toBe(true);
      const job = inserts.find((i) => i.table === "jobs");
      expect(job?.payload.name).toBe(title);
      expect(reads).not.toContain("customers"); // nothing to look up: the title is the name
    });
  }

  for (const title of ["Inspection — Acme Warehouse", "Service call — Unit 4B"]) {
    it(`"${title}" is a tag and real words (not the customer): kept as typed`, async () => {
      const { client, inserts } = fakeDb(rita);
      await runTemplate(client, tpl(title), null, LA);
      expect(inserts.find((i) => i.table === "jobs")?.payload.name).toBe(title);
    });
  }

  for (const title of ["Inspection", "Walk-through", "Site visit: Rita Moss", "  "]) {
    it(`"${title}" is only a tag (or nothing): the job is named for the customer as written`, async () => {
      const { client, inserts } = fakeDb(rita);
      await runTemplate(client, tpl(title), null, LA);
      expect(inserts.find((i) => i.table === "jobs")?.payload.name).toBe("Rita Moss");
    });
  }

  it("only a tag and no customer: New Job on the company's today", async () => {
    const { client, inserts } = fakeDb(null);
    await runTemplate(client, tpl("Inspection", null), null, LA);
    expect(inserts.find((i) => i.table === "jobs")?.payload.name).toBe("New Job · Sep 26");
  });
});
