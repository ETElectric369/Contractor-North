import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateDueTemplates } from "@/lib/recurring-engine";

/**
 * RECURRING BILLING OFF (the switch board, 0352, rule h), on the engine the daily cron runs.
 *
 *  - A switched-off company's due repeat INVOICE makes nothing, and its run is skipped, not saved up:
 *    next_date steps past today under the claim lock, with no last_generated_at, because nothing
 *    was generated.
 *  - So turning the switch back on never back-fills: the next run is the next one due.
 *  - A repeat job or expense is not the switch's ("Invoices that repeat on a schedule"): it runs
 *    exactly as before, so no rent or truck payment goes missing from the books.
 *  - Every other company, and a company with no switches stored, runs exactly as before.
 */
type Call = { table: string; op: "select" | "update" | "insert"; payload?: any; filters: [string, unknown][] };

function fakeDb(orgs: { id: string; settings: unknown }[], templates: any[]) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      calls.push(call);
      const result = () => {
        if (call.op === "update") return { data: [{ id: "x" }], error: null };
        if (call.op === "insert") return { data: null, error: null };
        if (table === "organizations") return { data: orgs, error: null };
        if (table === "recurring_templates") return { data: templates, error: null };
        return { data: [], error: null };
      };
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => (call.filters.push([c, v]), b),
        lte: (c: string, v: unknown) => (call.filters.push([c, v]), b),
        order: () => b,
        limit: () => b,
        update: (p: any) => ((call.op = "update"), (call.payload = p), b),
        insert: (p: any) => ((call.op = "insert"), (call.payload = p), b),
        maybeSingle: async () => ({
          data: table === "organizations" ? (orgs.find((o) => call.filters.some(([c, v]) => c === "id" && v === o.id)) ?? null) : null,
          error: null,
        }),
        single: async () => ({ data: { id: "inv-new" }, error: null }),
        then: (ok: any, err?: any) => Promise.resolve(result()).then(ok, err),
      };
      return b;
    },
  };
  const writes = () => calls.filter((c) => c.op !== "select");
  return { client, writes };
}

const invoiceTpl = (org_id: string, next_date: string) => ({
  id: `tpl-${org_id}`,
  org_id,
  kind: "invoice",
  customer_id: "cust-1",
  title: "Monthly service agreement",
  amount: 450,
  tax_rate: 0,
  frequency: "monthly",
  next_date,
  auto_send: false,
  line_items: null,
  created_by: "user-1",
});
const LA = { timezone: "America/Los_Angeles" };

beforeEach(() => {
  vi.useFakeTimers();
  // Noon Pacific, so the org's today is unambiguous.
  vi.setSystemTime(new Date("2026-09-26T19:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("the recurring engine and the Recurring Billing switch", () => {
  it("no switches stored (every company today): a due repeat invoice is made, exactly as before", async () => {
    const { client, writes } = fakeDb([{ id: "org-a", settings: LA }], [invoiceTpl("org-a", "2026-09-01")]);
    expect(await generateDueTemplates(client, null)).toBe(1);
    const w = writes();
    expect(w.some((c) => c.table === "invoices" && c.op === "insert")).toBe(true);
    const claim = w.find((c) => c.table === "recurring_templates" && c.op === "update")!;
    expect(claim.payload).toHaveProperty("last_generated_at");
    expect(claim.payload.next_date).toBe("2026-10-01");
  });

  it("switched off: no invoice is made, and the missed run is skipped (next_date past today, no last_generated_at)", async () => {
    const { client, writes } = fakeDb(
      [{ id: "org-a", settings: { ...LA, features: { recurring_billing: false } } }],
      // Three months behind: an invoice would make one.
      [invoiceTpl("org-a", "2026-07-01")],
    );
    expect(await generateDueTemplates(client, null)).toBe(0);
    const w = writes();
    expect(w.filter((c) => c.op === "insert")).toEqual([]);
    const skips = w.filter((c) => c.table === "recurring_templates" && c.op === "update");
    expect(skips).toHaveLength(1);
    expect(skips[0].payload).toEqual({ next_date: "2026-10-01" });
    // The same lock a claim uses: only while next_date still holds the value read.
    expect(skips[0].filters).toContainEqual(["next_date", "2026-07-01"]);
  });

  it("switched off: a repeat job and a repeat expense still run, catching up as before", async () => {
    const { client, writes } = fakeDb(
      [{ id: "org-a", settings: { ...LA, features: { recurring_billing: false } } }],
      // Three months behind: jobs and expenses catch up 3 periods each.
      [
        { ...invoiceTpl("org-a", "2026-07-01"), id: "tpl-job", kind: "job" },
        { ...invoiceTpl("org-a", "2026-07-01"), id: "tpl-rent", kind: "expense", vendor: "Landlord", category: "rent" },
      ],
    );
    expect(await generateDueTemplates(client, null)).toBe(6);
    const w = writes();
    expect(w.filter((c) => c.table === "jobs" && c.op === "insert")).toHaveLength(3);
    expect(w.filter((c) => c.table === "bills" && c.op === "insert")).toHaveLength(3);
    // No skip: every step is a claim that generated something.
    const updates = w.filter((c) => c.table === "recurring_templates" && c.op === "update");
    for (const u of updates) expect(u.payload).toHaveProperty("last_generated_at");
  });

  it("turning it back on never back-fills: the skipped template's next run is simply the next one due", async () => {
    vi.setSystemTime(new Date("2026-09-27T19:00:00Z"));
    const { client, writes } = fakeDb([{ id: "org-a", settings: { ...LA, features: { recurring_billing: true } } }], [invoiceTpl("org-a", "2026-10-01")]);
    expect(await generateDueTemplates(client, null)).toBe(0);
    expect(writes()).toEqual([]);
  });

  it("one company's switch never touches another company's templates", async () => {
    const { client, writes } = fakeDb(
      [
        { id: "org-off", settings: { ...LA, features: { recurring_billing: false } } },
        { id: "org-on", settings: LA },
      ],
      [invoiceTpl("org-off", "2026-09-01"), invoiceTpl("org-on", "2026-09-01")],
    );
    expect(await generateDueTemplates(client, null)).toBe(1);
    const inserts = writes().filter((c) => c.table === "invoices" && c.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload.org_id).toBe("org-on");
  });

  it("Sales Tax or any other switch off changes nothing here", async () => {
    const { client } = fakeDb([{ id: "org-a", settings: { ...LA, features: { sales_tax: false, website: false } } }], [invoiceTpl("org-a", "2026-09-01")]);
    expect(await generateDueTemplates(client, null)).toBe(1);
  });
});
