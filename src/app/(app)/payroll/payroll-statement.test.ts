import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ── THE PAY BOARD'S DETAIL IS NOT THE BUTTON THAT PAYS ────────────────────────────────────────
 *
 * Erik, 2026-10-01 (dfe1f59b): "separate the payroll detail from the button to pay them / record
 * payment and merge all the data into a more intuitive" page.
 *
 * /payroll had NO test at the view level, so not one of the guards on the money here was pinned: not
 * the empty amount, not the disabled Record button, not the withheld figure while a shift runs. This
 * file pins them, and it pins the separation itself — a person's card is a disclosure now, and the
 * form that pays him has one named door at the foot of his statement.
 *
 * EVERY NAME AND FIGURE BELOW IS INVENTED (tests/no-real-names.test.ts is the tripwire).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("./actions", () => ({
  recordPayment: vi.fn(),
  voidPayment: vi.fn(),
  confirmImportedPayment: vi.fn(),
  settleMileage: vi.fn(),
  unsettleMileage: vi.fn(),
}));

import { PayrollView } from "./payroll-view";
import { PersonStatement } from "./person-statement";
import { PaySheet } from "./pay-sheet";
import { BASE_PAY_FACTS, PAYMENT_LANDS_FACTS, THREE_FIGURES_FACTS } from "./payroll-facts";
import { alreadyAppliedTo, noAnswerSentence, owedReading, type PayPaymentRow, type PersonBalance } from "@/lib/payroll-math";

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const person = (over: Partial<PersonBalance>): PersonBalance => ({
  profileId: "p-1",
  name: "Sam Tillery",
  earned: 0,
  paid: 0,
  owed: 0,
  unpaidHours: 0,
  oldestUnpaid: null,
  lastPayment: null,
  hasOpenShift: false,
  needsCheckCount: 0,
  heldMiles: 0,
  loggedMiles: 0,
  ...over,
});

/** Owed: $1,240.50 earned less $1,040.25 paid. Off-round cents on purpose — the three figures have
 *  to agree to the cent or the subtraction on screen is a lie. */
const OWED = person({ earned: 1240.5, paid: 1040.25, owed: 200.25 });
const AHEAD = person({ profileId: "p-2", name: "Dana Rook", earned: 800, paid: 1000, owed: -200 });
const SQUARE = person({ profileId: "p-3", name: "Theo Vance", earned: 500, paid: 500, owed: 0 });
const ON_CLOCK = person({ profileId: "p-4", name: "Casey Loam", earned: 300, paid: 0, owed: 300, hasOpenShift: true });

const payment = (over: Partial<PayPaymentRow> = {}): PayPaymentRow => ({
  id: "pay-1",
  profileId: "p-1",
  amount: 400,
  paidOn: "2026-09-28",
  method: "cash",
  reference: null,
  note: null,
  needsCheck: false,
  voided: false,
  ...over,
});

function statement(b: PersonBalance, over: Partial<Parameters<typeof PersonStatement>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(PersonStatement, {
      balance: b,
      periods: [],
      payments: [],
      onClock: b.hasOpenShift,
      pending: false,
      onRecord: () => {},
      onUndo: () => {},
      onConfirm: () => {},
      ...over,
    }),
  );
}

function board(over: Partial<Parameters<typeof PayrollView>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(PayrollView, {
      balances: [OWED],
      payments: [],
      nameById: { "p-1": "Sam Tillery" },
      ownersOnBoard: [],
      ownersOnFile: [],
      viewerId: "u-1",
      owedPeriods: {},
      openShifts: [],
      today: "2026-10-03",
      rows: [],
      period: { start: "2026-10-01", end: "2026-10-16" },
      offset: 0,
      settledMileage: {},
      frozenBase: {},
      ...over,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
describe("the figure rule, shared by the card and the statement", () => {
  it("a balance owing reads the figure to the cent", () => {
    expect(owedReading({ name: "Sam Tillery", owed: 200.25, onClock: false })).toEqual({
      kind: "owed",
      word: "Owed",
      amount: 200.25,
      line: "",
    });
  });

  it("paid ahead says the distance as a POSITIVE figure, and names the person", () => {
    const r = owedReading({ name: "Dana Rook", owed: -200, onClock: false });
    expect(r.kind).toBe("ahead");
    expect(r.amount).toBe(200);
    expect(r.line).toBe("Dana is $200 ahead. It comes off the next hours.");
  });

  it("square is Paid Up with no figure at all", () => {
    const r = owedReading({ name: "Theo Vance", owed: 0, onClock: false });
    expect(r.kind).toBe("square");
    expect(r.amount).toBeNull();
    expect(r.line).toBe("Theo is paid up.");
  });

  it("a shift still running withholds the figure: there is no number to print", () => {
    // A running shift pays nothing into `earned`, so any figure built on it is short that shift.
    const r = owedReading({ name: "Casey Loam", owed: 300, onClock: true });
    expect(r.kind).toBe("onClock");
    expect(r.word).toBe("On the clock");
    expect(r.amount).toBeNull();
  });

  it("money already paid against the open periods is the gap, not a second subtraction", () => {
    expect(alreadyAppliedTo([{ gross: 520 }, { gross: 892.5 }], 200.25)).toBe(1212.25);
    expect(alreadyAppliedTo([], 0)).toBe(0);
  });

  it("a write that never came back never claims the money did not save", () => {
    // recordPayment has no idempotency key, so a second call is a second row. "Nothing was saved"
    // would be a guess, and it is the guess that gets the same money handed over twice.
    const said = noAnswerSentence("Sam Tillery");
    expect(said).toContain("Sam");
    expect(said).toContain("may or may not have saved");
    expect(said).toContain("payments before recording it again");
    expect(said).not.toContain("nothing was saved");
    expect(said).not.toContain("Nothing was saved");
    expect(said).not.toContain("was saved.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a person's statement says Owed is Earned less Paid", () => {
  it("all three figures, to the cent, in that order", () => {
    const html = statement(OWED);
    expect(html).toContain("Owed Is Earned Less Paid");
    expect(html).toContain(">Earned<");
    expect(html).toContain("$1,240.50");
    expect(html).toContain(">Paid<");
    expect(html).toContain("$1,040.25");
    expect(html).toContain(">Owed<");
    expect(html).toContain("$200.25");
    expect(html.indexOf("$1,240.50")).toBeLessThan(html.indexOf("$1,040.25"));
    expect(html.indexOf("$1,040.25")).toBeLessThan(html.indexOf("$200.25"));
  });

  it("paid ahead: the third line is Ahead, and it says so in his own name", () => {
    const html = statement(AHEAD);
    expect(html).toContain(">Ahead<");
    expect(html).toContain("$800.00");
    expect(html).toContain("$1,000.00");
    expect(html).toContain("Dana is $200 ahead. It comes off the next hours.");
    // Never a minus figure drawn as if it were owed.
    expect(html).not.toContain("-$200");
    expect(html).not.toContain("$-200");
  });

  it("square: Paid Up, with no owed figure", () => {
    const html = statement(SQUARE);
    expect(html).toContain("Paid Up");
    expect(html).toContain("Theo is paid up.");
    // Earned and Paid are both $500.00; the Owed row adds no third copy.
    expect(count(html, "$500.00")).toBe(2);
  });

  it("on the clock: the statement withholds the owed figure, exactly as the card does", () => {
    const html = statement(ON_CLOCK);
    expect(html).toContain("On the clock");
    expect(html).toContain("A shift is still running, so the amount is not final.");
    // $300.00 is what he has EARNED. If the Owed row had drawn it too there would be two.
    expect(count(html, "$300.00")).toBe(1);
  });

  it("the open pay periods and what has already gone against them", () => {
    const html = statement(OWED, {
      periods: [
        { start: "2026-08-16", end: "2026-09-01", gross: 520 },
        { start: "2026-09-01", end: "2026-09-16", gross: 892.5 },
      ],
    });
    expect(html).toContain("Pay Periods Still Open");
    expect(html).toContain("Aug 16 to Aug 31");
    expect(html).toContain("$520.00");
    expect(html).toContain("$892.50");
    expect(html).toContain("Less $1,212.25 you have already paid against these.");
  });

  it("held mileage is its own line and is in none of the three figures", () => {
    const html = statement(person({ earned: 1240.5, paid: 1040.25, owed: 200.25, heldMiles: 42.3 }));
    expect(html).toContain("42.3 business miles are held and not settled.");
    // The three figures are untouched by miles: no combined number anywhere.
    expect(html).toContain("$200.25");
    expect(html).toContain("$1,240.50");
  });

  it("this person's payments, in full, each with its own Undo", () => {
    const html = statement(OWED, {
      payments: [payment(), payment({ id: "pay-2", amount: 150.75, paidOn: "2026-09-14", method: "check", voided: true })],
    });
    expect(html).toContain("Sep 28");
    expect(html).toContain("$400.00");
    expect(html).toContain("Sep 14");
    expect(html).toContain("$150.75");
    // A void never deletes, so the row stays and says so, and offers no actions.
    expect(html).toContain("voided");
    expect(count(html, "Undo")).toBe(1);
    // Inside his own statement a row does not repeat his name.
    expect(html).not.toContain("Sam Tillery");
  });

  it("no payments yet: it says so rather than drawing an empty box", () => {
    expect(statement(SQUARE)).toContain("No payment recorded for Theo yet.");
  });

  it("the long explanation is behind the info icon, as bullets, and nothing is cut", () => {
    const html = statement(OWED);
    expect(html).toContain('aria-label="About Earned, Paid And Owed"');
    // LABEL HONESTY: Earned is unlocked hours from the last 18 months plus every locked period.
    // The word must not be allowed to claim more than the reads behind it.
    const facts = THREE_FIGURES_FACTS.join(" ");
    expect(facts).toContain("18 months");
    expect(facts).toContain("Owed is Earned less Paid");
    expect(facts).toContain("locked");
    expect(facts).toContain("still running");
    expect(THREE_FIGURES_FACTS.length).toBeGreaterThanOrEqual(8);
  });

  it("ONE door to the pay form, at the foot of the statement", () => {
    expect(count(statement(OWED), "Record Payment…")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the board card is a disclosure, not the button that pays", () => {
  it("a person's row opens his statement: it carries no pay control of its own", () => {
    const html = board();
    expect(html).toContain('aria-expanded="false"');
    // Nothing on the board pays anybody, and nothing on it opens the form either.
    expect(html).not.toContain("Record Payment");
    expect(html).not.toContain("Pay Sam Tillery");
    expect(html).not.toContain("Amount You Paid");
    // The figure itself still reads, by the shared rule.
    expect(html).toContain("$200.25");
  });

  it("the page's two paragraphs of small print are gone, and every fact survived as a bullet", () => {
    const html = board();
    expect(html).not.toContain("Base pay only. Mileage settles separately below.");
    expect(html).not.toContain("Base pay is hours times pay rate.");
    expect(html).not.toContain("Your accountant handles");
    expect(html).toContain('aria-label="About What You Owe"');
    const facts = BASE_PAY_FACTS.join(" ");
    expect(facts).toContain("Base pay is hours times pay rate.");
    expect(facts).toContain("Mileage is never added into base pay");
    expect(facts).toContain("withholding");
  });

  it("Paid Recently names the person; it is the same row the statement draws", () => {
    const html = board({ payments: [payment()] });
    expect(html).toContain("Paid Recently");
    expect(html).toContain("Sep 28 · Sam Tillery · $400.00 · cash");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the form that records a payment", () => {
  function sheet(over: Partial<Parameters<typeof PaySheet>[0]> = {}) {
    return renderToStaticMarkup(
      createElement(PaySheet, {
        person: OWED,
        periods: [{ start: "2026-09-01", end: "2026-09-16", gross: 892.5 }],
        onClock: false,
        today: "2026-10-03",
        saving: false,
        error: null,
        onCancel: () => {},
        onSubmit: () => {},
        ...over,
      }),
    );
  }

  it("opens empty: no amount, and Record cannot be pressed", () => {
    const html = sheet();
    const at = html.indexOf('id="pay-amount"');
    expect(at).toBeGreaterThan(-1);
    const field = html.slice(html.lastIndexOf("<input", at), html.indexOf(">", at) + 1);
    // The app never invents a paycheck figure — not even the balance it is showing above.
    expect(field).toContain('value=""');
    expect(html).not.toContain('value="200.25"');
    // Record is dead until a figure is typed, and it does not yet claim an amount.
    const save = html.lastIndexOf("<button");
    expect(html.slice(save)).toContain("disabled");
    expect(html).toContain(">Record Payment<");
    expect(html).not.toContain("Record $");
  });

  it("it is still the same form: the balance it is going against, and the open period", () => {
    const html = sheet();
    expect(html).toContain("Pay Sam Tillery");
    expect(html).toContain("Owed $200.25");
    expect(html).toContain("Sep 1 to Sep 15 $892.50");
    expect(html).toContain("Less $692.25 you have already paid against these.");
  });

  it("a refusal from the server is drawn inside the form, over the typed figure", () => {
    expect(sheet({ error: "That pay period could not be locked." })).toContain("That pay period could not be locked.");
  });

  it("the paragraph under the fields is one line plus bullets, and nothing is cut", () => {
    const html = sheet();
    expect(html).toContain("It pays off whole pay periods, oldest first.");
    expect(html).toContain('aria-label="About How A Payment Lands"');
    expect(html).not.toContain("so a half paid week stays open until the rest of it is paid");
    const facts = PAYMENT_LANDS_FACTS.join(" ");
    expect(facts).toContain("A half paid week stays open until the rest of it is paid.");
    expect(facts).toContain("never fills it in");
  });
});
