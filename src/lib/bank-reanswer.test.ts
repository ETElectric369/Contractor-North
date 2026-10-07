import { describe, expect, it } from "vitest";
import {
  bandHolding,
  bandHolds,
  bandWithout,
  REANSWER_TO,
  REANSWER_TO_PAYMENT,
  REANSWER_UNKNOWN,
  reanswerOffers,
  reanswerRefusal,
  sayBankLine,
  sayLineDay,
  sayReanswer,
  sayRuleChange,
} from "./bank-reanswer";
import { answerOfStored, choiceId, sayBand, sortedLinesOf, teachesNoRule, type BankNames } from "./bank-download";

/**
 * CHANGE ANSWER, THE PURE HALF (correction door B, 2026-10-07): which answers a counted bank line may be
 * changed TO, the band a rule keeps once one of its lines says something else, and the sentence. Every
 * figure and name here is made up.
 */

describe("the answers a line may be changed to", () => {
  it("are the eight that write nothing or one paid bill", () => {
    expect([...REANSWER_TO]).toEqual(["cost", "job", "draw", "cash_out", "not_cost", "not_income", "owner_in", "other_income"]);
    for (const id of ["cost:Auto", "job:job-1", "draw", "cash_out", "not_cost", "not_income", "owner_in", "other_income"]) {
      expect(reanswerRefusal(id), id).toBeNull();
      expect(reanswerOffers(id), id).toBe(true);
    }
    // The stored word for Cash Taken Out, and the retired word for Owner's Draw, are the same answers.
    expect(reanswerRefusal("petty_cash")).toBeNull();
    expect(reanswerRefusal("personal")).toBeNull();
  });

  it("refuses every payment answer in the one sentence, with the one road that does it today", () => {
    for (const id of ["matched", "supplier:acct-1", "crew:pat", "invoice:inv-1"]) {
      expect(reanswerRefusal(id), id).toBe(REANSWER_TO_PAYMENT);
      expect(reanswerOffers(id), id).toBe(false);
    }
    expect(REANSWER_TO_PAYMENT).toBe("Changing a line to a payment answer isn't a one-line change yet: Undo the download and apply it again.");
  });

  it("refuses a word no line can hold", () => {
    expect(reanswerRefusal("")).toBe(REANSWER_UNKNOWN);
    expect(reanswerRefusal("salary")).toBe(REANSWER_UNKNOWN);
    expect(reanswerRefusal(null)).toBe(REANSWER_UNKNOWN);
  });
});

describe("the band a rule keeps once one of its lines says something else", () => {
  // The made-up transfer rule: four deposits answered Not Income, $550 to $5,000.
  const rule = { minCents: 55_000, maxCents: 500_000 };

  it("narrows to the surviving answers it holds", () => {
    // The $5,000 line was the owner's own money: the $2,000, $550 and $1,000 lines still say Not Income.
    expect(bandWithout(rule, [200_000, 55_000, 100_000])).toEqual({ kind: "band", minCents: 55_000, maxCents: 200_000 });
    // Either sign reads as its size.
    expect(bandWithout(rule, [-200_000, -55_000])).toEqual({ kind: "band", minCents: 55_000, maxCents: 200_000 });
  });

  it("is gone when no answer survives", () => {
    expect(bandWithout(rule, [])).toEqual({ kind: "gone" });
    expect(bandWithout({ minCents: 1_331, maxCents: 1_331 }, [])).toEqual({ kind: "gone" });
  });

  it("stays the same when the survivors still reach both ends", () => {
    expect(bandWithout(rule, [55_000, 500_000, 120_000])).toEqual({ kind: "same" });
  });

  it("never widens: a surviving line outside the band is not one it was taught by", () => {
    // Forgotten and learned again at $200-$300: the old $50 line does not drag it back down.
    expect(bandWithout({ minCents: 20_000, maxCents: 30_000 }, [5_000, 25_000])).toEqual({ kind: "band", minCents: 25_000, maxCents: 25_000 });
    expect(bandWithout({ minCents: 20_000, maxCents: 30_000 }, [5_000, 90_000])).toEqual({ kind: "gone" });
  });

  it("a rule for every amount takes the survivors' band, as Apply would have given it", () => {
    expect(bandWithout({ minCents: null, maxCents: null }, [4_000, 9_000])).toEqual({ kind: "band", minCents: 4_000, maxCents: 9_000 });
  });

  it("the new answer's rule widens to hold the amount, and only when it doesn't already", () => {
    expect(bandHolding({ minCents: 12_000, maxCents: 13_862 }, -1_331)).toEqual({ minCents: 1_331, maxCents: 13_862 });
    expect(bandHolding({ minCents: 12_000, maxCents: 13_862 }, 50_000)).toEqual({ minCents: 12_000, maxCents: 50_000 });
    expect(bandHolding({ minCents: 12_000, maxCents: 13_862 }, -12_500)).toBeNull();
    expect(bandHolding({ minCents: null, maxCents: null }, 99)).toBeNull();
    expect(bandHolds({ minCents: 100, maxCents: 200 }, -150)).toBe(true);
    expect(bandHolds({ minCents: 100, maxCents: 200 }, 250)).toBe(false);
  });
});

describe("what it says", () => {
  it("names the line by its day and words, a check by its number", () => {
    expect(sayLineDay("2026-06-03", "2026-10-07")).toBe("June 3");
    expect(sayLineDay("2025-12-30", "2026-10-07")).toBe("December 30, 2025");
    expect(sayBankLine({ postedOn: "2026-06-08", description: "CHECK", check: "1003", cents: -136_000 }, "2026-10-07")).toBe("June 8 Check 1003");
    expect(sayBankLine({ postedOn: "2026-06-03", description: "TRANSFER FROM 9876", check: null, cents: 500_000 }, "2026-10-07")).toBe("June 3 TRANSFER FROM 9876");
  });

  it("one sentence: the new answer, then the rule, in the card's own words", () => {
    const narrowed = sayRuleChange({ kind: "narrowed", said: "Already Counted Or Not Income", band: sayBand({ minCents: 55_000, maxCents: 200_000 }) });
    expect(narrowed).toBe("The rule that said Already Counted Or Not Income now covers $550.00 to $2,000.00.");
    expect(sayReanswer({ line: "June 3 TRANSFER FROM 9876", answer: "Owner's Money In", rules: [{ kind: "narrowed", said: "Already Counted Or Not Income", band: "$550.00 to $2,000.00" }] })).toBe(
      "June 3 TRANSFER FROM 9876 is now Owner's Money In. The rule that said Already Counted Or Not Income now covers $550.00 to $2,000.00.",
    );
  });

  it("says what happened to the money, and to every rule, gone or widened", () => {
    expect(
      sayReanswer({
        line: "June 8 Check 1003",
        answer: "Business Cost · Auto",
        money: ["Its crew payment stays void.", "A paid bill of $1,360.00 is on the books for it."],
        rules: [
          { kind: "gone", said: "Other" },
          { kind: "widened", said: "Fuel", band: "$13.31 to $138.62" },
        ],
      }),
    ).toBe(
      "June 8 Check 1003 is now Business Cost · Auto. Its crew payment stays void. A paid bill of $1,360.00 is on the books for it. The rule that said Other is gone: no other line was answered that way. The rule for Fuel now covers $13.31 to $138.62.",
    );
  });

  it("a line that already says it: nothing changed, unless a rule still said the old answer", () => {
    expect(sayReanswer({ line: "June 3 TRANSFER FROM 9876", answer: "Owner's Money In", already: true })).toBe("June 3 TRANSFER FROM 9876 already says Owner's Money In. Nothing was changed.");
    expect(sayReanswer({ line: "June 3 TRANSFER FROM 9876", answer: "Owner's Money In", already: true, rules: [{ kind: "narrowed", said: "Already Counted Or Not Income", band: "$550.00 to $2,000.00" }] })).toBe(
      "June 3 TRANSFER FROM 9876 already says Owner's Money In. The rule that said Already Counted Or Not Income now covers $550.00 to $2,000.00.",
    );
  });

  it("a rule that couldn't be changed is said, with where to see it", () => {
    expect(sayRuleChange({ kind: "failed", said: "Fuel", why: "it was changed from another screen" })).toBe(
      "The rule that said Fuel wasn't changed (it was changed from another screen); forget it under See How It Sorted if it is wrong now.",
    );
    expect(sayRuleChange({ kind: "unread", why: "timeout" })).toMatch(/^This merchant's remembered answers couldn't be read \(timeout\), so none was changed/);
  });
});

describe("the stored answer, read back", () => {
  it("is storedAnswer turned round, and a matched line holds none", () => {
    expect(answerOfStored({ choice: "matched" })).toBeNull();
    expect(choiceId(answerOfStored({ choice: "cost", bucket: "Auto" })!)).toBe("cost:Auto");
    expect(choiceId(answerOfStored({ choice: "petty_cash" })!)).toBe("cash_out");
    expect(choiceId(answerOfStored({ choice: "crew", profile_id: "pat" })!)).toBe("crew:pat");
    expect(choiceId(answerOfStored({ choice: "job", job_id: "job-1" })!)).toBe("job:job-1");
    expect(choiceId(answerOfStored({ choice: "owner_in" })!)).toBe("owner_in");
    // A bucket that is no longer one reads as no answer, never as a different one.
    expect(answerOfStored({ choice: "cost", bucket: "Gas & Truck" })).toBeNull();
  });

  it("a line that could never teach a rule is told apart the same way the plan tells it", () => {
    expect(teachesNoRule({ cents: -136_000, description: "CHECK", merchantKey: "check", check: "1003" })).toBe(true);
    // A check going out is a row of its own even when it names a payee.
    expect(teachesNoRule({ cents: -5_000, description: "ACME INSURANCE", merchantKey: "acme insurance", check: "1004" })).toBe(true);
    expect(teachesNoRule({ cents: 127_500, description: "DEPOSIT", merchantKey: "deposit", check: null })).toBe(true);
    expect(teachesNoRule({ cents: 500_000, description: "ONLINE TRANSFER FROM CHK ••9876", merchantKey: "transfer 9876", check: null })).toBe(false);
    expect(teachesNoRule({ cents: -8_845, description: "SHELL 123 ANYTOWN", merchantKey: "shell", check: null })).toBe(false);
  });
});

describe("the card's Sorted Lines", () => {
  const names: BankNames = { accounts: new Map(), crew: new Map([["pat", "Pat Crew"]]), invoices: new Map([["inv-1", "INV-1001"]]), jobs: new Map([["job-1", "41 Larkspur · J-054 — Marla Finch"]]) };
  const row = (over: Record<string, unknown>) => ({
    id: "l",
    posted_on: "2026-09-02",
    amount: -88.45,
    description: "SHELL 123 ANYTOWN",
    check_number: null,
    choice: "cost",
    bucket: "Fuel",
    supplier_account_id: null,
    profile_id: null,
    invoice_id: null,
    sorted_by: "person",
    ...over,
  });

  it("lists each counted line oldest first, said the way the card says an answer", () => {
    const { lines, more } = sortedLinesOf(
      [
        row({ id: "c", posted_on: "2026-09-05", amount: -640, description: "CHECK", check_number: "1043", choice: "crew", bucket: null, profile_id: "pat" }),
        row({ id: "a" }),
        row({ id: "d", posted_on: "2026-09-04", amount: 1275, description: "DEPOSIT", choice: "matched", bucket: null, sorted_by: "match" }),
        row({ id: "r", posted_on: "2026-09-13", amount: 30, description: "ACME TOOLS RETURN", bucket: "Tools & Supplies", sorted_by: "rule" }),
        row({ id: "j", posted_on: "2026-09-12", amount: -340.55, description: "ANYTOWN WIRE HOUSE", choice: "job", bucket: null, job_id: "job-1" }),
      ],
      names,
      "2026-10-07",
    );
    expect(more).toBe(0);
    expect(lines.map((l) => [l.day, l.title, l.money, l.direction, l.answer, l.by, l.current])).toEqual([
      ["Sep 2", "SHELL 123 ANYTOWN", "$88.45", "out", "Fuel", "Answered By You", "cost:Fuel"],
      ["Sep 4", "DEPOSIT", "$1,275.00", "in", "Already In North (Matched)", "Matched", null],
      ["Sep 5", "Check 1043", "$640.00", "out", "Pay Pat Crew", "Answered By You", "crew:pat"],
      ["Sep 12", "ANYTOWN WIRE HOUSE", "$340.55", "out", "On 41 Larkspur · J-054 — Marla Finch", "Answered By You", "job:job-1"],
      ["Sep 13", "ACME TOOLS RETURN", "$30.00", "in", "Refund: Tools & Supplies", "By Your Rule", "cost:Tools & Supplies"],
    ]);
  });
});
