import { describe, expect, it } from "vitest";
import { computeOwnerMoney, getOwnerMoney, ownerMoneyWindow, type OwnerMoneyInputs } from "./owner-money";
import { pnlRow, profitAndLoss } from "./profit-and-loss";

/**
 * OTHER INCOME (0363): a deposit a person placed as Other Income on a bank download is money
 * received, in the month the bank posted it, said as its own chip, and the Owner's Draw subtraction
 * still holds to the cent. Made-up figures.
 */

const TZ = "America/Los_Angeles";
const TODAY = "2026-09-27";

const inputs = (over: Partial<OwnerMoneyInputs> = {}): OwnerMoneyInputs => ({
  payments: [{ id: "p1", amount: 1000, paid_at: "2026-09-04T19:00:00Z", processor_fee: null, stripe_payment_intent: null, invoices: { status: "paid" } }],
  refunds: [],
  bills: [{ id: "b1", job_id: null, amount: 100, bill_date: "2026-09-10", category: "Fuel", status: "paid", superseded_by_bill_id: null }],
  pos: [],
  pettyCash: [],
  entries: [],
  runs: [],
  payPayments: [],
  creditMemos: [],
  supplierAliases: [],
  people: new Map(),
  recordsStart: "2026-06-01",
  ...over,
});

describe("Other Income in Received", () => {
  it("adds to Received in its own month, is said on its own, and the draw still adds up", () => {
    const m = computeOwnerMoney(
      inputs({ otherIncome: [{ amount: 250.5, posted_on: "2026-09-20" }, { amount: 99, posted_on: "2026-08-02" }] }),
      ownerMoneyWindow("this_month", TODAY),
      TZ,
      TODAY,
    );
    expect(m.totals.received).toBe(1250.5);
    expect(m.totals.otherIncome).toBe(250.5);
    expect(m.totals.left).toBe(1150.5);
    const year = computeOwnerMoney(inputs({ otherIncome: [{ amount: 250.5, posted_on: "2026-09-20" }, { amount: 99, posted_on: "2026-08-02" }] }), ownerMoneyWindow("this_year", TODAY), TZ, TODAY);
    expect(year.months.find((x) => x.month === "2026-08")!.otherIncome).toBe(99);
    expect(year.totals.received).toBe(1349.5);
  });

  it("on the profit and loss it is inside Revenue, said on its own line, and moves no cost: Net Profit (Owner's Draw) is still the engine's net", () => {
    const m = computeOwnerMoney(inputs({ otherIncome: [{ amount: 250.5, posted_on: "2026-09-20" }] }), ownerMoneyWindow("this_month", TODAY), TZ, TODAY);
    const rows = profitAndLoss(m.totals, { otherIncome: true, margin: true });
    const at = (k: Parameters<typeof pnlRow>[1]) => pnlRow(rows, k)!;
    expect(at("revenue").amount).toBe(1250.5);
    expect(at("other_income")).toMatchObject({ label: "Other Income (Inside Revenue)", amount: 250.5, kind: "part" });
    // Fuel is Overhead (2026-09-30), so no cost sits in COGS: all of Revenue is Gross Profit, and
    // the 100 comes off below it.
    expect(at("total_cogs").amount).toBe(0);
    expect(at("gross_profit").amount).toBe(1250.5);
    expect(at("total_overhead").amount).toBe(100);
    expect(at("net_profit").amount).toBe(m.totals.left);
    expect(at("net_profit").amount).toBe(1150.5);
  });

  it("none: the figure is absent, and Received is the payments alone", () => {
    const m = computeOwnerMoney(inputs(), ownerMoneyWindow("this_month", TODAY), TZ, TODAY);
    expect(m.totals.otherIncome).toBeUndefined();
    expect(m.totals.received).toBe(1000);
  });

  it("a database before 0363 (no bank_lines) is none, never a lost read", async () => {
    const client = {
      from(table: string) {
        const b: any = {};
        for (const k of ["select", "eq", "is", "gte", "lt", "in", "order", "range", "limit"]) b[k] = () => b;
        b.then = (ok: any, err: any) =>
          Promise.resolve(
            table === "bank_lines" ? { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.bank_lines' in the schema cache" } } : { data: [], error: null },
          ).then(ok, err);
        return b;
      },
    };
    const out = await getOwnerMoney(client, "this_month", TZ, new Date("2026-09-27T19:00:00Z"));
    expect(out.problem).toBeNull();
    expect(out.money!.totals.received).toBe(0);
  });
});
