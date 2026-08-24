import { describe, it, expect } from "vitest";
import {
  billableChangeOrders,
  changeOrderDescription,
  changeOrderLines,
  noChangeOrdersReason,
  type ChangeOrderRow,
} from "./change-order-billing";

const co = (over: Partial<ChangeOrderRow> = {}): ChangeOrderRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  co_number: "CO-003",
  description: "Add two exterior receptacles",
  amount: 1800,
  status: "approved",
  ...over,
});

describe("billableChangeOrders — approved money only", () => {
  it("bills an approved change order", () => {
    expect(billableChangeOrders([co()])).toHaveLength(1);
  });

  it("NEVER bills a pending one — that is a proposal, not an agreement", () => {
    expect(billableChangeOrders([co({ status: "pending" })])).toEqual([]);
  });

  it("never bills a rejected one — that is a decision", () => {
    expect(billableChangeOrders([co({ status: "rejected" })])).toEqual([]);
  });

  it("drops a $0 change order — a zero line is noise on a document", () => {
    expect(billableChangeOrders([co({ amount: 0 }), co({ amount: null })])).toEqual([]);
  });

  it("A CREDIT IS A REAL CHANGE ORDER and must reach the invoice", () => {
    // Deleting scope is as ordinary as adding it. If a −$900 change order can't be billed, the
    // customer is overcharged by exactly the amount they negotiated away.
    const out = billableChangeOrders([co({ amount: -900 })]);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(-900);
  });
});

describe("changeOrderDescription — the line explains itself", () => {
  it("names the document the customer signed", () => {
    expect(changeOrderDescription(co())).toBe("Change order CO-003 — Add two exterior receptacles");
  });

  it("survives a missing number without printing 'undefined' at a customer", () => {
    expect(changeOrderDescription(co({ co_number: null }))).toBe("Change order — Add two exterior receptacles");
  });

  it("survives a missing description without a dangling dash", () => {
    expect(changeOrderDescription(co({ description: null }))).toBe("Change order CO-003");
    expect(changeOrderDescription(co({ description: "   " }))).toBe("Change order CO-003");
  });
});

describe("changeOrderLines — one line per change order, stably keyed", () => {
  it("keys by id so a re-import UPDATES rather than appending a duplicate", () => {
    const [line] = changeOrderLines([co()]);
    expect(line.import_key).toBe("co:11111111-1111-1111-1111-111111111111");
    expect(line).toMatchObject({ quantity: 1, unit: "ea", unit_price: 1800 });
  });

  it("the key survives an amount revision — same line, new price", () => {
    const a = changeOrderLines([co({ amount: 1800 })])[0];
    const b = changeOrderLines([co({ amount: 2400 })])[0];
    expect(a.import_key).toBe(b.import_key);
    expect(b.unit_price).toBe(2400);
  });

  it("a change order approved later appends without touching the others", () => {
    const first = co({ id: "a", co_number: "CO-001" });
    const later = co({ id: "b", co_number: "CO-002", amount: 450 });
    const keys = changeOrderLines([first, later]).map((l) => l.import_key);
    expect(keys).toEqual(["co:a", "co:b"]);
  });

  it("mixed statuses: only the approved ones become lines", () => {
    const lines = changeOrderLines([
      co({ id: "a", status: "approved", amount: 100 }),
      co({ id: "b", status: "pending", amount: 999 }),
      co({ id: "c", status: "rejected", amount: 999 }),
      co({ id: "d", status: "approved", amount: 0 }),
    ]);
    expect(lines.map((l) => l.import_key)).toEqual(["co:a"]);
  });
});

describe("noChangeOrdersReason — different problems get different sentences", () => {
  it("nothing at all", () => {
    expect(noChangeOrdersReason([])).toBe("No approved change orders on this job yet.");
  });

  it("some exist but none approved — sends them to the approve control, not the amount field", () => {
    expect(noChangeOrdersReason([co({ status: "pending" })])).toBe(
      "No change orders on this job have been approved yet.",
    );
  });

  it("approved but all zero — sends them to the amount field", () => {
    expect(noChangeOrdersReason([co({ amount: 0 })])).toBe(
      "The approved change orders on this job are all $0 — put an amount on them first.",
    );
  });
});
