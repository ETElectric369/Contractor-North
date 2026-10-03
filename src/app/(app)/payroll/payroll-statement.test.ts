import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { BASE_PAY_FACTS, HELD_MILEAGE_FACTS, PAYMENT_LANDS_FACTS, THREE_FIGURES_FACTS } from "./payroll-facts";
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

/** The pay period the page is showing in every fixture below: Oct 1 to Oct 15, with today Oct 3. */
const VIEWED = { start: "2026-10-01", end: "2026-10-16" };

function statement(b: PersonBalance, over: Partial<Parameters<typeof PersonStatement>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(PersonStatement, {
      balance: b,
      periods: [],
      heldMileage: [],
      period: VIEWED,
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
      heldMileage: {},
      openShifts: [],
      today: "2026-10-03",
      rows: [],
      period: VIEWED,
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
    const html = statement(person({ earned: 1240.5, paid: 1040.25, owed: 200.25, heldMiles: 42.3 }), {
      heldMileage: [{ ...VIEWED, miles: 42.3, offset: 0 }],
    });
    expect(html).toContain("42.3 business miles are held and not settled.");
    // The three figures are untouched by miles: no combined number anywhere.
    expect(html).toContain("$200.25");
    expect(html).toContain("$1,240.50");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * ── THE HELD-MILES LINE SAYS ITS OWN SCOPE, AND HANDS OVER A DOOR ─────────────────────────────
 *
 * THE DEFECT THESE PIN. The figure is balanceForPerson's heldMiles: every unsettled business mile in
 * the 18-month window. The Mileage block it used to point "below" at is ONE pay period, because
 * settleMileage stamps one pay period at a time. So the morning after a period rolled over, the
 * statement said "30.0 business miles are held and not settled. Mileage is settled on its own below"
 * and the block below said "No miles logged in this pay period" — no period named, no way to reach
 * the one that had them, and with several unsettled periods two different "held" figures on one
 * screen that no reader could reconcile.
 */
describe("held mileage says WHICH pay period holds it", () => {
  const SEP_LATE = { start: "2026-09-16", end: "2026-10-01" }; // offset 1 from Oct 1-15
  const AUG_LATE = { start: "2026-08-16", end: "2026-09-01" }; // offset 3

  it("miles held outside the viewed period say so, and never send him 'below' to a block that has none", () => {
    const html = statement(person({ earned: 900, paid: 0, owed: 900, heldMiles: 30 }), {
      heldMileage: [{ ...SEP_LATE, miles: 30, offset: 1 }],
    });
    expect(html).toContain("30.0 business miles are held and not settled.");
    // THE SENTENCE THAT WAS FALSE. The block below cannot hold these, so it must not be pointed at.
    expect(html).not.toContain("Mileage is settled on its own below");
    expect(html).toContain("None of them are in Oct 1 to Oct 15, the pay period in view.");
    // AND A REAL DOOR: the period is named and opening it is one tap, not a hunt through the pager.
    expect(html).toContain('href="/payroll?period=1"');
    expect(html).toContain("Sep 16 to Sep 30");
    expect(html).toContain("30.0 mi held");
  });

  it("miles held inside the viewed period are the ones the block below really has", () => {
    const html = statement(person({ earned: 900, paid: 0, owed: 900, heldMiles: 12.3 }), {
      heldMileage: [{ ...VIEWED, miles: 12.3, offset: 0 }],
    });
    expect(html).toContain("12.3 business miles are held and not settled. 12.3 of them are in Oct 1 to Oct 15, in Mileage below.");
    // Nothing is held anywhere else, so there is no door to draw — and none to the period in view,
    // which is already on this page.
    expect(html).not.toContain("/payroll?period=");
  });

  it("some here and some older: ONE screen reconciles the figure, with a door per period", () => {
    const html = statement(person({ earned: 2000, paid: 0, owed: 2000, heldMiles: 72.3 }), {
      heldMileage: [
        { ...AUG_LATE, miles: 30, offset: 3 },
        { ...SEP_LATE, miles: 30, offset: 1 },
        { ...VIEWED, miles: 12.3, offset: 0 },
      ],
    });
    // 72.3 held, 12.3 of them below: the other 60 are accounted for by the two doors, to the tenth.
    expect(html).toContain("72.3 business miles are held and not settled. 12.3 of them are in Oct 1 to Oct 15, in Mileage below.");
    expect(html).toContain('href="/payroll?period=3"');
    expect(html).toContain('href="/payroll?period=1"');
    expect(html).toContain("Aug 16 to Aug 31");
    // Oldest first, so the one that has waited longest is the one he reaches first.
    expect(html.indexOf("Aug 16 to Aug 31")).toBeLessThan(html.indexOf("Sep 16 to Sep 30"));
    // The period in view is not a door: it is the block further down this same page.
    expect(html).not.toContain('href="/payroll?period=0"');
    expect(count(html, "/payroll?period=")).toBe(2);
  });

  it("a pay period the pager cannot reach is STATED, never drawn as a door onto the wrong one", () => {
    // Forward-dated hours: payPeriodOffsetOf has no non-negative offset for them.
    const html = statement(person({ earned: 900, paid: 0, owed: 900, heldMiles: 18 }), {
      heldMileage: [{ start: "2026-10-16", end: "2026-11-01", miles: 18, offset: null }],
    });
    expect(html).toContain("18.0 business miles are held and not settled.");
    expect(html).toContain("Oct 16 to Oct 31");
    expect(html).toContain("18.0 mi held");
    expect(html).not.toContain("/payroll?period=");
  });

  it("no held miles, no line: zero means nothing is drawn at all", () => {
    const html = statement(SQUARE);
    expect(html).not.toContain("business miles are held");
    expect(html).not.toContain("mi held");
  });

  it("the scope rule is explained behind the info icon, as bullets, and nothing is cut", () => {
    const html = statement(person({ earned: 900, paid: 0, owed: 900, heldMiles: 30 }), {
      heldMileage: [{ ...SEP_LATE, miles: 30, offset: 1 }],
    });
    expect(html).toContain('aria-label="About Held Mileage"');
    const facts = HELD_MILEAGE_FACTS.join(" ");
    // The two facts whose absence was the defect: the block's scope, and the figure's.
    expect(facts).toContain("one pay period at a time");
    expect(facts).toContain("only the pay period you are looking at");
    expect(facts).toContain("however old the pay period");
    // And the bucket rule it already carried.
    expect(facts).toContain("in none of Earned, Paid or Owed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * ── THE PAY DOOR IS NOT AT THE BOTTOM OF EVERY PAYMENT HE HAS EVER HAD ────────────────────────
 *
 * THE DEFECT THIS PINS. The statement listed every payment the person had ever received and put the
 * ONLY door to the pay form after the last of them. A year of weekly pay is 52 rows at 69px, so the
 * door sat about 3,500px down — and every row on the way carries a one-tap Undo that voids a payment
 * and can unlock a pay period with no confirm. The way to the button that pays a man should not run
 * through fifty ways to unpay him.
 */
describe("the payment list has a floor under it", () => {
  const many = (n: number, over: (i: number) => Partial<PayPaymentRow> = () => ({})) =>
    Array.from({ length: n }, (_, i) => payment({ id: `pay-${i + 1}`, amount: 100 + i, ...over(i) }));

  it("six rows, then a fold: the rest are one tap away, not a scroll past the pay door", () => {
    const html = statement(OWED, { payments: many(10) });
    const fold = html.indexOf("Show 4 Older Payments");
    expect(fold).toBeGreaterThan(-1);
    // SIX Undos between the top of the statement and the fold, not ten.
    expect(count(html.slice(0, fold), "Undo")).toBe(6);
    // And not one of the ten is unreachable: the other four are inside the fold.
    expect(count(html, "Undo")).toBe(10);
    // Still exactly one door to the form, still at the foot (the second-tap guard is untouched).
    expect(count(html, "Record Payment…")).toBe(1);
    expect(html.indexOf("Record Payment…")).toBeGreaterThan(fold);
  });

  it("the fold counts what is HIDDEN, never how many he has ever been paid", () => {
    expect(statement(OWED, { payments: many(7) })).toContain("Show 1 Older Payment");
    expect(statement(OWED, { payments: many(8) })).toContain("Show 2 Older Payments");
    // Six or fewer: no fold at all, because there is nothing behind it.
    const six = statement(OWED, { payments: many(6) });
    expect(six).not.toContain("Older Payment");
    expect(count(six, "Undo")).toBe(6);
  });

  it("a payment still waiting to be checked is never folded away", () => {
    // The amber banner at the top of /payroll sends him down to confirm it; a cap that hid the only
    // "That's Right" there is would leave that banner pointing at nothing.
    const html = statement(OWED, { payments: many(10, (i) => (i === 8 ? { needsCheck: true } : {})) });
    const fold = html.indexOf("Show");
    expect(fold).toBeGreaterThan(-1);
    expect(html.slice(0, fold)).toMatch(/That(&#x27;|')s Right/);
    expect(html.slice(fold)).not.toMatch(/That(&#x27;|')s Right/);
    // It was pulled UP past the cap, not drawn twice.
    expect(count(html, "s Right")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a payment row inside a statement, and the one door at the foot", () => {
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

// ─────────────────────────────────────────────────────────────────────────────
/**
 * ── WHAT A WRITE DOES WHEN NOBODY IS LOOKING AT THE TOP OF THE PAGE ───────────────────────────
 *
 * TWO DEFECTS, BOTH OF THEM GEOMETRY RATHER THAN A MISSING MESSAGE, AND BOTH ABOUT MONEY.
 *
 *  · THE ANSWER LANDED OFF SCREEN. The banner is at the top of the page; the only door to the pay form
 *    is at the FOOT of an open statement, past that person's payment list. A good write closed the
 *    sheet, set the sentence and scrolled nothing — so "Aug 16 to Aug 31 could not be locked yet…
 *    Close it on Timecards", and every refusal from Undo or That's Right, landed hundreds of pixels
 *    above the top of the screen. The tap looked dead.
 *  · THE RECORD BUTTON CAME BACK LIVE OVER THE SAME FIGURE. The catch said "it may or may not have
 *    saved", then `finally { setBusy(null) }` dropped `saving` and re-armed "Record $400.00 Paid" with
 *    $400 still typed. recordPayment has no idempotency key and pay_payments has no unique index that
 *    applies, so one more tap was a second row — $800 on the books for one payment.
 *
 * These read the SOURCE because neither is a prop: the first is a DOM act and the second is a state
 * transition, and the suite renders with renderToStaticMarkup (no DOM, nothing to click). The repo
 * reads source for exactly this, in money-doors-off-line.test.ts and a dozen others.
 */
describe("the answer lands where his thumb is, and a lost answer disarms the button", () => {
  const view = readFileSync(join(process.cwd(), "src/app/(app)/payroll/payroll-view.tsx"), "utf8");
  /** submitPay on its own: `run()` has an `if (!res.ok)` of its own, so a match over the whole file
   *  would be reading the wrong write path. */
  const submitPay = view.slice(view.indexOf("function submitPay"), view.indexOf("function submitSettle"));

  it("the banner is brought into view whenever the page says something", () => {
    expect(view).toContain('answerRef.current?.scrollIntoView({ block: "center" });');
    // BOTH answers carry the ref — a refusal and a confirmation are drawn in different places — and
    // they are mutually exclusive, so whichever is on screen is the one that moves.
    expect(count(view, "ref={answerRef}")).toBe(2);
    expect(view).toContain('role="alert"');
    expect(view).toContain('role="status"');
    // IT WATCHES A COUNTER, NOT THE SENTENCE. `error` is a plain string, so an identical second
    // refusal would not re-fire an effect keyed on the text — and the second press is exactly when he
    // is scrolled away from the banner and needs it brought back.
    expect(view).toMatch(/useEffect\(\(\) => \{[\s\S]{0,400}?answerRef\.current\?\.scrollIntoView[\s\S]{0,80}?\}, \[answerSeq\]\)/);
    // EVERY way the page speaks goes through the two counted helpers, so a new write path cannot
    // quietly set a banner that never moves.
    expect(view).not.toMatch(/setDone\(\{\s*text:/);
    expect(view).not.toMatch(/setError\(res\./);
  });

  it("a write that never answered closes the form, so the typed figure cannot be sent again", () => {
    const catchBlock = submitPay.slice(submitPay.indexOf("} catch {"), submitPay.indexOf("} finally {"));
    expect(catchBlock).toContain("noAnswerSentence(person.name)");
    // THE GUARD: the sheet is gone, so there is no live Record button over the amount he typed. A
    // REFUSAL still keeps it open — that one says the row is NOT there and retyping is pure loss.
    expect(catchBlock).toContain("closePay();");
    // And the list the sentence sends him to is re-read, so it shows whether the first one landed.
    expect(catchBlock).toContain("router.refresh();");
    // The refusal branch above it is untouched: a server that says "not saved" leaves the form open
    // over the figure, because retyping an off number from memory is the thing this page exists to end.
    const refusal = submitPay.match(/if \(!res\.ok\) \{[\s\S]*?\n {8}\}/)?.[0] ?? "";
    expect(refusal).toContain("sayRefused(");
    expect(refusal).not.toContain("closePay()");
  });

  it("one write at a time, enforced by a ref: `pending` is not set soon enough to stop a second press", () => {
    expect(view).toContain("const paying = useRef(false);");
    // The guard and the flip are both BEFORE the await, which is the only place they can work.
    expect(submitPay).toContain("if (paying.current) return;");
    expect(submitPay.indexOf("paying.current = true;")).toBeLessThan(submitPay.indexOf("await recordPayment"));
    expect(submitPay).toContain("paying.current = false;");
  });

  it("the ONE rule for what a payment list may hide is shared, not written out twice", () => {
    // Paid Recently had this hand-written; the statement needed the same promise. Two copies is how
    // one of them loses the still-unchecked payment that the amber banner points at.
    expect(view).toContain("paymentsToShow(payments, RECENT_LIMIT)");
    expect(view).not.toMatch(/needsCheck\.filter\(\(p\) => !newest/);
    const stmt = readFileSync(join(process.cwd(), "src/app/(app)/payroll/person-statement.tsx"), "utf8");
    expect(stmt).toContain("paymentsToShow(payments, STATEMENT_PAYMENTS)");
  });
});
