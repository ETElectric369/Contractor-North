import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// The detail's ⋯ runs registry verbs only when tapped; the action registry is not this file's business.
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { SuppliersCard, discountDeadlineSentence, paymentLine, supplierChecks } from "./suppliers-card";
import { claimableDiscounts, type SupplierInvoiceRow } from "./supplier-reconcile";
import { supplierBalance, type SupplierAccountRow } from "./supplier-balance";

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
   * so the collision has to be speakable instead: one check (W1-33), one sentence and one door, and
   * the payment's own Undo stays on its row.
   */
  it("asks him to check bills marked settled beside recorded payments on the same account", () => {
    expect(CARD).toContain('balance.model === "bills-minus-payments" &&');
    expect(CARD).toContain("const settledBesidePayments =");
    expect(CARD).toContain("if a check covered them, this balance is too low.");
    // Undo stays on the payment's own row.
    expect(CARD).toContain("() => actions.voidPayment(p.id),");
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
    // A check's door opens All Bills (FoldOpener), 44px, saying what it opens.
    expect(CARD).toContain('seeAllInAllBills("Open In All Bills")');
    expect(CARD).toContain('<a href="#all-bills"');
    expect(CARD).not.toContain("further down this page");
    expect(CARD).toContain("still marked On Account.`");
    expect(CARD).toContain("Still owed; mark {c.bills.length === 1 ? \"it\" : \"them\"} Settled when you pay.");
  });

  /**
   * TWO TRUE FIGURES, AND THE SENTENCE NAMES WHAT EACH ONE ANSWERS. It used to end "and neither is
   * wrong", which is a hedge: it asked an electrician between jobs to accept two numbers on faith
   * instead of telling him which question each one answers. Two figures are only confusing while
   * nobody says that.
   */
  it("names the question behind each of the two supplier figures instead of asking him to accept both", () => {
    // The sentence, not the comment above it: the comment quotes the hedge to say what it prevents.
    expect(CARD).not.toContain("neither is wrong.");
    expect(CARD).toContain("so it answers a");
    expect(CARD).toContain("different question: that one counts every ticket you have not squared up, and the figure above is what is");
    expect(CARD).toContain("still owed once the payments you have sent come off");
  });

  /**
   * AND IT DOES NOT CALL THE HEADLINE A SUPPLIER'S ASK WHEN NO SUPPLIER ASKED. `totalOwed` is a blend:
   * their own papers where they send them, our own tickets where they do not, register accounts and
   * papers on no account — the fold above names all four. A company nobody sends a portal balance to
   * has a headline made entirely of its own tickets, so "what your suppliers are asking you for" was a
   * sentence about a document that does not exist. The supplier's-own-figure half is said only where
   * there is one, gated on the same `theirOwnPapers` slice the fold is built from.
   */
  it("claims a supplier's own figure only where this company has supplier papers", () => {
    expect(CARD).not.toContain("what your suppliers are asking you for");
    expect(CARD).toContain('{theirOwnPapers > 0.005 ? ", which is your suppliers\' own figure where they send you papers" : ""}');
  });

  /** Model B: their figure cannot cover a purchase they never billed him for. */
  it("does not explain away the bills the supplier has no document for", () => {
    expect(CARD).toContain("const modelledExplained =");
    // "bought on account", the same words All Bills now leads with (8a982483), so the sentence
    // pointing at that fold and the fold's own line are about the same question in the same words.
    expect(CARD).toContain("${formatCurrency(modelledExplained)} bought on account there, which is your paperwork rather than theirs.");
    expect(CARD).not.toContain("${formatCurrency(modelledBillsUnpaid)} unpaid there");
    expect(CARD).toContain("{account.name} never sent");
    // And the list of his own bills stops calling itself the balance under model B.
    expect(CARD).toContain('{fromSupplier ? "Your Bills On This Account" : "What The Balance Is Made Of"}');
  });
});

/**
 * ONE NUMBER, ONE BUTTON, ONE "CHECK THESE" (W1-33). The closed line's amber "+ $N they never sent
 * paper for" is "N To Check"; the detail opens on Record A Payment and one slate line of the model's
 * own arithmetic; each live contradiction is one check. A failure is never a check.
 */
describe("the supplier detail: Check These", () => {
  const acct = (over: Partial<SupplierAccountRow> = {}): SupplierAccountRow => ({
    id: "a1",
    name: "Valley Supply",
    accountNumber: null,
    branchCode: null,
    onAccount: true,
    note: null,
    aliases: [],
    bills: [],
    payments: [],
    ...over,
  });
  const bill = (id: string, amount: number, status = "unpaid", billDate = "2026-09-01") => ({
    id,
    supplier: "Valley Supply",
    billDate,
    amount,
    status,
    jobId: null,
    jobName: null,
    invoiceNumber: null,
    isStatement: false,
  });
  const pay = (id: string, amount: number, paidOn: string) => ({ id, accountId: "a1", amount, paidOn, method: "check", reference: null, note: null, voided: false });
  const checksOf = (a: SupplierAccountRow, noDoc: string[] = [], unread = false) =>
    supplierChecks({ account: a, balance: supplierBalance(a, "2026-09-26"), noDocIds: new Set(noDoc), unread });

  it("a quiet account has no checks: N is 0, and no fold renders", () => {
    const a = acct({ bills: [bill("b1", 100)], payments: [pay("p1", 40, "2026-09-05")] });
    expect(checksOf(a)).toEqual([]);
  });

  it("N counts only live checks: settled beside payments (model A), and the register pair", () => {
    const modelA = acct({ bills: [bill("b1", 100), bill("b2", 30, "paid")], payments: [pay("p1", 40, "2026-09-05")] });
    expect(checksOf(modelA).map((c) => c.kind)).toEqual(["settled_beside_payments"]);
    // A balance that couldn't be totalled asks no arithmetic check (the failure is said instead).
    expect(checksOf(modelA, [], true)).toEqual([]);
    const register = acct({ onAccount: false, bills: [bill("b3", 16.28)] });
    expect(checksOf(register)).toEqual([{ kind: "register_on_account", count: 1, charged: 16.28 }]);
  });

  it("model B: bills the supplier never sent paper for are one check, with their money; model A never has it", () => {
    const papers = [
      { id: "si-1", invoiceNumber: "1", kind: "invoice", invoiceDate: "2026-09-01", dueDate: null, jobNameRaw: null, jobId: null, jobName: null, total: 50, openBalance: 50, closed: false, discountAmount: null, discountBy: null, billCount: 1 },
    ] as unknown as SupplierAccountRow["supplierInvoices"];
    const b = acct({ bills: [bill("b1", 467.87), bill("b2", 20)], supplierInvoices: papers });
    const [c] = checksOf(b, ["b1"]);
    expect(c).toMatchObject({ kind: "no_paper", total: 467.87 });
    expect((c as { bills: { id: string }[] }).bills.map((x) => x.id)).toEqual(["b1"]);
    expect(checksOf(acct({ bills: [bill("b1", 467.87)] }), ["b1"])).toEqual([]);
  });

  it("the slate line says the arithmetic of the model actually used", () => {
    const a = acct({ bills: [bill("b1", 100)], payments: [pay("p1", 40, "2026-09-05")] });
    expect(paymentLine({ account: a, balance: supplierBalance(a, "2026-09-26"), paymentsUnread: false })).toBe("$100.00 charged less $40.00 you've sent.");
    expect(paymentLine({ account: a, balance: supplierBalance(a, "2026-09-26"), paymentsUnread: true })).toBe("Couldn't read your payments just now.");
    expect(paymentLine({ account: acct({ onAccount: false }), balance: supplierBalance(acct({ onAccount: false }), "2026-09-26"), paymentsUnread: false })).toBeNull();
  });

  it("on screen: a quiet account draws no N To Check and no Check These; a live one counts only its live checks", () => {
    const render = (accounts: SupplierAccountRow[]) =>
      renderToStaticMarkup(
        createElement(SuppliersCard, {
          accounts,
          today: "2026-09-26",
          actions: { recordPayment: async () => ({ ok: true }), voidPayment: async () => ({ ok: true }), setOnAccount: async () => ({ ok: true }), updateAccount: async () => ({ ok: true }) },
        }),
      );
    const quiet = render([acct({ bills: [bill("b1", 100)], payments: [pay("p1", 40, "2026-09-05")] })]);
    expect(quiet).not.toContain("To Check");
    expect(quiet).not.toContain("Check These");
    expect(quiet).not.toContain('id="supplier-checks-a1"');
    // The detail opens on Record A Payment, the slate line under it, and the ⋯ holding Edit Account.
    expect(quiet).toContain("Record A Payment");
    expect(quiet).toContain("$100.00 charged less $40.00 you&#x27;ve sent.");
    expect(quiet).toMatch(/<button[^>]*aria-label="Actions"/);
    const live = render([acct({ onAccount: false, bills: [bill("b3", 16.28)] })]);
    expect(live).toContain("1 To Check");
    expect(live).toContain('id="supplier-checks-a1"');
    expect(live).toContain("Check These (1)");
    expect(live).toContain("1 bill marked On Account, $16.28, but you pay Valley Supply at the register.");
    expect(live).toContain("Turn On A Running Balance");
  });

  it("the card: N To Check replaces the '+ $N they never sent paper for' line; the failure line stays; grids and Why Don't These Subtract? are gone", () => {
    expect(CARD).toContain("{checks.length} To Check");
    expect(CARD).not.toContain("they never sent paper for\n");
    expect(CARD).not.toContain("+ {formatCurrency(noDocTotal)} they never sent paper for");
    expect(CARD).toContain("Couldn&apos;t check your bills against their papers");
    expect(CARD).not.toContain("Why Don't These Subtract?");
    expect(CARD).not.toContain("What Does Undo Do?");
    expect(CARD).not.toContain('className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50');
    expect(CARD).toContain("id={`supplier-checks-${account.id}`}");
    expect(CARD).toContain("{checks.length > 0 && (");
    // Edit Account is on the detail's ⋯; the spellings are read in its sheet.
    expect(CARD).toContain("<SectionActionsMenu tree={ACCOUNT_MENU}>");
    expect(CARD).toContain("Other Spellings");
    expect(CARD).not.toContain("Names It&apos;s Filed Under");
  });

  it("the ⋯'s Edit Account panel is never clipped: no account card cuts off what drops out of it", () => {
    // A register supplier with nothing on it: its detail is only the ⋯ row, and the panel under it
    // hangs below the card's edge. A clipping card (overflow-hidden) hid Edit Account entirely.
    const html = renderToStaticMarkup(
      createElement(SuppliersCard, {
        accounts: [
          {
            id: "a9",
            name: "Corner Hardware",
            accountNumber: null,
            branchCode: null,
            onAccount: false,
            note: null,
            aliases: [],
            bills: [],
            payments: [],
          },
        ],
        today: "2026-09-26",
        actions: { recordPayment: async () => ({ ok: true }), voidPayment: async () => ({ ok: true }), updateAccount: async () => ({ ok: true }) },
      }),
    );
    expect(html).toMatch(/<button[^>]*aria-label="Actions"/);
    const card = /<div class="([^"]*)"><details id="supplier-invoices-a9"/.exec(html);
    expect(card).not.toBeNull();
    expect(card![1]).not.toContain("overflow-hidden");
    expect(CARD).not.toContain('<Card key={account.id} className="overflow-hidden">');
  });
});
