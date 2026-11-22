import { describe, it, expect, vi } from "vitest";

vi.mock("../actions", () => ({ setInvoiceItemKind: vi.fn() }));
import { lineLockedByApp } from "./line-kind-chips";

/**
 * THE INVOICE PAGE SHOWS AN APP-KEPT LINE LOCKED (cn-v1177): no Edit, no Remove, no Kind chips on a
 * credit line (a draw's "Less previous billings" or a payment request taken off), a milestone line, or
 * a payment request's own line, because the server refuses every hand write to them.
 */
describe("lineLockedByApp", () => {
  it("credit lines of both pools, a milestone, and a request's own line are locked", () => {
    expect(lineLockedByApp({ import_source: "draw_credit" }, "progress")).toBe(true);
    expect(lineLockedByApp({ import_source: "prepaid_credit" }, "standard")).toBe(true);
    expect(lineLockedByApp({ import_source: "milestone" }, "progress")).toBe(true);
    expect(lineLockedByApp({ import_source: "prepayment" }, "prepayment")).toBe(true);
    // Any line on a request is the request's: locked whatever it says.
    expect(lineLockedByApp({ import_source: null }, "prepayment")).toBe(true);
  });
  it("work lines and typed lines on an ordinary bill stay the office's to edit", () => {
    expect(lineLockedByApp({ import_source: "labor" }, "standard")).toBe(false);
    expect(lineLockedByApp({ import_source: "costs" }, "standard")).toBe(false);
    expect(lineLockedByApp({ import_source: null }, "standard")).toBe(false);
    expect(lineLockedByApp({ import_source: null }, null)).toBe(false);
  });
});
