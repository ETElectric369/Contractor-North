import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE RECURRING ENGINE AND THE PLAN THAT HAS ENDED (cn-v1137, decision 3). A lapsed company's
 * templates — a repeat invoice, a repeat job, a repeat expense — are passed over whole: nothing is
 * generated AND nothing is stepped (unlike the Recurring Billing switch, which skips a run), so the
 * day a plan is picked the engine makes up what is owed. The run says how many companies it passed
 * over; a comped company (0400's column) is never lapsed. Billing is ON here (the fixtures carry a
 * status): with billing off nothing lapses at all.
 */
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), billingEnabled: true }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn(), errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));

import { generateDueTemplates } from "@/lib/recurring-engine";

type Call = { table: string; op: "select" | "update" | "insert"; payload?: any; filters: [string, unknown][] };

function fakeDb(orgs: Record<string, unknown>[], templates: any[]) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      calls.push(call);
      let pageFrom = 0; // readAllOrgs pages organizations: the rows at 0, an empty page after
      const result = () => {
        if (call.op === "update") return { data: [{ id: "x" }], error: null };
        if (call.op === "insert") return { data: null, error: null };
        if (table === "organizations") return { data: pageFrom > 0 ? [] : orgs, error: null };
        if (table === "recurring_templates") return { data: templates, error: null };
        return { data: [], error: null };
      };
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => (call.filters.push([c, v]), b),
        lte: (c: string, v: unknown) => (call.filters.push([c, v]), b),
        order: () => b,
        range: (start: number) => ((pageFrom = start), b),
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
  return { client, writes: () => calls.filter((c) => c.op !== "select") };
}

const tpl = (org_id: string, kind: "invoice" | "job" | "expense", next_date = "2026-09-01") => ({
  id: `tpl-${org_id}-${kind}`,
  org_id,
  kind,
  customer_id: "cust-1",
  title: kind === "expense" ? "Storage unit" : "Monthly service agreement",
  vendor: kind === "expense" ? "Larkspur Storage" : undefined,
  category: kind === "expense" ? "Other" : undefined,
  amount: 450,
  tax_rate: 0,
  frequency: "monthly",
  next_date,
  auto_send: false,
  line_items: null,
  created_by: "user-1",
});
const LA = { timezone: "America/Los_Angeles" };
const STANDING = { id: "org-on", settings: LA, subscription_status: "active" };
const LAPSED = { id: "org-lapsed", settings: LA, subscription_status: "canceled" };
const COMPED = { id: "org-comped", settings: LA, subscription_status: "canceled", comped_until: "2099-01-01T00:00:00.000Z" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T19:00:00Z")); // noon Pacific
});
afterEach(() => vi.useRealTimers());

describe("the recurring engine and a lapsed company", () => {
  it("a standing company runs as before, and the run says no company was passed over", async () => {
    const { client, writes } = fakeDb([STANDING], [tpl("org-on", "invoice")]);
    expect(await generateDueTemplates(client, null)).toEqual({ generated: 1, lapsed_skipped: 0 });
    expect(writes().some((c) => c.table === "invoices" && c.op === "insert")).toBe(true);
  });

  it("a lapsed company's invoice, job and expense are neither generated nor stepped; the standing company's still are", async () => {
    const { client, writes } = fakeDb(
      [STANDING, LAPSED],
      [tpl("org-lapsed", "invoice"), tpl("org-lapsed", "job"), tpl("org-lapsed", "expense"), tpl("org-on", "invoice")],
    );
    expect(await generateDueTemplates(client, null)).toEqual({ generated: 1, lapsed_skipped: 1 });
    const w = writes();
    // Every row born is the standing company's: one invoice, no job, no bill. Nothing on the lapsed templates.
    expect(w.filter((c) => c.op === "insert" && ["invoices", "jobs", "bills"].includes(c.table)).map((c) => `${c.table}:${c.payload.org_id}`)).toEqual(["invoices:org-on"]);
    const claims = w.filter((c) => c.table === "recurring_templates" && c.op === "update");
    expect(claims).toHaveLength(1);
    expect(claims[0].filters).toContainEqual(["id", "tpl-org-on-invoice"]);
  });

  it("a comped company is never lapsed: its repeat invoice is made", async () => {
    const { client, writes } = fakeDb([COMPED], [tpl("org-comped", "invoice")]);
    expect(await generateDueTemplates(client, null)).toEqual({ generated: 1, lapsed_skipped: 0 });
    expect(writes().some((c) => c.table === "invoices" && c.op === "insert")).toBe(true);
  });
});
