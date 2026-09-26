import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discountDeadlineSentence } from "./suppliers-card";
import { claimableDiscounts, type SupplierInvoiceRow } from "./supplier-reconcile";

/**
 * HIS CED DOCUMENTS, THE NIGHT THE WAVE RAN (2026-09-19, migration 0273).
 *
 * Six open invoices carry a live prompt-pay discount and every one of them is due 10 October,
 * which is the accident this file exists to outlive: CED's rule is "paid by the 10th of the month
 * FOLLOWING purchase", so the moment a September invoice is still open when an October one lands,
 * the claimable total spans two deadlines and the soonest one no longer carries all of it.
 *
 * $25.48, not the $29.62 the discount column sums to: the $4.14 on 8802-1107230 rides on an
 * invoice its own credit memo reverses to the cent, and claimableDiscounts already drops it.
 */
const TODAY = "2026-09-19";

const inv = (over: Partial<SupplierInvoiceRow> & { id: string }): SupplierInvoiceRow => ({
  invoiceNumber: "",
  kind: "invoice",
  invoiceDate: "2026-09-01",
  dueDate: null,
  jobNameRaw: null,
  jobId: null,
  jobName: null,
  total: 0,
  openBalance: null,
  closed: false,
  discountAmount: null,
  discountBy: null,
  billCount: 1,
  ...over,
});

/** The six live ones, verbatim off the portal. */
const OCTOBER_TENTH: SupplierInvoiceRow[] = [
  inv({ id: "si-1106969", invoiceNumber: "8802-1106969", invoiceDate: "2026-09-04", total: 301.81, openBalance: 301.81, discountAmount: 5.54, discountBy: "2026-10-10" }),
  inv({ id: "si-1107088", invoiceNumber: "8802-1107088", invoiceDate: "2026-09-01", total: 456.02, openBalance: 456.02, discountAmount: 4.7, discountBy: "2026-10-10" }),
  inv({ id: "si-1107139", invoiceNumber: "8802-1107139", invoiceDate: "2026-09-01", total: 59.17, openBalance: 59.17, discountAmount: 0.9, discountBy: "2026-10-10" }),
  inv({ id: "si-1107338", invoiceNumber: "8802-1107338", invoiceDate: "2026-09-03", total: 223.29, openBalance: 223.29, discountAmount: 4.1, discountBy: "2026-10-10" }),
  inv({ id: "si-1107695", invoiceNumber: "8802-1107695", invoiceDate: "2026-09-16", total: 1062.18, openBalance: 1062.18, discountAmount: 8.47, discountBy: "2026-10-10" }),
  inv({ id: "si-1107820", invoiceNumber: "8802-1107820", invoiceDate: "2026-09-16", total: 187.64, openBalance: 187.64, discountAmount: 1.77, discountBy: "2026-10-10" }),
];

/** Next month's ordinary CED invoice: same rule, one month later. Nothing exotic about it. */
const NEXT_MONTH = inv({
  id: "si-1108400",
  invoiceNumber: "8802-1108400",
  invoiceDate: "2026-10-02",
  total: 500,
  openBalance: 500,
  discountAmount: 9,
  discountBy: "2026-11-10",
});

describe("the discount sentence names one date and the money that actually rides on it", () => {
  it("says the whole figure comes off when every live discount falls on the same day", () => {
    const claim = claimableDiscounts(OCTOBER_TENTH, TODAY);
    expect(claim.total).toBeCloseTo(25.48, 2);
    expect(claim.dueOnNext).toBeCloseTo(25.48, 2);
    const said = discountDeadlineSentence({ total: claim.total, dueOnNext: claim.dueOnNext, by: claim.nextDeadline });
    expect(said.allOnOneDate).toBe(true);
    expect(said.sentence).toBe("$25.48 comes off if they are paid by Oct 10, 2026");
  });

  /**
   * THE BUG, IN HIS OWN NUMBERS. One October invoice beside the six September ones and the amber
   * pointer at the top of the Suppliers card used to read "$34.48 comes off if they are paid by
   * Oct 10, 2026" - overstating by $9 what is at risk on that day, and hurrying money that is not
   * due until 10 November.
   */
  it("splits the sentence the moment two deadlines are live at once", () => {
    const claim = claimableDiscounts([...OCTOBER_TENTH, NEXT_MONTH], TODAY);
    expect(claim.total).toBeCloseTo(34.48, 2);
    expect(claim.dueOnNext).toBeCloseTo(25.48, 2);
    expect(claim.nextDeadline).toBe("2026-10-10");
    const said = discountDeadlineSentence({ total: claim.total, dueOnNext: claim.dueOnNext, by: claim.nextDeadline });
    expect(said.allOnOneDate).toBe(false);
    expect(said.sentence).toBe("$25.48 of $34.48 in discount goes if they are not paid by Oct 10, 2026");
    expect(said.sentence).not.toContain("$34.48 comes off");
  });

  it("says nothing at all when there is no discount live, or no date to hang it on", () => {
    expect(discountDeadlineSentence({ total: 0, dueOnNext: 0, by: "2026-10-10" }).sentence).toBe("");
    expect(discountDeadlineSentence({ total: 25.48, dueOnNext: 25.48, by: null }).sentence).toBe("");
  });

  /** Half a cent is rounding, not a second deadline. */
  it("treats a rounding-sized gap as one date", () => {
    const said = discountDeadlineSentence({ total: 25.48, dueOnNext: 25.4765, by: "2026-10-10" });
    expect(said.allOnOneDate).toBe(true);
    expect(said.sentence).toBe("$25.48 comes off if they are paid by Oct 10, 2026");
  });
});

const CARD = readFileSync(join(process.cwd(), "src/app/(app)/bills/suppliers-card.tsx"), "utf8");

describe("the card says the things a balance cannot say for itself", () => {
  /**
   * The pointer at the top of the card was the one copy of this sentence with no guard on it. Wave B
   * retired that pointer (Needs You holds the decisions), so the one copy left is the account's own
   * line, and it still comes from the one builder.
   */
  it("builds every copy of the discount sentence from the one builder", () => {
    expect(CARD).toContain("discountDeadlineSentence({");
    expect(CARD).not.toContain("discountDeadlineSentence(waiting.claimable)");
    expect(CARD).not.toContain("comes off if they are paid by ${formatDate(waiting");
    expect(CARD).not.toContain("balance.supplierSays.nextDiscountAmount >=");
  });

  /**
   * MODEL A: ticking a bill settled and recording the cheque that covered it take the same dollar
   * off twice. Neither control can be blocked - the app cannot know which bills a cheque covered -
   * so the collision has to be speakable instead.
   */
  it("warns when bills marked settled sit beside recorded payments on the same account", () => {
    expect(CARD).toContain('balance.model === "bills-minus-payments" &&');
    expect(CARD).toContain("const settledBesidePayments =");
    expect(CARD).toContain("balance is that much too low");
    // It names controls that exist: the bills-list badge now reads On Account, and a payment's
    // own button says Undo, not Void.
    expect(CARD).toContain("or undo that payment here");
  });

  /**
   * ONE VOCABULARY, CARD AND LIST. The bills list stopped printing the raw column and now says
   * On Account / Settled, so a sentence up here that sends him off to "mark those receipts paid"
   * points at a word that is no longer on the screen. A rename is only finished when the copy
   * that names the control moves with it.
   */
  it("sends him to words that are actually on the bills list", () => {
    expect(CARD).not.toContain("those receipts paid in the bills list");
    expect(CARD).not.toContain("Mark those receipts paid in the bills list");
    expect(CARD).not.toContain("is still marked unpaid.`");
    // Wave B: "further down this page" became a door that opens All Bills (FoldOpener).
    expect(CARD).toContain("mark those receipts Settled in {toAllBills}");
    expect(CARD).toContain('<a href="#all-bills"');
    expect(CARD).not.toContain("further down this page");
    expect(CARD).toContain("still marked On Account.`");
  });

  /** Model B: their figure cannot cover a purchase they never billed him for. */
  it("does not explain away the bills the supplier has no document for", () => {
    expect(CARD).toContain("const modelledExplained =");
    expect(CARD).toContain("${formatCurrency(modelledExplained)} unpaid there, which is your paperwork rather than theirs.");
    expect(CARD).not.toContain("${formatCurrency(modelledBillsUnpaid)} unpaid there");
    expect(CARD).toContain("they never sent paper for");
    // And the list of his own bills stops calling itself the balance under model B.
    expect(CARD).toContain('{fromSupplier ? "Your Bills On This Account" : "What The Balance Is Made Of"}');
  });
});
