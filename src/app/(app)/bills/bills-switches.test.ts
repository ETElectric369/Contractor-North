import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PURCHASE ORDERS AND SHOP STOCK ON /bills (the switch board, 0352).
 *
 *  - No switches stored (or on): the ledger renders exactly as before.
 *  - Purchase Orders off: New PO goes (the list's ⋯ with it), and every PO is still a row of the one
 *    list (W1-32), under the Off line (the owner gets Turn On; anyone else Ask The Owner). Open POs
 *    keep counting in job cost: nothing on this page computes that, and nothing here skips the
 *    purchase_orders read.
 *  - Shop Stock off: a receipt line isn't offered to the shelf, the supplier cards don't offer it,
 *    and Record To Shelf gets neither half; a roll already on the shelf keeps its line.
 */
let tab: string | null = null;
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(tab ? { tab } : {}),
  usePathname: () => "/bills",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  ModalActions: () => null,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("../jobs/actions", () => ({ createBill: vi.fn(), addDocument: vi.fn(), deleteDocument: vi.fn() }));
vi.mock("@/app/(app)/settings/features-actions", () => ({ setFeature: vi.fn() }));
vi.mock("./receipt-billing-actions", () => ({ putRestOnShelf: vi.fn(), setReceiptLineBillable: vi.fn(), setReceiptLineUsage: vi.fn(), takeRollOffShelf: vi.fn() }));
vi.mock("../purchasing/new-po-button", () => ({ NewPoButton: () => createElement("button", { "data-new-po": "" }, "New PO") }));
vi.mock("@/components/bill-row-doors", () => ({ BillRowDoors: () => null }));
vi.mock("@/components/camera-capture", () => ({ CameraCapture: () => null }));

const { BillsReceipts } = await import("./bills-receipts");
const { ReceiptLines } = await import("./receipt-billing-card");
const { ALL_ON } = await import("@/lib/features");

const POS = [{ id: "po1", po_number: "PO-003", vendor: "A Supplier", status: "ordered", total: 3274, jobs: { name: "A Job" } }];
// The ledger takes the switches as one `switches` prop ({ features, isOwner }); left out = all on.
const ledger = (p: { features?: Record<string, boolean>; isOwner?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(BillsReceipts as any, {
      orgId: "org-1", jobs: [], lists: [], pos: POS, bills: [], docs: [],
      ...(p.features || p.isOwner !== undefined ? { switches: { features: p.features ?? ALL_ON, isOwner: p.isOwner ?? false } } : {}),
    }),
  );

describe("the ledger's purchase orders (one list, W1-32)", () => {
  it("no switches stored / on: the same list, the order listed with its PO chip, New PO on the list's ⋯", () => {
    tab = null;
    expect(ledger({ features: ALL_ON, isOwner: true })).toBe(ledger());
    expect(ledger()).toContain("PO-003");
    expect(ledger()).toMatch(/>PO<\/span>/);
    tab = "po";
    expect(ledger({ features: ALL_ON, isOwner: true })).toBe(ledger());
    expect(ledger()).toContain("data-new-po");
    expect(ledger()).toMatch(/aria-label="More For All Bills"/);
    expect(ledger()).not.toContain("Ask The Owner");
    // No tab strip any more: the orders are rows of the one list.
    expect(ledger()).not.toMatch(/<button[^>]*>Purchase Orders/);
  });

  it("off: no New PO and no list ⋯, and the order is still listed (it counts in job cost)", () => {
    tab = null;
    const off = ledger({ features: { ...ALL_ON, purchase_orders: false } });
    expect(off).not.toContain("data-new-po");
    expect(off).not.toContain("More For All Bills");
    expect(off).toContain("PO-003");
    expect(off).toContain('href="/purchasing/po1"');
  });

  it("off, opened by ?tab=po: the Off line on top and every PO still listed", () => {
    tab = "po";
    const owner = ledger({ features: { ...ALL_ON, purchase_orders: false }, isOwner: true });
    expect(owner).toContain("Purchase Orders</span> · Off");
    expect(owner).toContain(">Turn On<");
    expect(owner).toContain('href="/purchasing/po1"');
    expect(owner).toContain("PO-003");
    // A tech or the office: told who can turn it on, and no button.
    const staff = ledger({ features: { ...ALL_ON, purchase_orders: false }, isOwner: false });
    expect(staff).toContain("Ask The Owner");
    expect(staff).not.toContain(">Turn On<");
  });
});

describe("a receipt line and the shelf", () => {
  const receipt = {
    id: "b1",
    job_id: "j1",
    supplier: "A Supplier",
    lines: [{ id: "l1", description: "12/2 NM-B 250'", quantity: 1, unit: "ea", unit_price: 158.55, amount: 158.55, category: null, billable: true, billable_amount: 158.55 }],
  } as any;
  it("on / not passed: today's line, Put The Rest On The Shelf offered", () => {
    const today = renderToStaticMarkup(createElement(ReceiptLines, { receipt }));
    expect(renderToStaticMarkup(createElement(ReceiptLines, { receipt, shopStock: true }))).toBe(today);
    expect(today).toContain("Put The Rest In Stock");
  });
  it("off: not offered", () => {
    expect(renderToStaticMarkup(createElement(ReceiptLines, { receipt, shopStock: false }))).not.toContain("Put The Rest In Stock");
  });
});

describe("the page wires the switches (the parts too big to draw here)", () => {
  const PAGE = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
  it("Record To Shelf gets both halves only while Shop Stock is on", () => {
    expect(PAGE).toContain("...(shopStock ? { shelfLines: supplierInvoiceShelfLines, recordToShelf: recordSupplierInvoiceToShelf } : {})");
  });
  it("the supplier cards, Needs You's paper cards and Add By Hand are told the switch", () => {
    expect(PAGE).toMatch(/supplierPaperFeed\(\{[\s\S]*?shopStock,\s*\}\)/);
    expect(PAGE).toMatch(/<NeedsYou\s+items=\{paperItems\}\s+jobs=\{paperJobs\}\s+matches=\{paperMatches\}\s+shopStock=\{shopStock\}/);
    expect(PAGE).toContain("<AddByHandButton jobs={handJobs} shopStock={shopStock} jobsUnread={!!jobsErr} />");
  });
  it("the purchase orders are still read whatever the switch (they count in job cost)", () => {
    expect(PAGE).toContain('.from("purchase_orders")');
    expect(PAGE).not.toMatch(/purchase_orders"[^\n]*features/);
  });
});
