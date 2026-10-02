import { describe, expect, it } from "vitest";
import {
  BILL_DELETED_SAID,
  billCategoryFor,
  cardSentence,
  describePaper,
  fileRefusal,
  findSameNumber,
  firstAnswer,
  paperKindWords,
  paperSays,
  sameMoneyFromBank,
  guessOf,
  isPicture,
  isLinelessReturn,
  isReturnWithoutLines,
  jobFromPaperMarks,
  linesPointWithTotal,
  RETURN_NEEDS_LINES,
  normalizeDocNumber,
  NOT_FILED_YET,
  parseDestination,
  pickedBecause,
  readinessOf,
  addressInHint,
  rematchPaper,
  shownDestination,
  streetKey,
  suggestedDestination,
  type MarkJob,
  type PaperItem,
} from "./paperwork";
import { indexSupplierAliases } from "./supplier-identity";
import { returnLinesAgainstPurchases } from "./supplier-returns";

/**
 * PAPER THAT HAS BEEN READ AND NOT YET FILED (0295). The gate the File It button and the server
 * both ask, and the "already on the books" match that turns a second bill into a tie.
 */

const receipt = (over: Partial<PaperItem> = {}): PaperItem => ({
  id: "p1",
  kind: "receipt",
  status: "needs_review",
  doc_type: "receipt",
  vendor: "Home Depot",
  amount: 84.12,
  payment: "paid_at_purchase",
  ...over,
});

describe("describePaper: one line, what was read", () => {
  it("says type, vendor, total and how it was paid", () => {
    expect(describePaper(receipt())).toBe("Receipt, Home Depot, $84.12, paid at the counter");
  });
  it("a bill on account", () => {
    expect(describePaper(receipt({ doc_type: "bill", vendor: "CED", amount: 653.25, payment: "on_account" }))).toBe(
      "Bill, CED, $653.25, on account",
    );
  });
  it("says so when no total was read, rather than $0.00", () => {
    expect(describePaper(receipt({ amount: null }))).toBe("Receipt, Home Depot, no total read, paid at the counter");
  });
  it("CED documents found in a PDF", () => {
    expect(
      describePaper(receipt({ doc_type: "supplier_documents", proposal: { ced: { numbers: ["8802-1108330"], total: 653.25, kinds: ["invoice"], text: "x", name: "a.pdf" } } })),
    ).toBe("Supplier document, 8802-1108330, $653.25");
  });
});

describe("readinessOf / fileRefusal: nothing is filed by itself, and nothing half-read is filed", () => {
  const job = { type: "job" as const, jobId: "job-1" };
  it("a read receipt with a total and a destination may be filed", () => {
    expect(readinessOf(receipt()).state).toBe("ready");
    expect(fileRefusal(receipt(), job)).toBeNull();
  });
  it("no destination picked is a refusal, never a guess", () => {
    expect(fileRefusal(receipt(), null)).toMatch(/Pick where it goes/);
  });
  it("a placeholder nothing has read cannot be filed as a cost", () => {
    const unread: PaperItem = { id: "p2", kind: "job_document", status: "needs_review", title: "IMG_0412.jpg" };
    expect(readinessOf(unread).state).toBe("not_read");
    expect(fileRefusal(unread, job)).toMatch(/hasn't been read/);
  });
  it("a receipt with no total waits for a person to type it", () => {
    expect(fileRefusal(receipt({ amount: null }), job)).toMatch(/No total was read/);
  });
  it("statements, credit memos and POs are named, not filed", () => {
    for (const t of ["statement", "credit_memo", "purchase_order"]) {
      const item = receipt({ doc_type: t, kind: "job_document" });
      expect(readinessOf(item).state).toBe("later");
      expect(fileRefusal(item, job)).toBe(NOT_FILED_YET);
      expect(NOT_FILED_YET).toBe("Not filed: this kind of paper goes in a later update.");
    }
  });
  it("an already-filed paper must be undone first", () => {
    expect(fileRefusal(receipt({ status: "filed" }), job)).toMatch(/Undo it first/);
  });
  it("only a cost can be a business cost, and a cost can't be kept in files", () => {
    expect(fileRefusal(receipt({ doc_type: "not_a_cost", kind: "job_document" }), { type: "overhead", category: "Other" })).toMatch(/Only a receipt or a bill/);
    expect(fileRefusal(receipt(), { type: "keep" })).toMatch(/This is a cost/);
  });
  it("a return with no lines is refused on a job, and says Read Again (audit v994, DB4)", () => {
    // The INV-078 return after Organize dropped its lines and a person switched it to Bill.
    const lineless = receipt({ doc_type: "bill", category: "Bill", vendor: "CED", amount: -51.58, line_items: null });
    expect(isReturnWithoutLines(lineless)).toBe(true);
    expect(fileRefusal(lineless, job)).toBe(RETURN_NEEDS_LINES);
    expect(RETURN_NEEDS_LINES).toContain("Read Again");
    // The company's own book never reaches a customer: a business cost is not held to it.
    expect(fileRefusal(lineless, { type: "overhead", category: "Other" })).toBeNull();
    // With its lines it files: the importer can hold each part to the purchase it reverses.
    const lined = { ...lineless, line_items: [{ description: "H245ICAT 4 in LED Shallow IC HSG", quantity: -4, unit_price: -11.83, amount: -47.32 }] };
    expect(isReturnWithoutLines(lined)).toBe(false);
    expect(fileRefusal(lined, job)).toBeNull();
    // An ordinary receipt with no lines (a hand-typed total) is untouched by this.
    expect(fileRefusal(receipt({ line_items: [] }), job)).toBeNull();
    // Lines that are only blanks are no lines.
    expect(isReturnWithoutLines({ ...lineless, line_items: [{ description: "  " }] })).toBe(true);
  });
  it("too big to read keeps its controls and says fill it in", () => {
    const big: PaperItem = { id: "p3", kind: "job_document", status: "needs_review", proposal: { tooBig: true } };
    expect(readinessOf(big)).toEqual({ state: "too_big", sentence: "Too big to read: fill it in yourself." });
  });
});

/**
 * A BILL'S LINES POINT THE SAME WAY AS ITS TOTAL (audit v994 review). The sign was lined up only
 * where the reader read, so a total changed afterwards (Fix Details, It Is A Charge) left the lines
 * pointing the other way, and the money readers read the bill as both a return and a charge.
 */
describe("linesPointWithTotal: the lines follow the total, both ways", () => {
  const HSG = { description: "H245ICAT 4 in LED Shallow IC HSG", quantity: 4, unit_price: 11.83, amount: 47.32 };
  const TAX = { description: "Sales Tax", quantity: 1, unit_price: 4.26, amount: 4.26 };

  it("a negative total over positive lines turns every line negative, and leaves the count alone", () => {
    expect(linesPointWithTotal(-51.58, [HSG, TAX]).map((l) => [l.quantity, l.unit_price, l.amount])).toEqual([
      [4, -11.83, -47.32],
      [1, -4.26, -4.26],
    ]);
  });

  it("a positive total over negative lines (It Is A Charge on a credit memo) turns them back positive", () => {
    const neg = [
      { ...HSG, unit_price: -11.83, amount: -47.32 },
      { ...TAX, unit_price: -4.26, amount: -4.26 },
    ];
    expect(linesPointWithTotal(51.58, neg).map((l) => l.amount)).toEqual([47.32, 4.26]);
  });

  it("lines that already point with the total are the same array, untouched", () => {
    const withFee = [{ ...HSG, unit_price: -11.83, amount: -47.32 }, { description: "Restocking fee", quantity: 1, unit_price: 5, amount: 5 }];
    expect(linesPointWithTotal(-42.32, withFee)).toBe(withFee);
    const withDiscount = [HSG, { description: "Discount", quantity: 1, unit_price: -2, amount: -2 }];
    expect(linesPointWithTotal(45.32, withDiscount)).toBe(withDiscount);
  });

  it("no total, a zero total, no lines or lines adding to nothing are left as they are", () => {
    const lines = [HSG];
    expect(linesPointWithTotal(null, lines)).toBe(lines);
    expect(linesPointWithTotal(0, lines)).toBe(lines);
    expect(linesPointWithTotal(-5, [])).toEqual([]);
    const even = [HSG, { ...HSG, amount: -47.32 }];
    expect(linesPointWithTotal(-5, even)).toBe(even);
  });

  it("a missing unit price stays missing (raw tray jsonb)", () => {
    const [l] = linesPointWithTotal(-10, [{ description: "x", amount: 10, unit_price: null }]);
    expect(l).toEqual({ description: "x", amount: -10, unit_price: null });
  });

  it("isLinelessReturn: a negative total with no described line", () => {
    expect(isLinelessReturn(-51.58, [])).toBe(true);
    expect(isLinelessReturn(-51.58, null)).toBe(true);
    expect(isLinelessReturn(-51.58, [{ description: " " }])).toBe(true);
    expect(isLinelessReturn(-51.58, [HSG])).toBe(false);
    expect(isLinelessReturn(51.58, [])).toBe(false);
    expect(isLinelessReturn(null, [])).toBe(false);
  });

  it("a return typed negative over positive lines is capped against the purchase once its lines are turned", () => {
    // The purchase: the housings were switched OFF the customer's bill, so none of a return of them
    // is the customer's. Positive lines under the -51.58 are invisible to the cap; turned, they are held.
    const purchase = { id: "b-buy", amount: 51.58, lines: [{ ...HSG, id: "l1", category: "Electrical", billable: false, billed_amount: null }] };
    const typed = [{ ...HSG, id: "r1", category: "Electrical", billable: true, billed_amount: null }];
    const ret = (lines: typeof typed) => ({ id: "b-ret", amount: -51.58, lines });
    const unturned = ret(typed);
    const before = returnLinesAgainstPurchases([purchase, unturned], (b) => b.lines as never).get(unturned)!;
    expect(before[0].billed_amount).toBeNull(); // the gap the review found: nothing held it
    const turned = ret(linesPointWithTotal(-51.58, typed));
    const after = returnLinesAgainstPurchases([purchase, turned], (b) => b.lines as never).get(turned)!;
    expect(after[0].amount).toBe(-47.32);
    expect(after[0].billed_amount).toBe(0);
  });
});

describe("the bill carries what the paper IS, never a hard-coded Receipt", () => {
  it("a bill is a Bill", () => {
    expect(billCategoryFor({ doc_type: "bill", category: "Receipt" })).toBe("Bill");
  });
  it("an old row with the reader's category keeps it", () => {
    expect(billCategoryFor({ doc_type: null, category: "Invoice" })).toBe("Invoice");
  });
  it("a bucket name left on the row after a business-cost filing does not become the paper's type", () => {
    expect(billCategoryFor({ doc_type: null, category: "Auto" })).toBe("Receipt");
  });
});

describe("where it goes: only the paper picks a job (Erik, 2026-09-24)", () => {
  it("a MARKED bill comes in with its job picked, and says why in a few words", () => {
    const marked = receipt({ proposal: { jobId: "job-1", jobFrom: "address", jobHint: "518 CINDER LAKE RD" } });
    expect(suggestedDestination(marked, ["job-1"])).toBe("job:job-1");
    expect(pickedBecause(marked)).toBe("Job picked from the address on the receipt: 518 CINDER LAKE RD");
    expect(pickedBecause(receipt({ doc_type: "bill", category: "Invoice", proposal: { jobId: "job-1", jobFrom: "po" } }))).toBe(
      "Job picked from the PO on the invoice",
    );
    // A job no longer on the list is not picked.
    expect(suggestedDestination(marked, ["job-2"])).toBe("");
  });
  it("an UNMARKED bill picks nothing, not even the bucket a model liked, and has no reason line", () => {
    const unmarked = receipt({ proposal: { bucket: "Fuel" } });
    expect(suggestedDestination(unmarked, ["job-1"])).toBe("");
    expect(shownDestination(null, unmarked, ["job-1"])).toBe("");
    expect(pickedBecause(unmarked)).toBeNull();
    // Both choices stay open: a job and a business cost can each be picked, and nothing files
    // until one is.
    expect(fileRefusal(unmarked, null)).toMatch(/Pick where it goes first: a job, or a business cost bucket/);
    expect(fileRefusal(unmarked, parseDestination("job:job-1"))).toBeNull();
    expect(fileRefusal(unmarked, parseDestination("cost:Fuel"))).toBeNull();
  });
  it("a MODEL'S GUESS never pre-selects: it is a one-tap chip", () => {
    // The reader's own job_id, AI Suggest's pick, and a job a model wrote before marks existed.
    for (const proposal of [{ guessJobId: "job-1" }, { jobId: "job-1" }, { jobId: "job-1", jobFrom: null }]) {
      const guessed = receipt({ proposal });
      expect(suggestedDestination(guessed, ["job-1"])).toBe("");
      expect(shownDestination(null, guessed, ["job-1"])).toBe("");
      expect(guessOf(guessed, ["job-1"])).toBe("job:job-1");
    }
    // A bucket guess is a chip too, and Fees is never offered.
    expect(guessOf(receipt({ proposal: { bucket: "Fuel" } }), [])).toBe("cost:Fuel");
    expect(guessOf(receipt({ proposal: { bucket: "Fees" } }), [])).toBeNull();
    // A guess that is the job the paper already picked is not offered twice.
    expect(guessOf(receipt({ proposal: { jobId: "job-1", jobFrom: "address", guessJobId: "job-1" } }), ["job-1"])).toBeNull();
    // A guess that disagrees with the paper is offered beside it, and the paper's job stays picked.
    const both = receipt({ proposal: { jobId: "job-1", jobFrom: "job_number", guessJobId: "job-2" } });
    expect(suggestedDestination(both, ["job-1", "job-2"])).toBe("job:job-1");
    expect(guessOf(both, ["job-1", "job-2"])).toBe("job:job-2");
  });
  it("a paper that names two jobs picks neither", () => {
    const torn = receipt({ proposal: { jobId: "job-1", jobFrom: "address", jobConflict: "The paper points to more than one job." } });
    expect(suggestedDestination(torn, ["job-1"])).toBe("");
    expect(pickedBecause(torn)).toBeNull();
  });
  it("the picker FOLLOWS the paper until a person touches it (a row renders before it is read)", () => {
    const unread = receipt({ proposal: null });
    const read = receipt({ proposal: { jobId: "job-1", jobFrom: "job_number" } });
    // Untouched: nothing yet, then the paper's job the moment the read lands.
    expect(shownDestination(null, unread, ["job-1"])).toBe("");
    expect(shownDestination(null, read, ["job-1"])).toBe("job:job-1");
    // Touched: the person's pick wins, including picking nothing.
    expect(shownDestination("cost:Other", read, ["job-1"])).toBe("cost:Other");
    expect(shownDestination("", read, ["job-1"])).toBe("");
  });
  it("the picker's values round-trip, and a made-up bucket is nothing", () => {
    expect(parseDestination("job:abc")).toEqual({ type: "job", jobId: "abc" });
    expect(parseDestination("cost:Phone & Office")).toEqual({ type: "overhead", category: "Phone & Office" });
    expect(parseDestination("cost:Snacks")).toBeNull();
    expect(parseDestination("keep")).toEqual({ type: "keep" });
    expect(parseDestination("photo:abc")).toEqual({ type: "photo", jobId: "abc" });
    expect(parseDestination("")).toBeNull();
  });
});

/**
 * THE CARD'S FIRST ANSWER (W1-31). The tray card is the Supplier Bills card: its first button is
 * what the paper itself picks, with why; else a guess, marked a guess, with whose; else nothing and
 * the card asks. It is a button a person presses, never a preselected value.
 */
describe("firstAnswer: the paper's own pick first, else a marked guess, else nothing", () => {
  it("the paper names the job: Put It On that job, and the sentence says why", () => {
    const marked = receipt({ doc_type: "bill", proposal: { jobId: "job-11", jobFrom: "po", jobHint: "13897 HONEYSUCKLE" } });
    expect(firstAnswer(marked, ["job-11"])).toEqual({
      dest: "job:job-11",
      because: "Job picked from the PO on the bill: 13897 HONEYSUCKLE",
      isGuess: false,
    });
    // A job that is no longer on anyone's list is no answer; with no guess, nothing.
    expect(firstAnswer(marked, ["job-2"])).toEqual({ dest: "", because: null, isGuess: false });
  });

  it("a model's job guess is the first answer, marked a guess, with 'Not read off the paper'", () => {
    const guessed = receipt({ proposal: { guessJobId: "job-46", why: "The store is near the job." } });
    expect(firstAnswer(guessed, ["job-46"])).toEqual({ dest: "job:job-46", because: "Not read off the paper: The store is near the job.", isGuess: true });
    expect(firstAnswer(receipt({ proposal: { jobId: "job-46" } }), ["job-46"])).toEqual({ dest: "job:job-46", because: "Not read off the paper.", isGuess: true });
  });

  it("the reader's bucket is 'The reader's guess', with what the paper says; AI Suggest's keeps its reason", () => {
    const readers = receipt({ doc_type: "bill", proposal: { po: "TOOLS", bucket: "Tools & Supplies" }, on_paper: "PO TOOLS" });
    expect(firstAnswer(readers, [])).toEqual({ dest: "cost:Tools & Supplies", because: "The reader's guess, from the paper (PO TOOLS).", isGuess: true });
    const ai = receipt({ proposal: { bucket: "Fuel", bucketFrom: "ai", why: "A pump receipt." } });
    expect(firstAnswer(ai, [])).toEqual({ dest: "cost:Fuel", because: "Not read off the paper: A pump receipt.", isGuess: true });
    // Fees is never a guess.
    expect(firstAnswer(receipt({ proposal: { bucket: "Fees" } }), [])).toEqual({ dest: "", because: null, isGuess: false });
  });

  it("a company word on the paper is the paper's own pick: TOOLS picks Tools & Supplies, STOCK picks stock", () => {
    const tools = receipt({ doc_type: "bill", proposal: { po: "TOOLS", companyUse: { bucket: "Tools & Supplies", from: "po", words: "TOOLS" } } });
    expect(firstAnswer(tools, [])).toEqual({ dest: "cost:Tools & Supplies", because: "Business cost picked from the PO on the bill: TOOLS", isGuess: false });
    const stock = receipt({ doc_type: "bill", proposal: { po: "STOCK", companyUse: { bucket: null, from: "po", words: "STOCK", shelf: true } } });
    expect(firstAnswer(stock, [])).toEqual({ dest: "stock", because: "Shop Stock picked from the PO on the bill: STOCK", isGuess: false });
    // Shop Stock off (0352): the paper's STOCK is no answer; its words still show (paperSays).
    expect(firstAnswer(stock, [], { shopStock: false })).toEqual({ dest: "", because: null, isGuess: false });
    expect(paperSays(stock)).toBe("STOCK");
  });

  it("a paper that names two jobs has no first answer of its own; a model's guess beside it is only a guess", () => {
    // What rematchPaper leaves on it: no job, the conflict said.
    const torn = receipt({ proposal: { jobId: null, jobFrom: null, jobConflict: "The paper points to more than one job." } });
    expect(firstAnswer(torn, ["job-1"])).toEqual({ dest: "", because: null, isGuess: false });
    const guessed = receipt({ proposal: { jobId: null, jobFrom: null, guessJobId: "job-1", jobConflict: "The paper points to more than one job." } });
    expect(firstAnswer(guessed, ["job-1"])).toMatchObject({ dest: "job:job-1", isGuess: true });
    // The paper's own job beats a guess that disagrees; the guess is still a picker's Closest.
    const both = receipt({ proposal: { jobId: "job-1", jobFrom: "job_number", guessJobId: "job-2" } });
    expect(firstAnswer(both, ["job-1", "job-2"])).toMatchObject({ dest: "job:job-1", isGuess: false });
  });

  it("nothing on the paper and no guess: no first answer, and the card asks", () => {
    expect(firstAnswer(receipt(), ["job-1"])).toEqual({ dest: "", because: null, isGuess: false });
  });
});

describe("the card's words (W1-31)", () => {
  it("paperSays: the words that made the pick, else what is printed where a job goes, else nothing", () => {
    expect(paperSays(receipt({ proposal: { jobId: "j", jobFrom: "po", jobHint: "13897 HONEYSUCKLE" } }))).toBe("13897 HONEYSUCKLE");
    expect(paperSays(receipt({ proposal: { po: "TOOLS" }, on_paper: "PO TOOLS" }))).toBe("PO TOOLS");
    // The server's null (only the company's own names were printed) is an answer.
    expect(paperSays(receipt({ proposal: { jobHint: "ERIK TAYLOR" }, on_paper: null }))).toBeNull();
    expect(paperSays(receipt())).toBeNull();
  });

  it("paperKindWords: what the paper is, and how filing it will book it", () => {
    expect(paperKindWords(receipt())).toBe("Receipt (Paid)");
    expect(paperKindWords(receipt({ doc_type: "bill", payment: "on_account" }))).toBe("Bill (Still Owed)");
    expect(paperKindWords(receipt({ payment: "unknown" }))).toBe("Receipt (Not Marked Paid)");
    expect(paperKindWords(receipt({ doc_type: "bill", payment: null, category: "Bill" }))).toBe("Bill (Still Owed)");
  });

  it("cardSentence: a server sentence that still says 'press File It' loses that tail on the card, and nothing else", () => {
    expect(cardSentence("Read as a bill or receipt. Pick where it goes, then press File It.")).toBe("Read as a bill or receipt. Pick where it goes.");
    expect(cardSentence("Read as a bill or receipt. Job picked from the PO on the receipt: 13897 HONEYSUCKLE: J-011 13897 Honeysuckle. Press File It if that's right.")).toBe(
      "Read as a bill or receipt. Job picked from the PO on the receipt: 13897 HONEYSUCKLE: J-011 13897 Honeysuckle.",
    );
    expect(cardSentence("Kept in files.")).toBe("Kept in files.");
    expect(cardSentence(null)).toBe("");
  });

  it("no card sentence names a File It button", () => {
    const bits = [
      BILL_DELETED_SAID,
      readinessOf(receipt({ amount: null })).sentence,
      fileRefusal({ id: "x", status: "needs_review", proposal: { tooBig: true } } as PaperItem, { type: "job", jobId: "j" }),
      readinessOf(receipt({ doc_type: "statement", kind: "job_document" })).sentence,
    ];
    for (const b of bits) expect(b).not.toMatch(/\bFile It\b/);
    expect(readinessOf(receipt({ doc_type: "statement", kind: "job_document" })).sentence).toContain("Snap Or Note");
  });
});

describe("jobFromPaperMarks: exact, never fuzzy", () => {
  const JOBS: MarkJob[] = [
    { id: "j46", job_number: "J-046", name: "Jason Wexley", address: "518 Cinder Lake Rd, Chilcoot CA 96105", customerNames: ["Jason Wexley", null] },
    { id: "j50", job_number: "J-050", name: "Tess Zane", address: "235 Thistle Wood Rd, Truckee CA 96161", customerNames: ["Tess Zane"] },
    { id: "j51", job_number: "J-051", name: "Tess Zane Shop", address: "13631 Nightshade Blvd Truckee CA 96161", customerNames: ["Tess Zane"] },
    { id: "j09", job_number: "J-009", name: "ARR #11", address: "300 W Garnet Blvd, Tahoe City", customerNames: ["Alder Ridge Rentals"] },
    { id: "j13", job_number: "J-013", name: "ARR #56", address: "300 West Garnet Boulevard", customerNames: ["Alder Ridge Rentals"] },
  ];

  it("an address on the paper finds its job, spelled any of the ways a street is spelled", () => {
    for (const address of ["518 Cinder Lake Rd", "518 CINDER LAKE ROAD", "518 cinder lake rd., Chilcoot CA"])
      expect(jobFromPaperMarks({ address }, JOBS)).toMatchObject({ kind: "one", jobId: "j46", from: "address" });
    expect(jobFromPaperMarks({ address: "235 THISTLE WOOD ROAD" }, JOBS)).toMatchObject({ kind: "one", jobId: "j50" });
    expect(streetKey("300 West Garnet Boulevard")).toBe(streetKey("300 W Garnet Blvd #11"));
  });
  it("the street type is part of the street: Dr is not Rd, St is not Ave", () => {
    expect(streetKey("518 Cinder Lake Dr")).not.toBe(streetKey("518 Cinder Lake Rd"));
    expect(streetKey("100 Oak St")).not.toBe(streetKey("100 Oak Ave"));
    expect(streetKey("100 Oak Street")).toBe(streetKey("100 Oak St"));
    expect(streetKey("518 Cinder Lake Road")).toBe(streetKey("518 Cinder Lake Rd"));
    expect(jobFromPaperMarks({ address: "518 Cinder Lake Dr" }, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ address: "518 Cinder Lake Ct" }, JOBS)).toEqual({ kind: "none" });
    // A street written with NO type is not a different street (Erik, 2026-09-24: "13897
    // HONEYSUCKLE" in the PO box of a CED ticket). Only two written types that differ are two.
    expect(jobFromPaperMarks({ address: "518 Cinder Lake" }, JOBS)).toMatchObject({ kind: "one", jobId: "j46", from: "address" });
  });
  it("a near address is NOT a match: a different house number, a different word, no house number", () => {
    expect(jobFromPaperMarks({ address: "13466 Nightshade Blvd" }, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ address: "518 Cinder Lakeview Rd" }, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ address: "Cinder Lake Rd" }, JOBS)).toEqual({ kind: "none" });
    expect(streetKey("Cinder Lake Rd")).toBeNull();
  });
  it("a street shared by several jobs picks none of them", () => {
    expect(jobFromPaperMarks({ address: "300 W Garnet Blvd #11" }, JOBS)).toEqual({ kind: "none" });
  });
  it("a job number or a PO number, however it is punctuated", () => {
    expect(jobFromPaperMarks({ jobNumber: "j046" }, JOBS)).toMatchObject({ kind: "one", jobId: "j46", from: "job_number" });
    expect(jobFromPaperMarks({ po: "J 050" }, JOBS)).toMatchObject({ kind: "one", jobId: "j50", from: "po" });
    // A PO this org wrote names its job.
    expect(jobFromPaperMarks({ po: "PO-0012" }, JOBS, [{ po_number: "PO-0012", job_id: "j51" }])).toMatchObject({ kind: "one", jobId: "j51", from: "po" });
    // A PO on a job that isn't open picks nothing.
    expect(jobFromPaperMarks({ po: "PO-0013" }, JOBS, [{ po_number: "PO-0013", job_id: "closed" }])).toEqual({ kind: "none" });
    // "46" is not J-046.
    expect(jobFromPaperMarks({ jobNumber: "46" }, JOBS)).toEqual({ kind: "none" });
  });
  it("a job name or a customer, exactly; a customer with two open jobs picks neither", () => {
    expect(jobFromPaperMarks({ jobName: "JASON WEXLEY" }, JOBS)).toMatchObject({ kind: "one", jobId: "j46", from: "job_name" });
    expect(jobFromPaperMarks({ jobName: "Jason Wexle" }, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ customer: "jason wexley" }, JOBS)).toMatchObject({ kind: "one", jobId: "j46", from: "customer" });
    expect(jobFromPaperMarks({ customer: "Tess Zane" }, JOBS)).toEqual({ kind: "none" });
    // ...unless another mark on the same paper settles which.
    expect(jobFromPaperMarks({ customer: "Tess Zane", address: "13631 Nightshade Blvd" }, JOBS)).toMatchObject({ kind: "one", jobId: "j51", from: "address" });
  });
  it("two marks naming two different jobs pick nothing, and say so", () => {
    const r = jobFromPaperMarks({ jobNumber: "J-046", address: "235 Thistle Wood Rd" }, JOBS);
    expect(r.kind).toBe("conflict");
    expect(r.kind === "conflict" && r.sentence).toContain("more than one job");
  });
  it("no marks, no pick", () => {
    expect(jobFromPaperMarks({}, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks(null, JOBS)).toEqual({ kind: "none" });
  });
});

describe("finished jobs: fileable, never picked, and a street they share picks nothing (Erik, audit v994 PR1)", () => {
  // ET's live shape: 235 Thistlewood has J-002 in progress and J-032 complete; 300 W Garnet Blvd has
  // an open ARR job and finished ones.
  const JOBS: MarkJob[] = [
    { id: "j02", job_number: "J-002", name: "Tess Zane", address: "235 Thistlewood Rd", customerNames: ["Tess Zane"] },
    { id: "j32", job_number: "J-032", name: "Tess Zane Deck", address: "235 Thistlewood Rd", customerNames: ["Tess Zane"], closed: true },
    { id: "j44", job_number: "J-044", name: "Remy", address: "300 W Garnet Blvd #99", customerNames: ["Alder Ridge Rentals"] },
    { id: "j52", job_number: "J-052", name: "ARR 99", address: "300 West Garnet Boulevard", customerNames: ["Alder Ridge Rentals"], closed: true },
    { id: "j46", job_number: "J-046", name: "Jason Wexley", address: "518 Cinder Lake Rd", customerNames: ["Jason Wexley"], closed: true },
    { id: "j11", job_number: "J-011", name: "13897 Honeysuckle", address: "13897 Honeysuckle Way", customerNames: ["Andrew Crake"] },
  ];

  it("a street shared with a finished job picks nothing, and says which finished job", () => {
    const r = jobFromPaperMarks({ address: "235 THISTLEWOOD RD" }, JOBS);
    expect(r).toMatchObject({ kind: "conflict", veto: true });
    expect((r as { sentence: string }).sentence).toBe("235 THISTLEWOOD RD also has finished job (J-032 Tess Zane Deck), so no job was picked. Pick the job.");
    // The same street in the PO box, the same answer.
    expect(jobFromPaperMarks({ po: "300 W GARNET BLVD" }, JOBS)).toMatchObject({ kind: "conflict", veto: true });
  });

  it("a job number, a job name or a customer naming the open job still picks it", () => {
    expect(jobFromPaperMarks({ address: "235 Thistlewood Rd", jobNumber: "J-002" }, JOBS)).toMatchObject({ kind: "one", jobId: "j02" });
    expect(jobFromPaperMarks({ po: "13897 HONEYSUCKLE" }, JOBS)).toMatchObject({ kind: "one", jobId: "j11" });
  });

  it("a finished job is never the pick, even when the paper names it exactly", () => {
    expect(jobFromPaperMarks({ jobNumber: "J-046" }, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ address: "518 Cinder Lake Rd" }, JOBS)).toEqual({ kind: "none" });
  });

  it("a street only open jobs sit on still picks, as before", () => {
    expect(jobFromPaperMarks({ address: "13897 Honeysuckle Way" }, JOBS)).toMatchObject({ kind: "one", jobId: "j11", from: "address" });
  });

  it("a row picked by its street before finished jobs counted stops picking on the next load, and says why", () => {
    const row: PaperItem = {
      id: "p1",
      status: "needs_review",
      doc_type: "bill",
      amount: 40,
      proposal: { jobId: "j02", jobFrom: "address", jobHint: "235 THISTLEWOOD RD", marks: { address: "235 THISTLEWOOD RD" } },
    };
    const again = rematchPaper(row, JOBS);
    expect(suggestedDestination(again, JOBS.map((j) => j.id))).toBe("");
    expect((again.proposal as { jobConflict?: string }).jobConflict).toContain("also has finished job (J-032");
    // A pick a job NUMBER made is never second-guessed.
    const byNumber: PaperItem = { ...row, proposal: { jobId: "j02", jobFrom: "job_number", jobHint: "J-002", marks: { jobNumber: "J-002", address: "235 THISTLEWOOD RD" } } };
    expect(rematchPaper(byNumber, JOBS)).toBe(byNumber);
  });

  it("a row picked while its job was open stops picking once that job is finished, from a street or a PO alone", () => {
    // J-046 has since finished; nothing else sits on 518 Cinder Lake Rd, so the street alone finds nothing.
    const row: PaperItem = {
      id: "p2",
      status: "needs_review",
      doc_type: "bill",
      amount: 40,
      proposal: { jobId: "j46", jobFrom: "address", jobHint: "518 CINDER LAKE RD", marks: { address: "518 CINDER LAKE RD" } },
    };
    const again = rematchPaper(row, JOBS);
    // The pickers list finished jobs, and still nothing is picked.
    expect(suggestedDestination(again, JOBS.map((j) => j.id))).toBe("");
    expect((again.proposal as { jobConflict?: string }).jobConflict).toBe("J-046 Jason Wexley is finished, so no job was picked. Pick the job.");
    const byPo: PaperItem = { ...row, proposal: { jobId: "j46", jobFrom: "po", jobHint: "WEXLEY", marks: { po: "WEXLEY" } } };
    expect(suggestedDestination(rematchPaper(byPo, JOBS), JOBS.map((j) => j.id))).toBe("");
    // A printed job number is that job, finished or not: it stands.
    const byNumber: PaperItem = { ...row, proposal: { jobId: "j46", jobFrom: "job_number", jobHint: "J-046", marks: { jobNumber: "J-046" } } };
    expect(rematchPaper(byNumber, JOBS)).toBe(byNumber);
  });
});

describe("the job in the PO box: 13897 HONEYSUCKLE (Erik, 2026-09-24)", () => {
  // ET's live row 12962a84: a CED sales order, $323.71, 8802-SO-257555, PO "13897 HONEYSUCKLE",
  // hint "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HONEYSUCKLE". It came in with no job picked.
  const J011: MarkJob = {
    id: "j11",
    job_number: "J-011",
    name: "13897 Honeysuckle",
    address: "13897 Honeysuckle Way",
    customerNames: ["Andrew Crake", null],
  };
  const OTHERS: MarkJob[] = [
    { id: "j20", job_number: "J-020", name: "1860 Cedar Park Heights", address: "1860 Cedar Park Heights Dr, Tahoe City, CA 96145, USA", customerNames: ["Chris Taylor"] },
    { id: "j46", job_number: "J-046", name: "Jason Wexley", address: "518 Cinder Lake Rd, Chilcoot CA 96105", customerNames: ["Jason Wexley"] },
  ];
  const JOBS = [J011, ...OTHERS];
  const SELF = ["ET Electric", "Erik Taylor", "Brian Taylor"];
  const ced = (proposal: Record<string, unknown>): PaperItem => ({
    id: "12962a84",
    kind: "receipt",
    status: "needs_review",
    doc_type: "bill",
    category: "Bill",
    vendor: "Consolidated Electrical Dist.",
    amount: "323.71",
    doc_number: "8802-SO-257555",
    proposal,
  });

  it("a PO that IS a job's name picks that job, and says where it came from", () => {
    expect(jobFromPaperMarks({ po: "13897 HONEYSUCKLE" }, JOBS)).toEqual({ kind: "one", jobId: "j11", from: "po", words: "13897 HONEYSUCKLE" });
    // ...whatever the job is named, if the PO is its street.
    const renamed = [{ ...J011, name: "Crake Remodel" }, ...OTHERS];
    expect(jobFromPaperMarks({ po: "13897 HONEYSUCKLE" }, renamed)).toMatchObject({ kind: "one", jobId: "j11", from: "po" });
    // ...or its number.
    expect(jobFromPaperMarks({ po: "J011" }, JOBS)).toMatchObject({ kind: "one", jobId: "j11", from: "po" });
    // A PO that names no job exactly picks nothing.
    expect(jobFromPaperMarks({ po: "13897 HONEY" }, JOBS)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ po: "4471" }, JOBS)).toEqual({ kind: "none" });
  });

  it("an address written without its street type matches the job whose address has one", () => {
    const renamed = [{ ...J011, name: "Crake Remodel" }, ...OTHERS];
    expect(jobFromPaperMarks({ address: "13897 HONEYSUCKLE" }, renamed)).toMatchObject({ kind: "one", jobId: "j11", from: "address" });
    expect(jobFromPaperMarks({ address: "13897 Honeysuckle Way, Truckee CA" }, renamed)).toMatchObject({ kind: "one", jobId: "j11" });
    // And the other way round: the paper writes the type, the job's address doesn't.
    const untyped = [{ ...J011, address: "13897 Honeysuckle" }, ...OTHERS];
    expect(jobFromPaperMarks({ address: "13897 HONEYSUCKLE WAY" }, untyped)).toMatchObject({ kind: "one", jobId: "j11" });
  });

  it("a type that DISAGREES is another street: 13897 Honeysuckle Dr is not 13897 Honeysuckle Way", () => {
    const renamed = [{ ...J011, name: "Crake Remodel" }, ...OTHERS];
    expect(jobFromPaperMarks({ address: "13897 Honeysuckle Dr" }, renamed)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ po: "13897 Honeysuckle Dr" }, renamed)).toEqual({ kind: "none" });
    // A different house number, or a different word, is never the street.
    expect(jobFromPaperMarks({ address: "13898 HONEYSUCKLE" }, renamed)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ address: "13897 HONEYSUCKLE LOOP" }, renamed)).toEqual({ kind: "none" });
  });

  it("two jobs on the same street pick neither", () => {
    const twoOnIt: MarkJob[] = [
      { ...J011, name: "Crake Remodel" },
      { id: "j12", job_number: "J-012", name: "Crake Garage", address: "13897 Honeysuckle Ct", customerNames: ["Andrew Crake"] },
      ...OTHERS,
    ];
    expect(jobFromPaperMarks({ address: "13897 HONEYSUCKLE" }, twoOnIt)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ po: "13897 HONEYSUCKLE" }, twoOnIt)).toEqual({ kind: "none" });
    // A written type still settles it.
    expect(jobFromPaperMarks({ address: "13897 HONEYSUCKLE CT" }, twoOnIt)).toMatchObject({ kind: "one", jobId: "j12" });
    // Two marks pointing at two jobs pick nothing, and say so.
    const torn = jobFromPaperMarks({ po: "13897 HONEYSUCKLE", jobNumber: "J-046" }, JOBS);
    expect(torn.kind).toBe("conflict");
  });

  it("the owner's own name on the paper is never a customer or a job", () => {
    const eriksJob: MarkJob[] = [...JOBS, { id: "shop", job_number: "J-099", name: "Erik Taylor", address: null, customerNames: ["Erik Taylor"] }];
    expect(jobFromPaperMarks({ customer: "ERIK TAYLOR" }, eriksJob, [], SELF)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ jobName: "Erik Taylor" }, eriksJob, [], SELF)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ po: "ERIK TAYLOR" }, eriksJob, [], SELF)).toEqual({ kind: "none" });
    // ...and it never stands against the street printed beside it.
    expect(jobFromPaperMarks({ customer: "ERIK TAYLOR", po: "13897 HONEYSUCKLE" }, eriksJob, [], SELF)).toMatchObject({ kind: "one", jobId: "j11" });
  });

  it("a job named after its customer is not decisive when that customer has other open jobs", () => {
    // ET live: J-014 "5659 Fernhill", J-034 "5659 Fernhill - Panel Upgrade" and J-047 "Marla Finch"
    // are all open, all for Marla Finch. "MARLA FINCH" in the PO box names her, not J-047.
    const finch: MarkJob[] = [
      ...JOBS,
      { id: "j14", job_number: "J-014", name: "5659 Fernhill", address: "5659 Fernhill Rd", customerNames: ["Marla Finch"] },
      { id: "j34", job_number: "J-034", name: "5659 Fernhill - Panel Upgrade", address: "5659 Fernhill Rd", customerNames: ["Marla Finch"] },
      { id: "j47", job_number: "J-047", name: "Marla Finch", address: null, customerNames: ["Marla Finch"] },
    ];
    expect(jobFromPaperMarks({ po: "MARLA FINCH" }, finch, [], SELF)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ jobName: "Marla Finch" }, finch, [], SELF)).toEqual({ kind: "none" });
    expect(jobFromPaperMarks({ po: "MARLA FINCH", customer: "Marla Finch" }, finch, [], SELF)).toEqual({ kind: "none" });
    // A job number still decides, and the name agrees with it.
    expect(jobFromPaperMarks({ po: "MARLA FINCH", jobNumber: "J-034" }, finch, [], SELF)).toMatchObject({ kind: "one", jobId: "j34" });
    // Her only open job, named after her, is still picked by her name.
    const onlyOne = finch.filter((j) => j.id !== "j14" && j.id !== "j34");
    expect(jobFromPaperMarks({ po: "MARLA FINCH" }, onlyOne, [], SELF)).toMatchObject({ kind: "one", jobId: "j47", from: "po" });
  });

  it("the reader's hint gives up its street, and only its street", () => {
    expect(addressInHint("JOB NAME AND ADDRESS ERIK TAYLOR 13897 HONEYSUCKLE")).toBe("13897 HONEYSUCKLE");
    expect(addressInHint("PO 4471 13897 HONEYSUCKLE WAY")).toBe("13897 HONEYSUCKLE WAY");
    expect(addressInHint("SHIP TO: CRAKE, 13897 Honeysuckle Way, Truckee")).toBe("13897 Honeysuckle Way");
    expect(addressInHint("ERIK TAYLOR")).toBeNull();
    expect(addressInHint(null)).toBeNull();
    const renamed = [{ ...J011, name: "Crake Remodel" }, ...OTHERS];
    expect(jobFromPaperMarks({ hint: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HONEYSUCKLE" }, renamed, [], SELF)).toMatchObject({
      kind: "one",
      jobId: "j11",
      from: "address",
      words: "13897 HONEYSUCKLE",
    });
  });

  it("the row: its job picked, and why, in the reason line", () => {
    const row = ced({
      po: "13897 HONEYSUCKLE",
      jobId: null,
      jobFrom: null,
      jobHint: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HONEYSUCKLE",
      guessJobId: null,
      jobConflict: null,
      bucket: null,
    });
    // As stored today: asks where it goes.
    expect(suggestedDestination(row, ["j11"])).toBe("");
    // Matched again in the tray from what it stored: no model, the same exact rules.
    const now = rematchPaper(row, JOBS, [], SELF);
    expect(suggestedDestination(now, ["j11", "j20", "j46"])).toBe("job:j11");
    expect(pickedBecause(now)).toBe("Job picked from the PO on the bill: 13897 HONEYSUCKLE");
    // The stored row itself is untouched.
    expect(row.proposal).toMatchObject({ jobId: null, jobFrom: null });
  });

  it("the tray never re-decides a row a person or the paper already settled", () => {
    // Filed or set aside: as it is.
    const filed = { ...ced({ po: "13897 HONEYSUCKLE" }), status: "filed" };
    expect(rematchPaper(filed, JOBS)).toBe(filed);
    // Already picked by its paper: as it is, even if the PO would say something else.
    const picked = ced({ po: "13897 HONEYSUCKLE", jobId: "j46", jobFrom: "job_number", jobHint: "J-046" });
    expect(rematchPaper(picked, JOBS)).toBe(picked);
    // A conflict already said stays said.
    const torn = ced({ po: "13897 HONEYSUCKLE", jobConflict: "The paper points to more than one job." });
    expect(rematchPaper(torn, JOBS)).toBe(torn);
    // A model's old job stays a guess beside the paper's pick.
    const guessed = rematchPaper(ced({ po: "13897 HONEYSUCKLE", jobId: "j46", jobFrom: null }), JOBS);
    expect(suggestedDestination(guessed, ["j11", "j46"])).toBe("job:j11");
    expect(guessOf(guessed, ["j11", "j46"])).toBe("job:j46");
    // Nothing on it that names a job: as it is.
    const bare = ced({ po: null, jobHint: null });
    expect(rematchPaper(bare, JOBS)).toBe(bare);
  });
});

describe("a plain picture asks what it is first", () => {
  const picture = (over: Partial<PaperItem> = {}): PaperItem => ({
    id: "p2",
    kind: "job_document",
    status: "needs_review",
    doc_type: "not_a_cost",
    title: "Panel, 200A main",
    category: "Photo",
    proposal: { picture: true },
    ...over,
  });
  it("a picture's row asks \"What is this?\", not where it goes", () => {
    expect(isPicture(picture())).toBe(true);
    expect(readinessOf(picture())).toEqual({ state: "picture", sentence: "What is this?" });
    expect(describePaper(picture())).toBe("Picture, Panel, 200A main");
    // A row read before the reader said "photo" is known by its category.
    expect(readinessOf(picture({ proposal: null }))).toMatchObject({ state: "picture" });
    // A permit is not a picture, and a receipt never is.
    expect(isPicture(picture({ category: "Permit", proposal: null }))).toBe(false);
    expect(isPicture(receipt({ category: "Photo" }))).toBe(false);
  });
  it("Job Photo files a picture on a job, and never a bill or receipt", () => {
    expect(fileRefusal(picture(), parseDestination("photo:job-1"))).toBeNull();
    expect(fileRefusal(picture(), parseDestination("cost:Other"))).toMatch(/Only a receipt or a bill can be a business cost/);
    expect(fileRefusal(receipt(), parseDestination("photo:job-1"))).toMatch(/not a picture/);
    expect(fileRefusal(picture({ status: "filed" }), parseDestination("photo:job-1"))).toMatch(/already filed/);
    expect(fileRefusal(picture(), null)).toMatch(/Pick where it goes first/);
  });
  it("Something Else keeps the picture on a job or in files, as any paper that isn't a cost", () => {
    expect(fileRefusal(picture(), parseDestination("keep"))).toBeNull();
    expect(fileRefusal(picture(), parseDestination("job:job-1"))).toBeNull();
  });
});

describe("a bank download, described", () => {
  it("says what it is and how many lines, and leaves the account to the card's headline", () => {
    const item = receipt({ doc_type: "statement", proposal: { bankImport: { download: { v: 1, name: "x", last4: "1234", from: null, to: null, lines: [{}, {}] as never, skipped: [], header: [] } } } });
    expect(describePaper(item)).toBe("Bank Download, 2 lines");
  });
});

describe("sameMoneyFromBank: a purchase a bank download already wrote", () => {
  const bankBill = { id: "bill-bank", supplier: "1111-SHELL OIL 12345 ANYTOWN", bill_number: null, amount: 62.1, bill_date: "2026-09-12", job_id: null, superseded_by_bill_id: null, from_bank: true };
  it("a business cost with no number written any other way (by hand, before the bank door) is the same purchase too, said as what it is", () => {
    const byHand = { ...bankBill, id: "bill-hand", supplier: "SHELL OIL ANYTOWN", from_bank: undefined };
    expect(sameMoneyFromBank(receipt({ vendor: "Shell", amount: 62.1, item_date: "2026-09-14", doc_number: null }), [byHand])).toEqual([
      { kind: "bill", billId: "bill-hand", jobId: null, sentence: "Already on the books: SHELL OIL ANYTOWN, $62.10, 2026-09-12, a business cost with no number." },
    ]);
  });
  it("a receipt of the same money within 3 days is that bill, whatever its number", () => {
    const pump = receipt({ vendor: "Shell", amount: 62.1, item_date: "2026-09-13", doc_number: null });
    const m = sameMoneyFromBank(pump, [bankBill]);
    expect(m).toEqual([
      { kind: "bill", billId: "bill-bank", jobId: null, sentence: "Already on the books: 1111-SHELL OIL 12345 ANYTOWN, $62.10, 2026-09-12, from the bank download (a business cost)." },
    ]);
  });
  /**
   * A BANK LINE PUT ON THE JOB IT WAS FOR IS ONE OF THESE TOO (0375). This check once skipped every
   * bill with a job, because a bank line could only ever be a business cost. The day a line could go on
   * the job it was bought for, that skip hid the counter receipt's own twin: File It found nothing,
   * offered no tie and wrote a SECOND bill on the same job — the job cost doubled, and on a
   * time-and-material job the customer was billed for it twice.
   */
  it("a bank line put on a job is the same purchase, and says which job", () => {
    const onJob = { ...bankBill, job_id: "job-1", jobs: { job_number: "J-054", name: "41 Larkspur" } };
    expect(sameMoneyFromBank(receipt({ vendor: "Shell", amount: 62.1, item_date: "2026-09-13" }), [onJob])).toEqual([
      {
        kind: "bill",
        billId: "bill-bank",
        // The tie files the paper onto the bill's own job, so the job comes back with the match.
        jobId: "job-1",
        sentence: "Already on the books: 1111-SHELL OIL 12345 ANYTOWN, $62.10, 2026-09-12, from the bank download, on J-054 41 Larkspur.",
      },
    ]);
    // A job whose row didn't come with its number still reads as something, never "undefined".
    expect(sameMoneyFromBank(receipt({ amount: 62.1, item_date: "2026-09-13" }), [{ ...bankBill, job_id: "job-1" }])[0].sentence).toContain("on a job.");
  });

  it("another amount, a day 4 apart, a job's bill filed by hand, or a paper that isn't a cost is not", () => {
    expect(sameMoneyFromBank(receipt({ amount: 62.11, item_date: "2026-09-12" }), [bankBill])).toEqual([]);
    expect(sameMoneyFromBank(receipt({ amount: 62.1, item_date: "2026-09-16" }), [bankBill])).toEqual([]);
    // A JOB COST FILED BY HAND is not matched on money and day: it carries the number its paper
    // printed, which findSameNumber matches exactly, and two trips to the supply house for the same
    // $62.10 on one job are two purchases, not one.
    expect(sameMoneyFromBank(receipt({ amount: 62.1, item_date: "2026-09-12" }), [{ ...bankBill, job_id: "job-1", from_bank: undefined }])).toEqual([]);
    expect(sameMoneyFromBank(receipt({ amount: 62.1, item_date: "2026-09-12", doc_type: "not_a_cost" }), [bankBill])).toEqual([]);
    // The bill this paper made is never its own twin.
    expect(sameMoneyFromBank(receipt({ amount: 62.1, item_date: "2026-09-12", bill_id: "bill-bank" }), [bankBill])).toEqual([]);
  });
});

describe("findSameNumber: the same purchase already on the books", () => {
  const bill = {
    id: "bill-1",
    supplier: "Consolidated Electrical Dist.",
    bill_number: "8802-1108330",
    supplier_account_id: "acct-ced",
    amount: 653.25,
    bill_date: "2026-09-17",
    job_id: "job-046",
    jobs: { job_number: "J-046", name: "Jason Wexley" },
  };
  const aliases = indexSupplierAliases([
    { alias: "Consolidated Electrical Dist.", supplier_account_id: "acct-ced" },
    { alias: "CED", supplier_account_id: "acct-ced" },
  ]);

  it("normalises the printed number", () => {
    expect(normalizeDocNumber("#8802 1108330")).toBe("88021108330");
    expect(normalizeDocNumber(" No. 8802-1108330 ")).toBe("88021108330");
    expect(normalizeDocNumber("INV# 8802-1108330")).toBe(normalizeDocNumber("8802 1108330"));
  });

  it("same number, same account through an exact alias: offered as a tie", () => {
    const m = findSameNumber(receipt({ vendor: "CED", doc_number: "8802-1108330", doc_type: "bill" }), { bills: [bill] }, aliases);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "bill", billId: "bill-1" });
    expect(m[0].sentence).toContain("J-046");
    expect(m[0].sentence).toContain("$653.25");
  });

  // DB5, ERIK'S CALL (audit v994): "a long supplier number matches even when the supplier name is
  // spelled differently, as a WARNING only". Never the certain "bill" (which refuses File It), and
  // never a guess at the account.
  it("a long number under a spelling on no account is a WARNING, never the certain match that refuses", () => {
    const m = findSameNumber(receipt({ vendor: "Consolidated Electrical Distributors (CED)", doc_number: "8802-1108330" }), { bills: [bill] }, aliases);
    expect(m.filter((x) => x.kind === "bill")).toEqual([]);
    expect(m).toEqual([expect.objectContaining({ kind: "maybe_bill", billId: "bill-1", jobId: "job-046" })]);
    expect(m[0].sentence).toContain("Maybe already on the books");
    expect(m[0].sentence).toContain('"Consolidated Electrical Distributors (CED)" here, "Consolidated Electrical Dist." there');
  });

  it("no alias at all and a different spelling: still only a warning (exact only for the certain match)", () => {
    const m = findSameNumber(receipt({ vendor: "Consolidated Electric", doc_number: "8802-1108330" }), { bills: [bill] }, null);
    expect(m.map((x) => x.kind)).toEqual(["maybe_bill"]);
  });

  it("a SHORT number under another spelling is two purchases: no warning", () => {
    const short = { ...bill, bill_number: "1234" };
    expect(findSameNumber(receipt({ vendor: "Home Depot", doc_number: "1234" }), { bills: [short] }, aliases)).toEqual([]);
  });

  it("two accounts a person set up are two suppliers, whatever the number", () => {
    const two = indexSupplierAliases([
      { alias: "Consolidated Electrical Dist.", supplier_account_id: "acct-ced" },
      { alias: "Home Depot", supplier_account_id: "acct-hd" },
    ]);
    expect(findSameNumber(receipt({ vendor: "Home Depot", doc_number: "8802-1108330" }), { bills: [bill] }, two)).toEqual([]);
  });

  it("a set-aside copy is never a warning either", () => {
    const copy = { ...bill, superseded_by_bill_id: "bill-9" };
    expect(findSameNumber(receipt({ vendor: "Consolidated Electric", doc_number: "8802-1108330" }), { bills: [copy] }, aliases)).toEqual([]);
  });

  it("a paper with no number matches nothing", () => {
    expect(findSameNumber(receipt({ doc_number: null }), { bills: [bill] }, aliases)).toEqual([]);
  });

  it("the bill this paper made is not a duplicate of itself", () => {
    expect(findSameNumber(receipt({ vendor: "CED", doc_number: "8802-1108330", bill_id: "bill-1" }), { bills: [bill] }, aliases)).toEqual([]);
  });

  it("a supplier document with a long number matches even before it has an account", () => {
    const m = findSameNumber(
      receipt({ vendor: "Contractors Electrical Distributors", doc_number: "8802-1108330" }),
      { supplierInvoices: [{ id: "si-1", invoice_number: "8802-1108330", supplier_account_id: null, total: 653.25 }] },
      aliases,
    );
    expect(m).toEqual([expect.objectContaining({ kind: "supplier_invoice", supplierInvoiceId: "si-1", invoiceNumber: "8802-1108330" })]);
    // Not a cost, so nothing to tie to: filing it links the bill it makes (the card's answers file;
    // there is no File It button to name, W1-31).
    expect(m[0].sentence).toBe("On the supplier documents list with no bill yet: 8802-1108330, $653.25. Filing it makes the bill and links it to that document.");
  });

  it("a CED document a bill already covers IS that bill's purchase: offered as a tie to the covering bill", () => {
    const m = findSameNumber(
      receipt({ vendor: "CED", doc_number: "8802-1108330", doc_type: "bill" }),
      {
        supplierInvoices: [
          {
            id: "si-1",
            invoice_number: "8802-1108330",
            supplier_account_id: "acct-ced",
            total: 653.25,
            covered_by: { id: "bill-7", job_id: "job-046", jobs: { job_number: "J-046", name: "Jason Wexley" } },
          },
        ],
      },
      aliases,
    );
    expect(m).toEqual([expect.objectContaining({ kind: "bill", billId: "bill-7", jobId: "job-046" })]);
    expect(m[0].sentence).toBe("Already on the books: supplier document 8802-1108330, $653.25, covered by a bill on J-046 Jason Wexley.");
  });

  it("a covering bill that also carries the number is found once, not twice", () => {
    const m = findSameNumber(
      receipt({ vendor: "CED", doc_number: "8802-1108330", doc_type: "bill" }),
      {
        bills: [bill],
        supplierInvoices: [{ id: "si-1", invoice_number: "8802-1108330", supplier_account_id: "acct-ced", total: 653.25, covered_by: { id: "bill-1" } }],
      },
      aliases,
    );
    expect(m).toEqual([expect.objectContaining({ kind: "bill", billId: "bill-1" })]);
  });

  it("a short number is not matched on number alone", () => {
    expect(
      findSameNumber(receipt({ vendor: "Brandow's", doc_number: "1234" }), {
        supplierInvoices: [{ id: "si-2", invoice_number: "1234", supplier_account_id: null, total: 10 }],
      }),
    ).toEqual([]);
  });

  it("another paper still waiting with the same number is named", () => {
    const m = findSameNumber(receipt({ id: "p1", vendor: "Home Depot", doc_number: "H-77" }), {
      papers: [{ id: "p2", vendor: "home depot", doc_number: "h-77", status: "needs_review", bill_id: null, title: "IMG_2.jpg" }],
    });
    expect(m).toEqual([expect.objectContaining({ kind: "paper", itemId: "p2" })]);
  });
});
