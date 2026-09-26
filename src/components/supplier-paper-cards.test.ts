import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/app/(app)/bills/supplier-actions", () => ({
  fileSupplierPaper: vi.fn(),
  undoFileSupplierPaper: vi.fn(),
  tieSupplierInvoiceToBill: vi.fn(),
  supplierInvoiceShelfLines: vi.fn(),
  recordSupplierInvoiceToShelf: vi.fn(),
}));

import { SupplierPaperCards } from "./supplier-paper-cards";
import type { SupplierPaperCard } from "@/app/(app)/bills/supplier-reconcile";

/**
 * THE CARD, AS ERIK READS IT (Bills plan, Wave A). What these pin is the law, not the styling:
 * the headline in his words, the suggestion as the first button and never a selected option, the
 * Rhodesia chips with none first, Pick A Job when there is nothing to go on, and Title Case on
 * every clickable.
 */

const J011 = { id: "j-011", label: "J-011", name: "13897 Herringbone", status: "in progress" };
const base: SupplierPaperCard = {
  invoiceId: "si-1",
  invoiceNumber: "8802-1106969",
  supplier: "CED",
  date: "2026-09-04",
  total: 301.81,
  closed: false,
  said: "13897 HERRINGBONE",
  state: "needs_job",
  verdict: "one",
  suggestion: J011,
  candidates: [],
  onJob: null,
  because: '"13897 HERRINGBONE" looks like 13897 Herringbone. Check it before you file it.',
  samePurchase: [],
};
const render = (cards: SupplierPaperCard[]) =>
  renderToStaticMarkup(createElement(SupplierPaperCards, { feed: { cards, jobs: [J011] }, emptyLabel: "Nothing waiting." }));
const buttons = (html: string) => Array.from(html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)).map((m) => m[1]);

describe("a supplier paper card", () => {
  it("says it the way he asked: CED Sent A Bill · $301.81 · It Says 13897 HERRINGBONE", () => {
    const html = render([base]);
    expect(html).toContain("CED Sent A Bill · $301.81 · It Says 13897 HERRINGBONE");
    expect(buttons(html)).toEqual(["Put It On J-011", "Another Job", "Shop Stock", "Business Cost"]);
    // Suggested, never preselected: no picker is open and nothing anywhere is selected.
    expect(html).not.toContain("selected");
  });

  it("asks with chips when several jobs match, and none of them is first", () => {
    const chips = [
      { id: "j-033", label: "J-033", name: "5659 Rhodesia", status: "complete" },
      { id: "j-014", label: "J-014", name: "5659 Rhodesia", status: "to be scheduled" },
    ];
    const html = render([{ ...base, said: "5659 RHODESIA", verdict: "ask", suggestion: null, candidates: chips }]);
    expect(buttons(html)).toEqual(["J-033 · Complete", "J-014 · To Be Scheduled", "Another Job", "Shop Stock", "Business Cost"]);
    expect(html).toContain("Only you know which");
  });

  it("says Pick A Job when there is nothing to go on", () => {
    const html = render([{ ...base, said: null, verdict: "blank", suggestion: null }]);
    expect(html).toContain("CED Sent A Bill · $301.81 · No Job Name On It");
    expect(buttons(html)).toEqual(["Pick A Job", "Shop Stock", "Business Cost"]);
  });

  it("a paper already on a job asks only for the record", () => {
    const html = render([{ ...base, state: "record", suggestion: null, onJob: { id: "j-050", label: "J-050", name: "3639 Saddle Road", status: "complete" } }]);
    expect(buttons(html)[0]).toBe("Record It On J-050");
  });

  it("offers the tie when a bill may already be this purchase, and says what the other buttons mean", () => {
    const html = render([{ ...base, samePurchase: [{ billId: "b1", exact: false, sentence: "Maybe already on the books: a ticket." }] }]);
    expect(buttons(html)[0]).toBe("Same Purchase: Tie Them");
    expect(html).toContain("Any other button below records it as a different purchase.");
  });

  it("nothing waiting says so", () => {
    expect(render([])).toContain("Nothing waiting.");
  });
});
