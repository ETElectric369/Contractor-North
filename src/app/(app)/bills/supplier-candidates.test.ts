import { describe, it, expect } from "vitest";
import { suggestSupplierGroups } from "@/lib/supplier-identity";
import {
  candidateJoinedOwed,
  candidateMoving,
  supplierCandidateQuestions,
  type SupplierBookEntry,
  type SupplierSpelling,
} from "./supplier-balance";

/**
 * THE ONE QUESTION ON HIS REAL BOOK, AND THE RULES THAT KEEP IT HONEST.
 *
 * cn-v963 shipped and Erik used it: four supplier accounts, four real payments against CED, and the
 * duplicate ticket resolved onto 85 Whitney Place. His CED balance reads $6,476.93 and reconciles
 * to the penny. One question was left over and the page was throwing it away - "Contractors
 * Electrical Distributors" ($467.87, unpaid) against his four "Consolidated Electrical ..."
 * spellings, which reduce to the same initials and differ in their first word.
 *
 * THE ANSWER IS IN THESE FIXTURES AND NOWHERE IN THE APP. He told us it is the same account:
 * "its the local distributor near sunnyvale for the job so i used my truckee account number, thats
 * how they roll". So the arithmetic below says $6,476.93 + $467.87 = $6,944.80 - but the app must
 * still ask, because the only place that fact exists is in his head.
 */

const CED_SPELLINGS = [
  "Consolidated Electrical Distributors, Inc. (CED)",
  "Consolidated Electrical Dist.",
  "Consolidated Electrical Distributors, Inc.",
  "Consolidated Electrical Distributors",
  "CED",
];

const SUNNYVALE = "Contractors Electrical Distributors";

/** The book as it stands tonight: one CED account owing $6,476.93 under five spellings, and the
 *  Sunnyvale ticket on no account at all. */
function hisBook() {
  const unfiled = new Map<string, SupplierSpelling>([
    [SUNNYVALE.toLowerCase(), { alias: SUNNYVALE, bills: 1, total: 467.87, unpaid: 467.87 }],
  ]);
  const account: SupplierBookEntry = { id: "acct-ced", name: "CED Truckee", owed: 6476.93 };
  const accounts = new Map<string, SupplierBookEntry>([
    ["ced truckee", account],
    ...CED_SPELLINGS.map((s) => [s.toLowerCase(), account] as const),
  ]);
  // Exactly what the page feeds the matcher: every unfiled spelling, then every account name and
  // every spelling already saved on one.
  const names = [SUNNYVALE, "CED Truckee", ...CED_SPELLINGS];
  return { unfiled, accounts, names };
}

describe("the question the matcher will not answer", () => {
  it("asks about Sunnyvale against the CED account, and about nothing else", () => {
    const book = hisBook();
    const questions = supplierCandidateQuestions(suggestSupplierGroups(book.names).candidates, book);

    expect(questions).toHaveLength(1);
    const q = questions[0];
    expect(q.sides.map((s) => s.label).sort()).toEqual(["CED Truckee", SUNNYVALE]);
    expect(q.because).toMatch(/CED/i);
  });

  it("shows the money on both sides and what one account would owe", () => {
    const book = hisBook();
    const [q] = supplierCandidateQuestions(suggestSupplierGroups(book.names).candidates, book);

    const loose = q.sides.find((s) => !s.accountId);
    const filed = q.sides.find((s) => s.accountId);
    expect(loose?.unpaid).toBe(467.87);
    expect(loose?.bills).toBe(1);
    expect(filed?.owed).toBe(6476.93);

    // His own number, plus the ticket he charged to his Truckee account at a Sunnyvale counter.
    expect(candidateJoinedOwed(q)).toBe(6944.8);
  });

  it("hands both doors the loose spelling only, never the account he already built", () => {
    const book = hisBook();
    const [q] = supplierCandidateQuestions(suggestSupplierGroups(book.names).candidates, book);

    // "Keep Them Separate" gives every spelling it is handed an account of its own. Put a spelling
    // that is currently an alias of CED Truckee in this id and that press would tear it straight
    // off the account he built tonight, taking its bills with it.
    expect(candidateMoving(q).map((s) => s.spelling)).toEqual([SUNNYVALE]);
    expect(q.id).toBe(`merge:${JSON.stringify([SUNNYVALE])}`);
    expect(q.existingAccountId).toBe("acct-ced");
    expect(q.existingAccountName).toBe("CED Truckee");
    for (const spelling of CED_SPELLINGS) expect(q.id).not.toContain(spelling);
  });

  it("stops asking once he has answered, whichever way he answered", () => {
    const book = hisBook();
    const candidates = suggestSupplierGroups(book.names).candidates;

    // NOTHING RECORDS "HE SAID NO". A dismissal sticks by becoming true: the bills land on an
    // account of their own, so the spelling leaves the unfiled pile. The matcher still sees both
    // names - it reads account names too - so without the no-loose-side rule the question he just
    // answered would be waiting for him on the next page load.
    const answered = {
      unfiled: new Map<string, SupplierSpelling>(),
      accounts: new Map<string, SupplierBookEntry>([
        ...book.accounts,
        [SUNNYVALE.toLowerCase(), { id: "acct-sunnyvale", name: SUNNYVALE, owed: 467.87 }],
      ]),
    };
    expect(supplierCandidateQuestions(candidates, answered)).toEqual([]);

    // And the same is true of joining: the spelling becomes an alias of CED Truckee.
    const joined = {
      unfiled: new Map<string, SupplierSpelling>(),
      accounts: new Map<string, SupplierBookEntry>([
        ...book.accounts,
        [SUNNYVALE.toLowerCase(), { id: "acct-ced", name: "CED Truckee", owed: 6944.8 }],
      ]),
    };
    expect(supplierCandidateQuestions(candidates, joined)).toEqual([]);
  });

  it("drops a pair it knows nothing about rather than asking about half of it", () => {
    const questions = supplierCandidateQuestions([{ a: "Ace Hardware", b: "Ace Rentals", reasons: ["thin"] }], {
      unfiled: new Map([["ace hardware", { alias: "Ace Hardware", bills: 2, total: 80, unpaid: 0 }]]),
      accounts: new Map(),
    });
    expect(questions).toEqual([]);
  });
});

describe("two loose spellings, with no account on either side", () => {
  const both = () => ({
    unfiled: new Map<string, SupplierSpelling>([
      ["ace hardware", { alias: "Ace Hardware", bills: 2, total: 120.5, unpaid: 80.25 }],
      ["ace rentals", { alias: "Ace Rentals", bills: 1, total: 60, unpaid: 60 }],
    ]),
    accounts: new Map<string, SupplierBookEntry>(),
  });

  it("offers to make one new account and suggests the fuller spelling for it", () => {
    const [q] = supplierCandidateQuestions(
      [{ a: "Ace Hardware", b: "Ace Rentals", reasons: ["Both start with \"Ace\" and then differ."] }],
      both(),
    );
    expect(q.existingAccountId).toBeNull();
    expect(q.suggestedName).toBe("Ace Hardware");
    expect(candidateMoving(q)).toHaveLength(2);
    expect(candidateJoinedOwed(q)).toBe(140.25);
  });
});

describe("a supplier he pays at the register has no balance to add to", () => {
  it("offers no joined figure rather than inventing one", () => {
    const [q] = supplierCandidateQuestions([{ a: "Goodwins", b: "Goodwin's Hardware", reasons: ["same words"] }], {
      unfiled: new Map([["goodwins", { alias: "Goodwins", bills: 1, total: 42.18, unpaid: 42.18 }]]),
      accounts: new Map([
        ["goodwin's hardware", { id: "acct-goodwins", name: "Goodwin's Hardware", owed: null }],
      ]),
    });
    expect(q.existingAccountName).toBe("Goodwin's Hardware");
    expect(candidateJoinedOwed(q)).toBeNull();
  });
});
