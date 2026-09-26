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

vi.mock("@/app/(app)/bills/paper-contents-action", () => ({ supplierPaperContents: vi.fn() }));
vi.mock("@/app/(app)/bills/waiting-credit-actions", () => ({ waitOnCredit: vi.fn(), stopWaitingOnCredit: vi.fn() }));

import {
  PaperContentsView,
  SupplierPaperCards,
  SupplierPaperDoneTrail,
  chipNames,
  setSupplierPaperScopeForTest,
} from "./supplier-paper-cards";
import { paperContents } from "@/lib/supplier-paper-contents";
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
const allButtons = (html: string) =>
  Array.from(html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)).map((m) => m[1].replace(/&#x27;/g, "'"));
/** The answers on a card: every button but What's On It and Waiting On A Credit (pinned on their own below). */
const buttons = (html: string) => allButtons(html).filter((b) => !["Open Bill", "Waiting On A Credit", "Wait 30 More Days"].includes(b));

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

describe("review of Wave A: the card at 60mph", () => {
  const rhodesias = [
    { id: "j-033", label: "J-033", name: "5659 Rhodesia", status: "complete", opened: "2026-07-12T18:00:00Z" },
    { id: "j-006", label: "J-006", name: "5659 Rhodesia", status: "complete", opened: "2026-06-11T18:00:00Z" },
    { id: "j-034", label: "J-034", name: "5659 Rhodesia - Panel Upgrade", status: "on hold" },
    { id: "j-047", label: "J-047", name: "Jackie Burks", status: "scheduled" },
  ];

  it("a chip names the job when its name is news, and says when it was opened", () => {
    const names = chipNames("5659 RHODESIA", rhodesias);
    expect(names.get("j-033")).toBeNull();
    expect(names.get("j-034")).toBe("Panel Upgrade");
    expect(names.get("j-047")).toBe("Jackie Burks");
    const html = render([{ ...base, said: "5659 RHODESIA", verdict: "ask", suggestion: null, candidates: rhodesias }]);
    const b = buttons(html);
    expect(b).toContain("J-033 · Complete · Opened Jul 12");
    expect(b).toContain("J-006 · Complete · Opened Jun 11");
    expect(b).toContain("J-034 · Panel Upgrade · On Hold");
    expect(b).toContain("J-047 · Jackie Burks · Scheduled");
  });

  it("a weak card only says 'The closest are first' when the picker has them first", () => {
    const because = 'Nothing on your job list looks much like "561 RHODESIA". The closest are first.';
    const none = render([{ ...base, said: "561 RHODESIA", verdict: "weak", suggestion: null, because }]);
    expect(none).not.toContain("The closest are first");
    const some = render([{ ...base, said: "561 RHODESIA", verdict: "weak", suggestion: null, because, closest: [rhodesias[0]] }]);
    expect(some).toContain("The closest are first");
    // Still never a button: Pick A Job opens the picker with them on top.
    expect(buttons(some)).toEqual(["Pick A Job", "Shop Stock", "Business Cost"]);
  });

  it("My Day draws one card and says how many more wait, with a way to all of them", () => {
    const cards = [base, { ...base, invoiceId: "si-2", invoiceNumber: "8802-2" }, { ...base, invoiceId: "si-3", invoiceNumber: "8802-3" }];
    const html = renderToStaticMarkup(
      createElement(SupplierPaperCards, { feed: { cards, jobs: [J011] }, limit: 1, moreHref: "/bills#needs-you" }),
    );
    expect(html.match(/Sent A Bill/g)?.length).toBe(1);
    expect(html).toContain("See 2 More Supplier Bills");
    expect(html).toContain('href="/bills#needs-you"');
  });

  it("the done line and its Undo outlive the list that held them (the last paper filed)", () => {
    const undo = { invoiceId: "si-1", billId: "bill-1", jobSetTo: "j-011", jobBefore: null };
    setSupplierPaperScopeForTest("t-last", { done: { "si-1": { card: base, message: "8802-1106969 is a bill on 13897 Herringbone now.", undo } }, live: 0 });
    // The rollup is gone (no card set mounted): the trail carries them.
    const trail = renderToStaticMarkup(createElement(SupplierPaperDoneTrail, { scope: "t-last" }));
    expect(trail).toContain("is a bill on 13897 Herringbone now.");
    expect(buttons(trail)).toEqual(["Undo"]);
    // While a card set of that scope is on screen, it shows them itself and the trail stays out.
    setSupplierPaperScopeForTest("t-last", { live: 1 });
    expect(renderToStaticMarkup(createElement(SupplierPaperDoneTrail, { scope: "t-last" }))).toBe("");
    const list = renderToStaticMarkup(createElement(SupplierPaperCards, { feed: { cards: [], jobs: [] }, scope: "t-last" }));
    expect(list).toContain("is a bill on 13897 Herringbone now.");
  });
});

describe("What's On It (Erik: 'i need to open the bill to see whats on it to be able to approve or deny')", () => {
  it("every card has it, before every answer, closed until he taps it", () => {
    const shapes: SupplierPaperCard[] = [
      base,
      { ...base, said: null, verdict: "blank", suggestion: null },
      { ...base, samePurchase: [{ billId: "b1", exact: false, sentence: "Maybe already on the books: a ticket." }] },
      { ...base, state: "record", suggestion: null, onJob: { id: "j-050", label: "J-050", name: "3639 Saddle Road", status: "complete" } },
    ];
    for (const card of shapes) {
      const html = render([card]);
      expect(allButtons(html)[0]).toBe("Open Bill");
      expect(html).toContain('aria-expanded="false"');
      // Nothing is read until he asks.
      expect(html).not.toContain("Opening The Bill");
    }
  });

  const hillside = paperContents({
    invoice: { invoice_number: "8802-1107139", tax: "4.89", shipping: "0.00", total: "59.17", source_file: "invoice_8802-1107139.pdf" },
    lines: [
      { description: "20A 120/277VAC SW", part_number: "PS20AC2RPL", quantity: "1.000", unit_price: "36.0000", extension: "36.00", sort_order: 0 },
      { description: "1/2 FILLER PLATE", part_number: "TFH", quantity: "4.000", unit_price: "4.5700", extension: "18.28", sort_order: 1 },
      { description: "TRACK LUMINAI", part_number: "H8010CSWT", quantity: "0", unit_price: "38.98", extension: "0.00", sort_order: 2 },
    ],
  });
  const view = (v: Parameters<typeof PaperContentsView>[0]["view"], cardTotal = 59.17) =>
    renderToStaticMarkup(createElement(PaperContentsView, { cardTotal, view: v, onRetry: () => {} }));

  it("draws the lines, Not Shipped, Tax and the card's own Total", () => {
    const html = view({ state: "ok", contents: hillside });
    expect(html).toContain("1 × 20A 120/277VAC SW (PS20AC2RPL)");
    expect(html).toContain("4 × 1/2 FILLER PLATE (TFH)");
    expect(html).toContain("$18.28");
    expect(html).toContain("TRACK LUMINAI (H8010CSWT)");
    expect(html).toContain("Not Shipped");
    expect(html).not.toContain("$38.98");
    expect(html.indexOf("Tax")).toBeLessThan(html.indexOf("Total"));
    expect(html).toContain("$4.89");
    expect(html).toContain("$59.17");
    expect(html).not.toContain("isn&#x27;t on any line");
    expect(html).not.toContain("changed since the page loaded");
    // No stored PDF: said, never a dead link.
    expect(html).not.toContain("Open The PDF");
    expect(html).toContain("only what was read from invoice_8802-1107139.pdf");
  });

  it("an Open The PDF link when one is stored, and a gap between lines and total is said", () => {
    const html = view({ state: "ok", contents: { ...hillside, lines: hillside.lines.slice(1), offLines: 36, pdfUrl: "https://signed.example/a.pdf", pdfNote: null } });
    expect(html).toContain('href="https://signed.example/a.pdf"');
    expect(html).toContain("Open The PDF");
    expect(html).toContain("$36.00 of the total isn&#x27;t on any line.");
  });

  it("a paper with no lines says so", () => {
    const html = view({ state: "ok", contents: { ...hillside, lines: [], offLines: 54.28 } });
    expect(html).toContain("No lines are on file for this one.");
    expect(html).toContain("$54.28 of the total isn&#x27;t on any line.");
  });

  it("loading says so; a failed read says so with Try Again", () => {
    expect(view({ state: "loading" })).toContain("Opening The Bill");
    const failed = view({ state: "error", error: "The connection dropped before the lines came back." });
    expect(failed).toContain("It couldn&#x27;t read what&#x27;s on this paper.");
    expect(failed).toContain('role="alert"');
    expect(allButtons(failed)).toEqual(["Try Again"]);
  });

  it("a total that no longer matches the card says the page is stale", () => {
    expect(view({ state: "ok", contents: hillside }, 61.0)).toContain("This paper changed since the page loaded.");
  });
});

describe("Waiting On A Credit (Erik, 2026-09-26: the Hillside switch CED will credit back)", () => {
  it("every card on a supplier account offers it after Open Bill and before the answers, Title Case", () => {
    const html = render([{ ...base, accountId: "acct-ced" }]);
    expect(allButtons(html).slice(0, 3)).toEqual(["Open Bill", "Waiting On A Credit", "Put It On J-011"]);
    expect(html).not.toContain("Still no credit");
  });

  it("a card on no supplier account has no Wait door (a credit pairs on its account, and the fold lives there)", () => {
    const html = render([{ ...base, accountId: null }]);
    expect(allButtons(html)).not.toContain("Waiting On A Credit");
    expect(allButtons(html).slice(0, 2)).toEqual(["Open Bill", "Put It On J-011"]);
  });

  it("a card that came back by itself says so, and offers another 30 days", () => {
    const back: SupplierPaperCard = {
      ...base,
      accountId: "acct-ced",
      waitingCredit: { since: "2026-08-20", back: "2026-09-19", overdue: true },
      stillNoCredit: "Still no credit from CED after 30 days",
    };
    const html = render([back]);
    expect(html).toContain("Still no credit from CED after 30 days.");
    expect(allButtons(html).slice(0, 2)).toEqual(["Open Bill", "Wait 30 More Days"]);
    // The answers are all still there.
    expect(buttons(html)).toEqual(["Put It On J-011", "Another Job", "Shop Stock", "Business Cost"]);
  });

  it("its done line carries Undo, and outlives the list like any other", () => {
    setSupplierPaperScopeForTest("t-wait", {
      done: { "si-1": { card: base, message: "8802-1106969 is waiting on a credit.", undoWait: { since: null, by: null } } as never },
      live: 0,
    });
    const trail = renderToStaticMarkup(createElement(SupplierPaperDoneTrail, { scope: "t-wait" }));
    expect(trail).toContain("is waiting on a credit.");
    expect(allButtons(trail)).toEqual(["Undo"]);
  });
});
