import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE RUNNING TOTAL LEADS WITH ONE NUMBER (Erik, 2026-09-26: "the only thing i was looking for was
 * the amount open"). The card says "Open: $X", and $X is exactly what its button bills: on a T&M job
 * billed with draws the button is Create Progress Payment (the draw door, net of the deposit), on an
 * open draft it is Add to INV-0xx, on a plain T&M job Create Invoice. A tech sees hours, never money.
 */

vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("../actions", () => ({ createInvoiceForJob: vi.fn() }));
vi.mock("../../billing/actions", () => ({ createProgressReportInvoice: vi.fn() }));

import { UnbilledCard, type UnbilledView } from "./unbilled-card";

const WORK = {
  kind: "staff" as const,
  hours: 26,
  laborAmount: 3055,
  laborByPerson: [
    { name: "Erik Taylor", hours: 13, amount: 1950 },
    { name: "Brian", hours: 13, amount: 1105 },
  ],
  billsAmount: 114.32,
  excluded: 0,
  billsCount: 2,
  markupPct: 25,
  billsBilled: 142.9,
  returnsAmount: 0,
  returnsCount: 0,
  returnsCredit: 0,
  stockCount: 0,
  stockAmount: 0,
  stockBilled: 0,
  stockShorts: 0,
  stockShortsWords: null,
  total: 3197.9,
  lastInvoiceNumber: "INV-00028",
  lastInvoiceAt: "2026-07-01T00:00:00Z",
  lastInvoiceStatus: "paid",
} as unknown as UnbilledView;

const card = (props: Partial<Parameters<typeof UnbilledCard>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(UnbilledCard, { jobId: "j-002", customerId: "c-tao", view: WORK, viewerIsStaff: true, openDraft: null, ...props }),
  );

describe("UnbilledCard - Open: $X and the door that bills it", () => {
  it("Tao J-002 with new hours: Open is the figure, the door is Create Progress Payment", () => {
    const html = card({ drawBilled: true });
    expect(html).toContain("Open: $3,197.90");
    expect(html).toContain("Create Progress Payment for $3,197.90");
    expect(html).not.toContain("Create Invoice for");
  });

  it("a deposit not yet taken off a bill: Open is the net, and the note says why", () => {
    const html = card({ drawBilled: true, lumpToNet: 1000 });
    expect(html).toContain("Open: $2,197.90");
    expect(html).toContain("Create Progress Payment for $2,197.90");
    expect(html).toContain("less the $1,000.00 deposit not yet taken off a bill");
  });

  it("an open draft: Add to it, with the same figure", () => {
    const html = card({ drawBilled: true, openDraft: { id: "inv-078", number: "INV-078", refreshable: true } });
    expect(html).toContain("Open: $3,197.90");
    expect(html).toContain("Add to INV-078 ($3,197.90)");
  });

  it("a plain T&M job keeps Create Invoice", () => {
    expect(card()).toContain("Create Invoice for $3,197.90");
  });

  it("everything billed: Open: $0.00 and no button", () => {
    const html = card({
      drawBilled: true,
      view: { ...WORK, hours: 0, laborAmount: 0, laborByPerson: [], billsCount: 0, billsAmount: 0, billsBilled: 0, total: 0 } as UnbilledView,
    });
    expect(html).toContain("Open: $0.00");
    expect(html).not.toContain("<button");
  });

  it("a tech sees his hours, never the money", () => {
    const html = card({ viewerIsStaff: false, view: { kind: "tech", hours: 13, lastInvoiceNumber: "INV-00028", lastInvoiceAt: null } });
    expect(html).not.toContain("$");
    expect(html).not.toContain("Open:");
  });
});
