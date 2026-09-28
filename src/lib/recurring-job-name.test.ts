import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runTemplate } from "@/lib/recurring-engine";

/**
 * A RECURRING TEMPLATE'S TITLE IS THE WORK, AS TYPED. Erik's rule (2026-09-27) is that a job never
 * carries where it CAME FROM ("same goes for any conversion"). A template is not a conversion: its
 * title is only ever typed by a person on the Recurring form ("e.g. Monthly maintenance — Acme"), and
 * it is the one place each generated job says what the work is. So a monthly "Inspection" or
 * "Service call — Unit 4B" makes jobs with exactly that name, never "Moss" or "New Job · Oct 1".
 * Synthetic people.
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
  for (const title of ["Inspection", "Service call — Unit 4B", "Inspection — Acme Warehouse", "Walk-through", "Monthly maintenance — Acme"]) {
    it(`"${title}" names every job it makes`, async () => {
      const { client, inserts, reads } = fakeDb(rita);
      expect(await runTemplate(client, tpl(title), null, LA)).toBe(true);
      const job = inserts.find((i) => i.table === "jobs");
      expect(job?.payload.name).toBe(title);
      expect(reads).not.toContain("customers"); // nothing to look up: the title is the name
    });
  }

  it("no customer, a bare work word: still the work, never \"New Job · Oct 1\"", async () => {
    const { client, inserts } = fakeDb(null);
    await runTemplate(client, tpl("Inspection", null), null, LA);
    expect(inserts.find((i) => i.table === "jobs")?.payload.name).toBe("Inspection");
  });

  it("only a blank title (never saved by the form) falls to the one default", async () => {
    const { client, inserts } = fakeDb(rita);
    await runTemplate(client, tpl("  "), null, LA);
    expect(inserts.find((i) => i.table === "jobs")?.payload.name).toBe("Moss");
  });
});
