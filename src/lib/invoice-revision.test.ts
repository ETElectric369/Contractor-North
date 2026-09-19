import { describe, it, expect } from "vitest";
import { customerHoldsOlderCopy, invoiceLineEditRefusal, shouldStampRevision } from "@/lib/invoice-revision";

/**
 * 2026-09-18 — "even if i did sent it ill always need to be able to go back and make changes as
 * per a client's request or my own review catches errors".
 *
 * cn-v961 taught the row what "sent" means; it still refused to let a delivered invoice be edited.
 * Erik overruled that the same night he hit it twice: a client emailed asking that a PAID invoice
 * be reissued in the property owner's name rather than the agent's, and the invoice that started
 * the wave had his own Smartwater billed to the customer, caught on his own review.
 *
 * So the lock comes off and the record goes on (migration 0269). The three decisions that replace
 * it are pinned here, because all three are one-line predicates that will look safe to "simplify"
 * later and are not: WHICH status is still refused, WHEN a change goes on the record, and WHEN the
 * customer is holding something older than what the office is looking at.
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

describe("customerHoldsOlderCopy — the sentence the invoice page says out loud", () => {
  const sent = "2026-09-17T18:04:00.000Z";

  it("a bill revised after it went out means they're holding the older one", () => {
    expect(customerHoldsOlderCopy(sent, "2026-09-18T21:30:00.000Z")).toBe(true);
  });

  it("A RE-SEND SETTLES IT — sent_at moves forward and the question goes away", () => {
    // 0269 deliberately does not clear revised_at: the fact that a revision happened is worth
    // keeping. The comparison is what answers "do they have this copy?", so a re-send that moves
    // sent_at past the revision is the whole mechanism. textInvoice, the share sheet's yes, and
    // "Sent - I sent it myself" all move it (markInvoiceResent).
    const revised = "2026-09-18T21:30:00.000Z";
    expect(customerHoldsOlderCopy(sent, revised)).toBe(true);
    const resentAt = "2026-09-18T21:31:00.000Z";
    expect(customerHoldsOlderCopy(resentAt, revised)).toBe(false);
  });

  it("the same instant is not a revision — a re-send must not nag about the copy it just sent", () => {
    expect(customerHoldsOlderCopy(sent, sent)).toBe(false);
  });

  it("never revised, or never sent, asks nothing", () => {
    expect(customerHoldsOlderCopy(sent, null)).toBe(false);
    expect(customerHoldsOlderCopy(null, "2026-09-18T21:30:00.000Z")).toBe(false);
    expect(customerHoldsOlderCopy(null, null)).toBe(false);
  });

  it("an unparseable timestamp raises no alarm it cannot justify", () => {
    // A banner telling the office to re-send a bill is a real interruption. It has to be earned
    // by two real dates, not by garbage sorting oddly as a string.
    expect(customerHoldsOlderCopy("not a date", "2026-09-18T21:30:00.000Z")).toBe(false);
    expect(customerHoldsOlderCopy(sent, "not a date")).toBe(false);
  });

  it("reads the instant, not the text: offsets compare as moments", () => {
    // 11:05 Pacific is AFTER 18:04 UTC by four minutes. A string comparison would call it earlier
    // and hide a real revision.
    expect(customerHoldsOlderCopy(sent, "2026-09-17T11:08:00.000-07:00")).toBe(true);
    expect(customerHoldsOlderCopy(sent, "2026-09-17T11:00:00.000-07:00")).toBe(false);
  });
});
