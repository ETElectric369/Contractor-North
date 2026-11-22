import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE JOB'S COSTS LIST SAYS WHAT THE PEN SAID (cn-v1181, lane K, K3): a bill with lines that went
 * back says how many and the dollars, credit expected or received; one with open questions says how
 * many need an answer. Plain words, never amber.
 */
vi.mock("@/app/(app)/jobs/actions", () => ({ deleteBill: vi.fn(), setBillStatus: vi.fn(), createBill: vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));

const { JobBills, billPenNote } = await import("./job-bills");

const line = (o: Record<string, unknown>) => ({ description: "20A breaker", amount: 10, billable: true, category: "Electrical", ...o });

describe("billPenNote", () => {
  it("nothing marked: nothing said", () => {
    expect(billPenNote([line({}), line({ billable: false })])).toBeNull();
    expect(billPenNote(null)).toBeNull();
  });
  it("returned lines, how many and their dollars, credit expected and credit received apart", () => {
    expect(
      billPenNote([
        line({ amount: 40, pen_mark: "struck", returned: true, billable: false }),
        line({ amount: 12.5, pen_mark: "quantity", returned: true, billable: false }),
        line({ amount: 7, pen_mark: "struck", returned: true, billable: false, returned_credit_bill_id: "credit-1" }),
      ]),
    ).toBe("2 lines returned, $52.50: credit expected · 1 line returned, $7.00: credit received.");
  });
  it("open questions", () => {
    expect(billPenNote([line({ pen_mark: "unclear", billable: false }), line({ pen_mark: "unclear", billable: false })])).toBe(
      "2 pen marks need an answer: Kept or Returned.",
    );
    expect(billPenNote([line({ pen_mark: "unclear", billable: false })])).toBe("1 pen mark needs an answer: Kept or Returned.");
  });
  it("crossed out on a receipt paid at purchase is not a return (no credit is tracked)", () => {
    expect(billPenNote([line({ pen_mark: "struck", returned: false, billable: false })])).toBeNull();
  });
});

describe("the row says it", () => {
  const bills = [
    {
      id: "b1",
      supplier: "Northline Supply",
      bill_number: "INV-900",
      amount: 120,
      status: "unpaid",
      bill_date: "2026-11-20",
      bill_line_items: [line({ amount: 40, pen_mark: "struck", returned: true, billable: false }), line({ pen_mark: "unclear", billable: false })],
    },
    { id: "b2", supplier: "Northline Supply", bill_number: null, amount: 16, status: "paid", bill_date: "2026-11-21", bill_line_items: [line({})] },
  ];
  const html = renderToStaticMarkup(createElement(JobBills, { jobId: "j-larkspur", bills: bills as any, pos: [] }));
  it("on the marked bill, plain slate", () => {
    expect(html).toContain('<div class="text-xs text-slate-600">1 line returned, $40.00: credit expected · 1 pen mark needs an answer: Kept or Returned.</div>');
  });
  it("once only, and nothing on the ordinary bill", () => {
    expect(html.match(/line returned/g)).toHaveLength(1);
  });
});
