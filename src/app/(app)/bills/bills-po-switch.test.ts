import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * PURCHASE ORDERS ON THE BILLS PAGE AND THE SWITCH BOARD (0352). All Bills is one list (W1-32): every
 * order is a row with a PO chip, whatever the switch (an open PO counts in job cost). /purchasing is
 * /bills?tab=po, which opens the list with the orders first. Off: New PO goes (the list's ⋯ with it),
 * and the orders are listed under the Off line. On (or no switches passed): the same list.
 */
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/bills",
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/app/(app)/jobs/actions", () => ({ createBill: vi.fn(), addDocument: vi.fn(), deleteDocument: vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("@/app/(app)/purchasing/new-po-button", () => ({ NewPoButton: () => createElement("button", null, "New PO") }));
vi.mock("@/app/(app)/settings/features-actions", () => ({ setFeature: vi.fn() }));
vi.mock("@/components/bill-row-doors", () => ({ BillRowDoors: () => null }));
vi.mock("./receipt-billing-card", () => ({ ReceiptLines: () => null }));

import { BillsReceipts } from "./bills-receipts";
import { ALL_ON } from "@/lib/features";

const PO = { id: "po1", po_number: "PO-007", vendor: "Any Supply", status: "open", total: 412.5, jobs: { name: "Deck" } };
const BILL = { id: "b1", supplier: "Any Supply", bill_number: null, amount: 40, status: "unpaid", bill_date: "2026-09-10", job_id: null, category: "Fuel" };
const render = (switches?: { features: typeof ALL_ON; isOwner: boolean }, bills: unknown[] = []) =>
  renderToStaticMarkup(
    createElement(BillsReceipts, { orgId: "o1", jobs: [], lists: [], pos: [PO] as never, bills: bills as never, docs: [], ...(switches ? { switches } : {}) }),
  );

describe("purchase orders in the one list", () => {
  it("everything on (or nothing passed): the order's row with its PO chip, New PO on the list's ⋯", () => {
    search = "tab=po";
    for (const html of [render(), render({ features: ALL_ON, isOwner: true })]) {
      expect(html).not.toMatch(/border-b-2[^>]*>Purchase Orders/);
      expect(html).toContain(">New PO<");
      expect(html).toMatch(/<a[^>]*href="\/purchasing\/po1"[^>]*>[\s\S]*?>PO<\/span>[\s\S]*?PO-007/);
      expect(html).not.toContain(" · Off");
    }
  });

  it("?tab=po (from /purchasing): the list opens with the orders first", () => {
    search = "tab=po";
    const html = render(undefined, [BILL]);
    expect(html).toMatch(/<details id="all-bills"[^>]*open=""/);
    expect(html.indexOf("PO-007")).toBeLessThan(html.indexOf('id="bill-b1"'));
    search = "";
    const plain = render(undefined, [BILL]);
    expect(plain).not.toMatch(/<details id="all-bills"[^>]*open=""/);
    expect(plain.indexOf('id="bill-b1"')).toBeLessThan(plain.indexOf("PO-007"));
  });

  it("off: no New PO; ?tab=po still shows every PO, under the Off line", () => {
    search = "tab=po";
    const html = render({ features: { ...ALL_ON, purchase_orders: false }, isOwner: false });
    expect(html).not.toContain(">New PO<");
    expect(html).toContain("PO-007");
    expect(html).toContain("Purchase Orders</span> · Off · Ask The Owner");
  });
});
