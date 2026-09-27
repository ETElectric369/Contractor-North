import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * PURCHASE ORDERS ON THE BILLS PAGE AND THE SWITCH BOARD (0352). /purchasing is /bills?tab=po, so
 * the PO list is this tab. Off: its chip goes and New PO goes, and a ?tab=po link still opens the
 * list under the Off line, every PO still there. On (or no switches passed): exactly as before.
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
const render = (switches?: { features: typeof ALL_ON; isOwner: boolean }) =>
  renderToStaticMarkup(
    createElement(BillsReceipts, { orgId: "o1", jobs: [], lists: [], pos: [PO] as never, bills: [], docs: [], ...(switches ? { switches } : {}) }),
  );

describe("the Purchase Orders tab", () => {
  it("everything on (or nothing passed): the chip, New PO, the list", () => {
    search = "tab=po";
    for (const html of [render(), render({ features: ALL_ON, isOwner: true })]) {
      expect(html).toMatch(/border-b-2[^>]*>Purchase Orders/);
      expect(html).toContain(">New PO<");
      expect(html).toContain("PO-007");
      expect(html).not.toContain(" · Off");
    }
  });

  it("off: no chip and no New PO; ?tab=po still opens every PO, under the Off line", () => {
    search = "tab=po";
    const html = render({ features: { ...ALL_ON, purchase_orders: false }, isOwner: false });
    expect(html).not.toMatch(/border-b-2[^>]*>Purchase Orders/);
    expect(html).not.toContain(">New PO<");
    expect(html).toContain("PO-007");
    expect(html).toContain("Purchase Orders</span> · Off · Ask The Owner");
  });
});
