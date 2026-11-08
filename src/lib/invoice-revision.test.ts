import { describe, it, expect } from "vitest";
import { changedSinceSent, customerHoldsOlderCopy, hasUnsentRevision, invoiceLineEditRefusal, shouldStampRevision, type MoneyFacts } from "@/lib/invoice-revision";

/**
 * 2026-09-18 — "even if i did sent it ill always need to be able to go back and make changes as
 * per a client's request or my own review catches errors".
 *
 * cn-v961 taught the row what "sent" means; it still refused to let a delivered invoice be edited.
 * Erik overruled that the same night he hit it twice: a client emailed asking that a PAID invoice
 * be reissued in the property owner's name rather than the agent's, and the invoice that started
 * the wave had his own Smartwater billed to the customer, caught on his own review.
 *
 * So the lock comes off and the record goes on (migration 0269). The decisions that replace it are
 * pinned here, because each is a short predicate that will look safe to "simplify" later and is
 * not: WHICH status is still refused, WHEN a change goes on the record, WHEN the bill counts as
 * changed since it went out (the record question), and WHEN the office is told to send it again.
 *
 * 2026-11-07 — "any change i make after its been sent reflects on the link already sent so its
 * mostly unnecessary to send it again unless they've paid and something changes and a difference
 * remains". The notice narrowed to the money (0405's sent_total records the figure a send carried);
 * the record question stayed for the doors that re-stamp a delivery. Both are tables below. Skeptic
 * #56 the same day: "paid and something changes" is an ORDER - the payments' dates against revised_at
 * say whether the money landed before the change (on the old figure) or after it (on the live one).
 */
describe("invoiceLineEditRefusal — paid is not the special case, void is", () => {
  it("every live status may be corrected, paid included", () => {
    // The exact case Erik's client wrote in about: a bill settled months ago, reissued in the
    // owner's name. If this row ever goes back to refusing, that email has no answer again.
    for (const status of ["draft", "sent", "partial", "paid", "overdue"]) {
      expect(invoiceLineEditRefusal(status)).toBeNull();
    }
  });

  it("void is refused, because its lines let go of the work they billed", () => {
    // Voiding releases every claim the lines hold (0255: the claim dies with the invoice), so the
    // hours and materials on a void invoice may already be billed on a live one.
    expect(invoiceLineEditRefusal("void")).toBeTruthy();
  });

  it("the refusal names doors that exist, and uses hyphens like the rest of the app", () => {
    const sentence = invoiceLineEditRefusal("void")!;
    // The refusal this replaced pointed at "record an adjustment", a feature that has never
    // existed in this app — a dead end wearing a helpful voice. Both doors named here are real:
    // the status picker on the invoice page, and New Invoice.
    expect(sentence).toMatch(/status/i);
    expect(sentence).toMatch(/new invoice/i);
    expect(sentence).not.toContain("—");
    expect(sentence).not.toContain("adjustment");
  });

  it("an unknown or missing status is treated as editable, not as void", () => {
    // Void is a deliberate ending someone chose. Nothing should inherit that from a null.
    expect(invoiceLineEditRefusal(null)).toBeNull();
    expect(invoiceLineEditRefusal(undefined)).toBeNull();
    expect(invoiceLineEditRefusal("")).toBeNull();
  });
});

describe("shouldStampRevision — delivery decides, never status", () => {
  it("a draft is never stamped: editing a draft is building it", () => {
    expect(shouldStampRevision(null)).toBe(false);
    expect(shouldStampRevision(undefined)).toBe(false);
  });

  it("an invoice that really went out is stamped", () => {
    expect(shouldStampRevision("2026-09-17T18:04:00.000Z")).toBe(true);
  });

  it("PROMOTED BUT NEVER DELIVERED is not stamped — the whole reason 0267 exists", () => {
    // INV-069: Pay Now promoted a draft to 'sent' the moment it built the card door, before any
    // card was tapped. Its status says 'sent' and its sent_at is NULL. Nobody outside the office
    // has ever seen it, so "the customer is holding an older copy" would be a sentence about a
    // person who does not exist — and one the office could never clear.
    expect(shouldStampRevision(null)).toBe(false);
    // Whitespace is not a timestamp either; a blank string must not read as a delivery.
    expect(shouldStampRevision("   ")).toBe(false);
  });
});

describe("changedSinceSent — the record question: did the bill change after it last went out?", () => {
  const sent = "2026-10-01T18:04:00.000Z";

  it("a change after the send is a change; a re-send that moves sent_at past it is not", () => {
    expect(changedSinceSent(sent, "2026-10-02T21:30:00.000Z")).toBe(true);
    // 0269 deliberately does not clear revised_at: the comparison is what answers the question, so
    // a re-send (markInvoiceResent, the share sheet's yes, the hand "Sent") is the whole mechanism.
    expect(changedSinceSent("2026-10-02T21:31:00.000Z", "2026-10-02T21:30:00.000Z")).toBe(false);
  });

  it("the same instant is not a change — a re-send must not nag about the copy it just sent", () => {
    expect(changedSinceSent(sent, sent)).toBe(false);
  });

  it("never revised, or never sent, is not a change", () => {
    expect(changedSinceSent(sent, null)).toBe(false);
    expect(changedSinceSent(null, "2026-10-02T21:30:00.000Z")).toBe(false);
    expect(changedSinceSent(null, null)).toBe(false);
    expect(changedSinceSent(undefined, undefined)).toBe(false);
  });

  it("an unparseable timestamp raises no alarm it cannot justify", () => {
    expect(changedSinceSent("not a date", "2026-10-02T21:30:00.000Z")).toBe(false);
    expect(changedSinceSent(sent, "not a date")).toBe(false);
  });

  it("reads the instant, not the text: offsets compare as moments", () => {
    // 11:08 Pacific is AFTER 18:04 UTC by four minutes. A string comparison would call it earlier.
    expect(changedSinceSent(sent, "2026-10-01T11:08:00.000-07:00")).toBe(true);
    expect(changedSinceSent(sent, "2026-10-01T11:00:00.000-07:00")).toBe(false);
  });
});

/**
 * THE NOTICE, AS A TABLE (Erik, 2026-11-07). The link the customer holds is live, so the only thing
 * that can be stale is the figure they paid against. The office is told to send a bill again only
 * when ALL of: it changed since it went out, the customer paid something BEFORE that change (the
 * payments' dates), the money moved since the send (sent_total, 0405), and a difference remains. Each
 * row below is one branch of the rule, and the WHY column is the sentence that keeps it from being
 * "simplified" back into a nag.
 */
describe("customerHoldsOlderCopy — should the office be told to send it again?", () => {
  const sent = "2026-10-01T18:04:00.000Z";
  const revised = "2026-10-05T21:30:00.000Z";
  const resent = "2026-10-05T21:31:00.000Z";
  /** The payments' dates against the change: a deposit the week before it, a payment the day after. */
  const before = ["2026-10-02T17:00:00.000Z"];
  const after = ["2026-10-06T17:00:00.000Z"];
  type Row = { name: string; sentAt: string | null; revisedAt: string | null; facts: MoneyFacts; expected: boolean };
  const TABLE: Row[] = [
    // (b) nothing paid: "unless they've paid" — the live link already says it all.
    { name: "changed, nothing paid", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 0, sentTotal: 1000, paidAt: [] }, expected: false },
    { name: "changed, nothing paid, figure unknown (sent before 0405)", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 0, sentTotal: null, paidAt: [] }, expected: false },
    // (b) THE ORDER (skeptic #56, 2026-11-07): unpaid, changed, THEN paid part. The payment was made
    // through the live link, which already showed the new figure — nothing is stale for anybody,
    // though the money moved and a balance remains.
    { name: "unpaid, changed, then paid part", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: 1000, paidAt: after }, expected: false },
    { name: "unpaid, changed, then paid part, figure unknown", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: null, paidAt: after }, expected: false },
    { name: "a payment at the very instant of the change is not before it", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: 1000, paidAt: [revised] }, expected: false },
    // (e) paid part BEFORE the change, changed, a balance left: they paid against $1,000 and $1,250 stands.
    { name: "paid part before the change, then total raised", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: 1000, paidAt: before }, expected: true },
    // (e) paid before AND after: the first payment was made on the old figure, so the notice stands.
    { name: "paid before and after the change, total raised", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 700, sentTotal: 1000, paidAt: [...before, ...after] }, expected: true },
    // (b) a date nobody can read counts as BEFORE: unknown resolves towards saying so. payments.paid_at
    // is NOT NULL (0003), so each of these is a projection miss, never a real row.
    { name: "a payment with no date counts as before", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: 1000, paidAt: [null] }, expected: true },
    { name: "a payment with a garbage date counts as before", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: 1000, paidAt: ["not a date"] }, expected: true },
    { name: "money paid but no payment dates handed over counts as before", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: 1000, paidAt: [] }, expected: true },
    // (c) squared up: paid in full and the money did not move — a wording change on a paid bill.
    { name: "paid in full, money unchanged", sentAt: sent, revisedAt: revised, facts: { total: 1000, amountPaid: 1000, sentTotal: 1000, paidAt: before }, expected: false },
    // (c) squared up BEFORE the change too: the old rule kept this one (paid before the change =
    // "holding the old paper"); Erik does not want to be asked — the link shows the new wording.
    { name: "paid in full long before a later change, figure unknown", sentAt: "2026-06-01T17:00:00.000Z", revisedAt: "2026-09-01T17:00:00.000Z", facts: { total: 4200, amountPaid: 4200, sentTotal: null, paidAt: ["2026-06-05T17:00:00.000Z"] }, expected: false },
    // (e) a deposit, then the total went up: they paid against $1,000 and $1,250 is owed now.
    { name: "partial payment, total raised", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: 1000, paidAt: before }, expected: true },
    // (d) a deposit, then a wording change: the figure they paid against still stands.
    { name: "partial payment, wording only (sent_total equals total)", sentAt: sent, revisedAt: revised, facts: { total: 1000, amountPaid: 500, sentTotal: 1000, paidAt: before }, expected: false },
    // (e) paid in full, then a line added: a balance reappeared on a bill they thought was done.
    { name: "full payment, then total raised", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: 1000, sentTotal: 1000, paidAt: before }, expected: true },
    // (e) paid in full, then the total LOWERED: they are owed the difference, and the bill must stay
    // in front of the office, not vanish because its balance reads zero.
    { name: "paid, then total lowered below the payment (overpayment)", sentAt: sent, revisedAt: revised, facts: { total: 900, amountPaid: 1000, sentTotal: 1000, paidAt: before }, expected: true },
    // (e) the figure unknown (sent before 0405): the app cannot prove the money did not move, so
    // paid + a balance keeps the notice rather than guess.
    { name: "figure unknown, paid, balance remains", sentAt: sent, revisedAt: revised, facts: { total: 1000, amountPaid: 500, sentTotal: null, paidAt: before }, expected: true },
    { name: "figure unknown (undefined), paid, balance remains", sentAt: sent, revisedAt: revised, facts: { total: 1000, amountPaid: 500, paidAt: before }, expected: true },
    // sent_total 0 is a RECORDED figure, not an unknown one: a $0 bill went out, then got a total.
    { name: "sent at $0, then a total added, part paid", sentAt: sent, revisedAt: revised, facts: { total: 500, amountPaid: 200, sentTotal: 0, paidAt: before }, expected: true },
    // (a) re-sent after the change: sent_at moved past revised_at, whatever the money says.
    { name: "re-sent after the change, money moved and owed", sentAt: resent, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: 1250, paidAt: before }, expected: false },
    { name: "re-sent at the same instant as the change", sentAt: revised, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: 1000, paidAt: before }, expected: false },
    // (a) never delivered (INV-069: a pay door promoted it to 'sent', nobody has a copy), or never changed.
    { name: "never sent", sentAt: null, revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: null, paidAt: before }, expected: false },
    { name: "never changed", sentAt: sent, revisedAt: null, facts: { total: 1250, amountPaid: 500, sentTotal: 1000, paidAt: before }, expected: false },
    { name: "garbage dates", sentAt: "not a date", revisedAt: revised, facts: { total: 1250, amountPaid: 500, sentTotal: 1000, paidAt: before }, expected: false },
    // (b) a payment nobody recorded as a number is not a payment.
    { name: "amount paid unreadable", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: Number.NaN, sentTotal: 1000, paidAt: before }, expected: false },
    { name: "amount paid negative", sentAt: sent, revisedAt: revised, facts: { total: 1250, amountPaid: -20, sentTotal: 1000, paidAt: before }, expected: false },
  ];

  for (const row of TABLE) {
    it(`${row.name} -> ${row.expected ? "send it again" : "nothing to say"}`, () => {
      expect(customerHoldsOlderCopy(row.sentAt, row.revisedAt, row.facts)).toBe(row.expected);
    });
  }

  it("cent dust is not a difference, and PostgREST's string numerics read the same", () => {
    // Paid to the cent with float dust on top: squared up (c), not an overpayment.
    expect(customerHoldsOlderCopy(sent, revised, { total: 1875.98, amountPaid: 1875.9800000001, sentTotal: 1700, paidAt: before })).toBe(false);
    // A wording change read off PostgREST, every figure a string: (d) still compares in cents.
    const wording = { total: "1000", amountPaid: "500", sentTotal: "1000", paidAt: before } as unknown as MoneyFacts;
    expect(customerHoldsOlderCopy(sent, revised, wording)).toBe(false);
    const moved = { total: "1000", amountPaid: "500", sentTotal: "900", paidAt: before } as unknown as MoneyFacts;
    expect(customerHoldsOlderCopy(sent, revised, moved)).toBe(true);
    // A figure a cent off is a figure that moved.
    expect(customerHoldsOlderCopy(sent, revised, { total: 1000.01, amountPaid: 500, sentTotal: 1000, paidAt: before })).toBe(true);
  });

  it("the order is read off the payments' own dates, as instants: the same figures, the one difference is WHEN", () => {
    // Erik's rule has an order in it - "unless they've paid and something changes" - and skeptic #56
    // found the sequence that broke the amount-only reading: money changes on an unpaid bill, the
    // customer then pays part of it through the live link (which showed the new figure), notice.
    const facts = { total: 1250, amountPaid: 500, sentTotal: 1000 };
    expect(customerHoldsOlderCopy(sent, revised, { ...facts, paidAt: before })).toBe(true);
    expect(customerHoldsOlderCopy(sent, revised, { ...facts, paidAt: after })).toBe(false);
    // 14:29 Pacific is a minute BEFORE the 21:30Z change; 14:31 is a minute after. A string comparison
    // would sort both before it.
    expect(customerHoldsOlderCopy(sent, revised, { ...facts, paidAt: ["2026-10-05T14:29:00.000-07:00"] })).toBe(true);
    expect(customerHoldsOlderCopy(sent, revised, { ...facts, paidAt: ["2026-10-05T14:31:00.000-07:00"] })).toBe(false);
  });
});

describe("hasUnsentRevision — the RECORD question for the doors that re-stamp a delivery", () => {
  const sent = "2026-10-01T18:04:00.000Z";
  const revised = "2026-10-05T21:30:00.000Z";
  const client = (row: Record<string, unknown> | null, asked: string[] = [], error: unknown = null) => ({
    from: () => ({
      select: (cols: string) => {
        asked.push(cols);
        const chain = { eq: () => chain, maybeSingle: async () => ({ data: row, error }) };
        return chain;
      },
    }),
  });

  it("reads only the record: status and the two stamps, no money, no payments", async () => {
    const asked: string[] = [];
    await hasUnsentRevision(client({ status: "sent", sent_at: sent, revised_at: revised }, asked), "inv-1");
    expect(asked).toEqual(["status, sent_at, revised_at"]);
  });

  it("a changed bill is a changed bill, paid in full or never paid — re-sharing it IS a delivery of the current one", async () => {
    // The share sheet and the hand "Sent" move sent_at on a yes, and 0405's trigger records the
    // figure the re-send carried. The money-only notice is a different question (above).
    expect(await hasUnsentRevision(client({ status: "paid", sent_at: sent, revised_at: revised }), "inv-1")).toBe(true);
    expect(await hasUnsentRevision(client({ status: "sent", sent_at: sent, revised_at: revised }), "inv-1")).toBe(true);
  });

  it("a re-stamped bill (sent_at past revised_at) reads false again, so the email door's check settles", async () => {
    expect(await hasUnsentRevision(client({ status: "sent", sent_at: "2026-10-05T21:31:00.000Z", revised_at: revised }), "inv-1")).toBe(false);
    expect(await hasUnsentRevision(client({ status: "sent", sent_at: sent, revised_at: null }), "inv-1")).toBe(false);
    expect(await hasUnsentRevision(client({ status: "sent", sent_at: null, revised_at: revised }), "inv-1")).toBe(false);
  });

  it("a VOID invoice is never waiting to be re-sent", async () => {
    expect(await hasUnsentRevision(client({ status: "void", sent_at: sent, revised_at: revised }), "inv-1")).toBe(false);
  });

  it("false on anything it cannot read: no row, a read error, a throw", async () => {
    expect(await hasUnsentRevision(client(null), "inv-1")).toBe(false);
    expect(await hasUnsentRevision(client({ status: "sent", sent_at: sent, revised_at: revised }, [], { message: "boom" }), "inv-1")).toBe(false);
    const throwing = { from: () => { throw new Error("no"); } };
    expect(await hasUnsentRevision(throwing, "inv-1")).toBe(false);
  });
});
