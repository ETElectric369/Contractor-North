import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { unzip, text } from "@/test/unzip";

/**
 * THE ACCOUNTANT'S DOWNLOAD IS THE OFFICE'S. requireStaff is the refusal: a tech (or anyone it turns
 * away) gets a 403 in words and not one row read. A bad period is refused in words. A read that
 * doesn't come back whole refuses the file, in words. A staff download is the workbook or the CSV
 * zip, named after the company and the period, and an office viewer the owner hasn't shared Owner's
 * Draw with gets no Net in it. Every name and number here is invented.
 */
const state: {
  staff: boolean;
  role: string;
  officeSees: boolean;
  salesTax: boolean;
  failing: string[];
  reads: string[];
  inserts: string[];
} = { staff: true, role: "owner", officeSees: true, salesTax: false, failing: [], reads: [], inserts: [] };

const rows = (): Record<string, any[]> => ({
  payments: [{ id: "p1", amount: 1200, paid_at: "2026-08-12T18:00:00Z", processor_fee: null, stripe_payment_intent: null, method: "check", invoices: { status: "paid", invoice_number: "INV-9", customer_id: "c1", job_id: "j1", customers: { name: "Harbor View HOA" } } }],
  bills: [{ id: "b1", job_id: "j1", amount: 300, bill_date: "2026-08-14", created_at: "2026-08-14T18:00:00Z", category: "Receipt", status: "paid", po_id: null, superseded_by_bill_id: null, supplier: "Valley Wire Co", bill_number: "VW-1" }],
  profile_pay: [{ id: "u-owner", full_name: "Robin Test", hourly_rate: 0, bill_rate: 100, commute_baseline_miles: null, paid_by_draw: true }],
  jobs: [{ id: "j1", job_number: "J-9", name: "Harbor View Lights" }],
  invoices: [],
  tax_rates: [],
});

/** A PostgREST-builder fake: every filter method returns the builder, a page past the first is
 *  empty, maybeSingle answers the org and the viewer, and a table in `failing` answers an error. */
function client() {
  const table = (name: string) => {
    state.reads.push(name);
    let from = 0;
    const b: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (ok: any, err: any) => {
              if (state.failing.includes(name)) return Promise.resolve({ data: null, error: { message: "boom" } }).then(ok, err);
              return Promise.resolve({ data: from > 0 ? [] : (rows()[name] ?? []), error: null }).then(ok, err);
            };
          }
          if (prop === "maybeSingle") {
            return () => {
              if (name === "organizations") {
                return Promise.resolve({
                  data: { name: "Harbor Électrique", settings: { timezone: "America/Denver", office_sees_owner_money: state.officeSees, features: { sales_tax: state.salesTax } } },
                  error: null,
                });
              }
              if (name === "profiles") return Promise.resolve({ data: { role: state.role }, error: null });
              return Promise.resolve({ data: null, error: null });
            };
          }
          if (prop === "insert" || prop === "update" || prop === "delete" || prop === "upsert") {
            return () => {
              state.inserts.push(name);
              return b;
            };
          }
          if (prop === "range") {
            return (f: number) => {
              from = f;
              return b;
            };
          }
          return () => b;
        },
      },
    );
    return b;
  };
  return { from: table };
}

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => (state.staff ? { supabase: client(), userId: "u-viewer", orgId: "org-1" } : { error: "This action is staff-only." })),
}));

import { GET } from "./route";

const req = (qs: string) => new NextRequest(`https://app.example.test/analytics/accountant/export?${qs}`);

describe("GET /analytics/accountant/export", () => {
  // The company's clock reads Sep 27, 2026: Q3 has started, Q4 hasn't.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T18:00:00Z"));
    state.staff = true;
    state.role = "owner";
    state.officeSees = true;
    state.salesTax = false;
    state.failing = [];
    state.reads = [];
    state.inserts = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses anyone who isn't office staff, in words, before a single row is read", async () => {
    state.staff = false;
    const res = await GET(req("period=2026-Q3"));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("This action is staff-only.");
    expect(state.reads).toEqual([]);
  });

  it("refuses a period that isn't one, or hasn't started, in words", async () => {
    for (const p of ["2026-Q4", "2027", "2026-13", "last-week", ""]) {
      const res = await GET(req(`period=${p}`));
      expect(res.status, p).toBe(400);
      expect(await res.text()).toBe("Pick a month, a quarter or a year that has already started.");
    }
    const res = await GET(req("period=2026-Q3&as=pdf"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Ask for the spreadsheet or the CSV files.");
  });

  it("hands the office the workbook, named after the company and the period, and records nothing", async () => {
    const res = await GET(req("period=2026-Q3"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Harbor Electrique 2026 Q3.xlsx"; filename*=UTF-8''Harbor%20%C3%89lectrique%202026%20Q3.xlsx`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const parts = new Map(unzip(new Uint8Array(await res.arrayBuffer())).map((e) => [e.name, text(e.data)]));
    const names = [...parts.get("xl/workbook.xml")!.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
    expect(names).toEqual(["Summary", "Income", "Costs", "People", "Open", "Stock"]);
    // The Summary is a profit and loss, its bottom line named exactly (XML-escaped in the sheet).
    const sheet1 = parts.get("xl/worksheets/sheet1.xml")!;
    for (const line of ["Revenue", "Cost of Goods Sold (COGS)", "Total COGS", "Gross Profit", "Overhead", "Total Overhead", "Net Profit"]) {
      expect(sheet1, line).toContain(`<t xml:space="preserve">${line}</t>`);
    }
    expect(state.reads).not.toContain("accountant_exports");
    expect(state.inserts).toEqual([]);
    // Sales Tax is switched off: its rows are never asked for.
    expect(state.reads).not.toContain("tax_rates");
  });

  it("the same six tabs as CSV files, in a zip", async () => {
    const res = await GET(req("period=2026-08&as=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="Harbor Electrique 2026-08 CSV.zip"');
    const files = unzip(new Uint8Array(await res.arrayBuffer()));
    expect(files.map((f) => f.name)).toEqual(["Summary.csv", "Income.csv", "Costs.csv", "People.csv", "Open.csv", "Stock.csv"]);
    expect(text(files[1].data)).toContain("Harbor View HOA,INV-9,J-9,Harbor View Lights,Check,1200");
  });

  it("an office viewer the owner hasn't shared Owner's Draw with gets no Net in the file", async () => {
    state.role = "office";
    state.officeSees = false;
    const res = await GET(req("period=2026-Q3&as=csv"));
    expect(res.status).toBe(200);
    const files = unzip(new Uint8Array(await res.arrayBuffer()));
    const all = files.map((f) => text(f.data)).join("\n");
    expect(all).not.toContain("Net Profit");
    expect(all).not.toContain("Gross Profit");
    expect(all).not.toContain("Robin Test");
    // No bottom-line figure at all on the Summary: Net Profit is never one subtraction away.
    const summary = text(files.find((f) => f.name === "Summary.csv")!.data);
    expect(summary.split("\r\n").filter((l) => /^(Revenue|Received|Total|Gross|Other Income)/.test(l))).toEqual([]);
    // The cost rows stay, under their two headings.
    expect(summary).toContain("\r\nCost of Goods Sold (COGS)\r\nMaterials & Bills,");
    expect(summary).toContain("\r\nOverhead\r\nFuel,"); // Fuel leads Overhead (2026-09-30)
    expect(summary).toContain("The totals are the owner's.");
    // The owner may: the same file with the switch off, downloaded by the owner, has it.
    state.role = "owner";
    const own = unzip(new Uint8Array(await (await GET(req("period=2026-Q3&as=csv"))).arrayBuffer()))
      .map((f) => text(f.data))
      .join("\n");
    expect(own).toContain("Net Profit,");
    expect(own).toContain("\r\nGross Profit,");
  });

  it("a read that doesn't come back whole refuses the file in words, never a file with a zero in it", async () => {
    for (const [table, words] of [
      ["petty_cash", "The money couldn't be read just now: the petty cash could not be read. Nothing was made; try again."],
      ["jobs", "The books couldn't be read just now. Nothing was made; try again."],
      ["invoices", "What customers owe couldn't be read just now. Nothing was made; try again."],
    ] as const) {
      state.failing = [table];
      const res = await GET(req("period=2026-Q3"));
      expect(res.status, table).toBe(503);
      expect(await res.text()).toBe(words);
    }
    state.failing = ["tax_rates"];
    state.salesTax = true;
    const res = await GET(req("period=2026-Q3"));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Sales tax couldn't be read just now. Nothing was made; try again.");
  });
});
