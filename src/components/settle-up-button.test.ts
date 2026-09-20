import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { doorAmountStillMatches, holdCardLine } from "./settle-up-button";

/**
 * THE FIGURE ON THE CARD IS THE FIGURE ON THE INVOICE, OR NOTHING IS CHARGED.
 *
 * Tap to Pay hands Stripe a PaymentIntent minted at one moment and reads a card at another. Every
 * gap between those two moments is a gap the office can edit the invoice through, and the phone
 * has no idea: the reader charges the figure the intent was minted with, not the one the invoice
 * now says. The press already re-read the balance. The OTHER way to the reader did not — the
 * retry after Apple's terms sheet and Apple's how-to guide, which on this codebase's own clocks
 * is allowed eight minutes for the connect and ten more for the guide, and which only ever runs
 * on a company's very first tap: the day the office is most likely to still be building the bill.
 *
 * Fixtures are his own invoices as they stand (2026-09-20):
 *   INV-069  $6,268.03 total, $200.00 deposit taken  → $6,068.03 owed. The deposit is the one that
 *            cost him: it is what made INV-069 unfixable from the page once it had moved.
 *   INV-070  $1.23     the real charge that proved Tap to Pay end to end on 2026-09-18.
 *   INV-071  $1,875.98 sent, nothing paid.
 */

const INV_069 = { ok: true, total: 6268.03, amountPaid: 200 };
const INV_070 = { ok: true, total: 1.23, amountPaid: 0 };
const INV_071 = { ok: true, total: 1875.98, amountPaid: 0 };

describe("doorAmountStillMatches — does this PaymentIntent still say what the invoice says", () => {
  it("agrees to the cent on his own numbers", () => {
    expect(doorAmountStillMatches(606803, INV_069)).toBe(true);
    expect(doorAmountStillMatches(123, INV_070)).toBe(true);
    expect(doorAmountStillMatches(187598, INV_071)).toBe(true);
  });

  it("refuses a door minted before the deposit landed", () => {
    // The intent was minted for the whole $6,268.03; the $200 arrived while the sheet was open.
    expect(doorAmountStillMatches(626803, INV_069)).toBe(false);
  });

  it("refuses a door minted before a line was added — the new figure is HIGHER, and that is worse", () => {
    // A tech quoted $1,875.98 out loud; the office added $124.02 of material behind him.
    expect(doorAmountStillMatches(187598, { ok: true, total: 2000, amountPaid: 0 })).toBe(false);
  });

  it("is false by one cent, because a cent is a wrong charge too", () => {
    expect(doorAmountStillMatches(606802, INV_069)).toBe(false);
    expect(doorAmountStillMatches(606804, INV_069)).toBe(false);
  });

  it("a read that did not answer is NOT agreement", () => {
    // Not knowing what the invoice says is not the same as knowing it agrees. Both of these are
    // a door thrown away and a fresh one minted, never a card read on faith.
    expect(doorAmountStillMatches(606803, null)).toBe(false);
    expect(doorAmountStillMatches(606803, { ok: false })).toBe(false);
  });

  it("survives the float the balance is carried in", () => {
    // 0.1 + 0.2 arithmetic: invoiceBalance rounds to cents, and the comparison is integers.
    expect(doorAmountStillMatches(10, { ok: true, total: 0.3, amountPaid: 0.2 })).toBe(true);
    expect(doorAmountStillMatches(606803, { ok: true, total: 6268.029999, amountPaid: 200 })).toBe(true);
  });

  it("a paid-off invoice matches nothing a door could have been minted for", () => {
    // INV-070 after the webhook wrote it: zero owed, so no door onto it is good any more.
    expect(doorAmountStillMatches(123, { ok: true, total: 1.23, amountPaid: 1.23 })).toBe(false);
  });
});

describe("holdCardLine — the last sentence before Apple owns the screen", () => {
  it("prints the intent's own cents, formatted the way the rest of the screen prints money", () => {
    expect(holdCardLine(606803)).toBe("Hold their card to the top of the phone: $6,068.03");
    expect(holdCardLine(123)).toBe("Hold their card to the top of the phone: $1.23");
    expect(holdCardLine(187598)).toBe("Hold their card to the top of the phone: $1,875.98");
  });
});

const SRC = readFileSync(join(process.cwd(), "src/components/settle-up-button.tsx"), "utf8");

/**
 * The rest of this is shape, not behaviour: the defect was control flow inside one async function
 * that needs a card reader, Apple's terms sheet and a second device editing an invoice to
 * reproduce. What CAN be pinned is that there is one door-builder and that nothing reaches the
 * reader around it — so the next hand that adds a third way in cannot quietly skip the check.
 */
describe("every way to the reader goes through doorFor", () => {
  it("both card reads are handed a door that was just checked", () => {
    const collects = [...SRC.matchAll(/await collectTapPayment\(/g)].map((m) => m.index ?? 0);
    expect(collects).toHaveLength(2);
    for (const at of collects) {
      const before = SRC.slice(0, at);
      const lastDoor = before.lastIndexOf("await doorFor(");
      expect(lastDoor).toBeGreaterThan(-1);
      // Nothing between the check and the card except painting the prompt.
      const between = before.slice(lastDoor);
      expect(between).not.toContain("showHowToTap(");
      expect(between).not.toContain("enableTapToPay(");
      expect(between).not.toContain("termsGate(");
    }
  });

  it("the prompt's figure is read off the door at the moment it is painted, never captured earlier", () => {
    // `const holdCard = ...` above the terms gate was the bug's other half: a re-minted door
    // would have repainted the pre-terms number on the card prompt.
    expect(SRC).not.toMatch(/const holdCard\s*=/);
    expect([...SRC.matchAll(/label: holdCardLine\(pi\.amount\)/g)]).toHaveLength(2);
  });

  it("the balance re-check lives in exactly one place", () => {
    // One definition, one call site. A second call site would mean a second place deciding what
    // "still good" means, which is how two answers to one money question get shipped.
    expect([...SRC.matchAll(/doorAmountStillMatches\(/g)]).toHaveLength(2);
    expect([...SRC.matchAll(/(?<!function )doorAmountStillMatches\(/g)]).toHaveLength(1);
    expect([...SRC.matchAll(/async function doorFor\(/g)]).toHaveLength(1);
  });

  it("a moved balance stops the retry in words, and names a button that is on the screen", () => {
    expect(SRC).toContain("The balance changed while Apple's terms were up. Press Tap to Pay again for the new amount.");
    // NO DEAD ENDS: the sentence names Tap to Pay, and that button renders on both outcome
    // screens (Apple 5.3 keeps it enabled), so there is something to press.
    expect([...SRC.matchAll(/<TapToPayGlyph \/> Tap to Pay/g)].length).toBeGreaterThanOrEqual(2);
  });
});

describe("a PaymentIntent nobody can reach is cancelled, not left open on the tenant's Stripe", () => {
  it("every mint in this file self-cancels when the sheet closed under it", () => {
    const mints = [...SRC.matchAll(/createTapPaymentIntent\(/g)].map((m) => m.index ?? 0);
    // Two: the open-time pre-mint (Apple 5.6) and doorFor's, which is the one the press, the
    // job/appointment tap and the post-terms retry all come through.
    expect(mints).toHaveLength(2);
    for (const at of mints) {
      // Within the handful of lines after the mint resolves, the closed-sheet branch has to let
      // the intent go. Before this wave doorFor's mint just `return`ed and the intent stayed
      // live on the tenant's account with a customer's invoice on it.
      const after = SRC.slice(at, at + 900);
      expect(after).toContain("cancelTapPaymentIntent(r.paymentIntentId)");
    }
  });
});
