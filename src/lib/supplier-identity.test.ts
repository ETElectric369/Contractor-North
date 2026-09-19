import { describe, it, expect } from "vitest";
import {
  normalizeSupplierName,
  matchSupplierNames,
  suggestSupplierGroups,
  resolveSupplierAccount,
  aliasKey,
  indexSupplierAliases,
  accountForSupplier,
  parseSupplierFilename,
  invoiceNumbersInLines,
  readBillInvoice,
  describeInvoiceReading,
  findDuplicateBills,
} from "@/lib/supplier-identity";

/** The supplier strings actually sitting in his bills table tonight, as scanned. */
const SCANNED = [
  "Consolidated Electrical Distributors, Inc. (CED)",
  "Consolidated Electrical Dist.",
  "Consolidated Electrical Distributors, Inc.",
  "Consolidated Electrical Distributors",
  "CED",
  "Contractors Electrical Distributors",
  "Ace Mountain Hardware",
  "Ace - Mountain Hardware",
  "Mountain Hardware and Sports",
  "Outdoor Supply Hardware (OSH - Cupertino)",
  "OSH - Cupertino",
  "Swigard's Hardware",
  "Swigards",
];

const groupWith = (name: string) =>
  suggestSupplierGroups(SCANNED).groups.find((g) => g.members.includes(name));

describe("the two stores that must never be merged", () => {
  // THIS IS THE FIRST TEST ON PURPOSE. "Ace Mountain Hardware" and "Mountain Hardware and Sports"
  // are two real Truckee storefronts that share two words, one of which is "hardware". Sweeping
  // them together would put one vendor's money on the other's balance.
  it("does not pair Ace Mountain Hardware with Mountain Hardware and Sports", () => {
    expect(matchSupplierNames("Ace Mountain Hardware", "Mountain Hardware and Sports")).toBeNull();
    expect(matchSupplierNames("Ace - Mountain Hardware", "Mountain Hardware and Sports")).toBeNull();
  });

  it("leaves Mountain Hardware and Sports standing alone in the whole book", () => {
    const { groups, candidates } = suggestSupplierGroups(SCANNED);
    expect(groups.some((g) => g.members.includes("Mountain Hardware and Sports"))).toBe(false);
    // Not even as a question: a shared trade word is not a reason to ask.
    expect(
      candidates.some((c) => c.a === "Mountain Hardware and Sports" || c.b === "Mountain Hardware and Sports"),
    ).toBe(false);
  });

  it("still sees the hyphen for what it is and pairs the two Ace spellings", () => {
    const g = groupWith("Ace Mountain Hardware");
    expect(g?.members.sort()).toEqual(["Ace - Mountain Hardware", "Ace Mountain Hardware"]);
    expect(g?.confidence).toBe("strong");
    // The cleaner spelling is the one offered for the account name.
    expect(g?.suggestedName).toBe("Ace Mountain Hardware");
  });
});

describe("normalising a scanned supplier name", () => {
  it("reads all four long CED spellings as one name", () => {
    const keys = new Set([
      normalizeSupplierName("Consolidated Electrical Distributors, Inc. (CED)"),
      normalizeSupplierName("Consolidated Electrical Dist."),
      normalizeSupplierName("Consolidated Electrical Distributors, Inc."),
      normalizeSupplierName("Consolidated Electrical Distributors"),
    ]);
    expect([...keys]).toEqual(["consolidated electric distributors"]);
  });

  it("drops possessives and treats & and and alike", () => {
    expect(normalizeSupplierName("Swigard's Hardware")).toBe("swigards hardware");
    expect(normalizeSupplierName("Mountain Hardware & Sports")).toBe(
      normalizeSupplierName("Mountain Hardware and Sports"),
    );
  });

  it("keeps Contractors and Consolidated apart", () => {
    expect(normalizeSupplierName("Contractors Electrical Distributors")).not.toBe(
      normalizeSupplierName("Consolidated Electrical Distributors"),
    );
  });
});

describe("the CED pile", () => {
  it("proposes the five CED spellings as one account", () => {
    const g = groupWith("CED");
    expect(g?.members.sort()).toEqual(
      [
        "CED",
        "Consolidated Electrical Dist.",
        "Consolidated Electrical Distributors",
        "Consolidated Electrical Distributors, Inc.",
        "Consolidated Electrical Distributors, Inc. (CED)",
      ].sort(),
    );
    expect(g?.suggestedName).toBe("Consolidated Electrical Distributors");
    expect(g?.reasons.join(" ")).toContain("written inside it");
  });

  it("never sweeps the Sunnyvale storefront into that account", () => {
    const g = groupWith("CED");
    expect(g?.members).not.toContain("Contractors Electrical Distributors");
    expect(groupWith("Contractors Electrical Distributors")).toBeUndefined();
  });

  it("surfaces Contractors Electrical Distributors as a question, with the reason", () => {
    const { candidates } = suggestSupplierGroups(SCANNED);
    const q = candidates.find(
      (c) => c.a === "Contractors Electrical Distributors" || c.b === "Contractors Electrical Distributors",
    );
    expect(q).toBeTruthy();
    expect(q!.confidence).toBe("possible");
    const reason = q!.reasons.join(" ");
    expect(reason).toContain("CED");
    // Quoted the way HE spelled them, not as normalised tokens.
    expect(reason).toContain('"Consolidated"');
    expect(reason).toContain('"Contractors"');
    expect(reason.toLowerCase()).toContain("only you know");
    // Asked once, not once per spelling of Consolidated.
    expect(
      candidates.filter(
        (c) => c.a === "Contractors Electrical Distributors" || c.b === "Contractors Electrical Distributors",
      ),
    ).toHaveLength(1);
  });

  it("refuses to place a bare CED when its initials fit two suppliers", () => {
    // Take away the one spelling that writes "(CED)" inside itself and the only evidence left is
    // initials that fit both Consolidated and Contractors. It must ask rather than pick.
    const withoutBracket = SCANNED.filter((s) => !s.includes("(CED)"));
    const { groups, candidates } = suggestSupplierGroups(withoutBracket);
    expect(groups.some((g) => g.members.includes("CED"))).toBe(false);
    const asks = candidates.filter((c) => c.a === "CED" || c.b === "CED");
    expect(asks.length).toBe(2);
    expect(asks[0].reasons.join(" ")).toContain("more than one supplier");
  });
});

describe("the other splits in his book", () => {
  it("pairs the two OSH spellings on what he wrote in the brackets", () => {
    const g = groupWith("OSH - Cupertino");
    expect(g?.members.sort()).toEqual(["OSH - Cupertino", "Outdoor Supply Hardware (OSH - Cupertino)"]);
    expect(g?.suggestedName).toBe("Outdoor Supply Hardware (OSH - Cupertino)");
  });

  it("pairs Swigards with Swigard's Hardware", () => {
    const g = groupWith("Swigards");
    expect(g?.members.sort()).toEqual(["Swigard's Hardware", "Swigards"]);
    expect(g?.suggestedName).toBe("Swigard's Hardware");
    expect(g?.reasons.join(" ")).toContain('"Hardware"');
  });

  it("proposes nothing at all for a book with no near-misses in it", () => {
    const { groups, candidates } = suggestSupplierGroups(["Home Depot", "Swigards", "CED"]);
    expect(groups).toEqual([]);
    expect(candidates).toEqual([]);
  });

  it("says nothing about a name and itself, or about empty strings", () => {
    expect(matchSupplierNames("CED", "ced")).toBeNull();
    expect(matchSupplierNames("CED", "")).toBeNull();
    expect(suggestSupplierGroups([null, undefined, "  "]).groups).toEqual([]);
  });

  it("never returns an em-dash in anything a person reads", () => {
    const { groups, candidates } = suggestSupplierGroups(SCANNED);
    const copy = [...groups.flatMap((g) => g.reasons), ...candidates.flatMap((c) => c.reasons)].join(" ");
    expect(copy).not.toContain("—");
    expect(copy).not.toContain("–");
  });
});

describe("an alias is the only automatic mapping", () => {
  const aliases = [
    { alias: "Consolidated Electrical Dist.", supplier_account_id: "acct-ced" },
    { alias: "CED", supplier_account_id: "acct-ced" },
  ];

  it("matches a spelling a person already filed, ignoring case and stray spaces", () => {
    expect(resolveSupplierAccount("consolidated electrical dist.", aliases)).toBe("acct-ced");
    expect(resolveSupplierAccount("  CED ", aliases)).toBe("acct-ced");
  });

  it("returns null rather than guessing at a spelling nobody has filed", () => {
    expect(resolveSupplierAccount("Consolidated Electrical Distributors", aliases)).toBeNull();
    expect(resolveSupplierAccount("", aliases)).toBeNull();
    expect(resolveSupplierAccount("CED", [])).toBeNull();
  });

  it("keys a spelling exactly the way the unique index does, and no further", () => {
    // lower(alias) with the whitespace trimmed. Punctuation is NOT folded here: if it were, the
    // app would refuse "C.E.D." as taken by "CED" while the database would accept it happily.
    expect(aliasKey("  Consolidated Electrical Dist.  ")).toBe("consolidated electrical dist.");
    expect(aliasKey("C.E.D.")).not.toBe(aliasKey("CED"));
    expect(aliasKey(null)).toBe("");
  });

  it("indexes aliases once and looks an account up off the index", () => {
    const index = indexSupplierAliases(aliases);
    expect(accountForSupplier("ced", index)).toBe("acct-ced");
    expect(accountForSupplier("Consolidated Electrical Distributors", index)).toBeNull();
    expect(accountForSupplier("CED", null)).toBeNull();
    expect(indexSupplierAliases([{ alias: "  ", supplier_account_id: "x" }]).size).toBe(0);
  });
});

describe("reading the invoice number off a CED portal filename", () => {
  it("reads account, date and invoice number", () => {
    expect(parseSupplierFilename("TR-34426_20260616_32136931_15165103264.pdf")).toEqual({
      accountNumber: "TR-34426",
      date: "2026-06-16",
      invoiceNumber: "32136931",
      internalId: "15165103264",
    });
  });

  it("sees through both importer prefixes and a reconciliation note underneath", () => {
    expect(
      parseSupplierFilename("Receipt recorded as cost: TR-34426_20260730_32270817_15165103264.pdf")?.invoiceNumber,
    ).toBe("32270817");
    expect(
      parseSupplierFilename("Receipt filed by Organize My: TR-34426_20260616_32136931_15165103264.pdf")?.date,
    ).toBe("2026-06-16");
    expect(
      parseSupplierFilename(
        "Receipt recorded as cost: TR-34426_20260616_32136931_15165103264.pdf\n\nCHECK THIS ONE: the items read off this receipt add up to...",
      )?.invoiceNumber,
    ).toBe("32136931");
  });

  it("returns null, never a guess, for everything that is not that shape", () => {
    for (const bad of [
      "image.jpg",
      "85 Whit.pdf",
      "85 Whitney Pl - CED.pdf",
      "Receipt recorded as cost: 85 Whit.pdf",
      "TR-34426_20260616_32136931.pdf", // three parts, not four
      "TR-34426_20261345_32136931_151.pdf", // month 13 is not a date
      "",
      null,
      undefined,
    ]) {
      expect(parseSupplierFilename(bad as string)).toBeNull();
    }
  });
});

describe("reading invoice numbers out of OCR'd line descriptions", () => {
  it("pulls the number out of a tax line", () => {
    const r = invoiceNumbersInLines(["Sales Tax 9.00000 (Invoice 8802-1101363)"]);
    expect(r.numbers).toEqual(["8802-1101363"]);
    expect(r.invoiceNumber).toBe("8802-1101363");
    expect(r.isStatement).toBe(false);
  });

  it("calls a bill carrying two invoice numbers a statement, with no single number", () => {
    const r = invoiceNumbersInLines([
      "Sales Tax 9.00000 (Invoice 8802-1101363)",
      "5/6 in RL, 900/1200LM 5CCT D2W (Invoice 8802-1105963)",
      "Sales Tax 9.00000 (Invoice 8802-1105963)",
    ]);
    expect(r.numbers).toEqual(["8802-1101363", "8802-1105963"]);
    expect(r.isStatement).toBe(true);
    expect(r.invoiceNumber).toBeNull();
  });

  it("finds nothing in lines that carry nothing", () => {
    const r = invoiceNumbersInLines(["3/4 EMT connector", null, "", undefined]);
    expect(r.numbers).toEqual([]);
    expect(r.isStatement).toBe(false);
    expect(r.invoiceNumber).toBeNull();
  });
});

describe("one reading per bill", () => {
  it("prefers the portal filename when the lines carry no number", () => {
    const r = readBillInvoice({
      notes: "Receipt recorded as cost: TR-34426_20260616_32136931_15165103264.pdf",
      lineDescriptions: ["3/4 EMT connector"],
    });
    expect(r.invoiceNumber).toBe("32136931");
    expect(r.source).toBe("filename");
    expect(r.file?.accountNumber).toBe("TR-34426");
    expect(describeInvoiceReading(r)).toContain("TR-34426");
  });

  it("a statement has no single number, whatever the file was called", () => {
    const r = readBillInvoice({
      notes: "Receipt recorded as cost: TR-34426_20260616_32136931_15165103264.pdf",
      lineDescriptions: ["Sales Tax (Invoice 8802-1101363)", "Wire (Invoice 8802-1105963)"],
    });
    expect(r.isStatement).toBe(true);
    expect(r.invoiceNumber).toBeNull();
    expect(r.numbers).toHaveLength(2);
    expect(describeInvoiceReading(r)).toContain("statement");
  });

  it("falls back to the one number on the lines when the file name says nothing", () => {
    const r = readBillInvoice({
      notes: "Receipt filed by Organize My: 85 Whit.pdf",
      lineDescriptions: ["Sales Tax (Invoice 8802-1101363)"],
    });
    expect(r.source).toBe("lines");
    expect(r.invoiceNumber).toBe("8802-1101363");
    expect(r.file).toBeNull();
  });

  it("says so plainly when there is nothing to read", () => {
    const r = readBillInvoice({ notes: "Receipt filed by Organize My: image.jpg", lineDescriptions: [] });
    expect(r.invoiceNumber).toBeNull();
    expect(r.source).toBeNull();
    expect(describeInvoiceReading(r)).toBe("No invoice number found on this one.");
  });
});

describe("the same ticket filed to two jobs", () => {
  // The real pair in his book: $95.27, 8 lines, CED, one filed 07-29 to 13631 Northwoods and one
  // filed 08-28 to 85 Whitney Place.
  const northwoods = {
    id: "b1",
    supplier: "Consolidated Electrical Distributors, Inc.",
    amount: 95.27,
    billDate: "2026-07-29",
    jobLabel: "13631 Northwoods",
    lineCount: 8,
  };
  const whitney = {
    id: "b2",
    supplier: "Consolidated Electrical Dist.",
    amount: 95.27,
    billDate: "2026-08-28",
    jobLabel: "85 Whitney Place",
    lineCount: 8,
  };

  it("asks about it, naming both jobs, and picks neither", () => {
    const found = findDuplicateBills([northwoods, whitney]);
    expect(found).toHaveLength(1);
    expect(found[0].amount).toBe(95.27);
    expect(found[0].reason).toContain("13631 Northwoods");
    expect(found[0].reason).toContain("85 Whitney Place");
    expect(found[0].reason).toContain("until you say which");
  });

  it("stays quiet when only the amount matches", () => {
    expect(findDuplicateBills([northwoods, { ...whitney, lineCount: 3 }])).toEqual([]);
    expect(findDuplicateBills([northwoods, { ...whitney, supplier: "Swigards", lineCount: 8 }])).toEqual([]);
    expect(findDuplicateBills([northwoods, { ...whitney, amount: 95.28 }])).toEqual([]);
  });

  it("matches on a shared invoice number even when the line counts differ", () => {
    const found = findDuplicateBills([
      { ...northwoods, lineCount: 8, invoiceNumber: "8802-1101363" },
      { ...whitney, lineCount: 2, invoiceNumber: "8802-1101363" },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toContain("8802-1101363");
  });
});

describe("one distinctive word is a question, not a merge (cn-v963 review)", () => {
  /**
   * The shared-trade-word rule is what protects Ace Mountain Hardware from Mountain Hardware and
   * Sports. Applied to names that reduce to a SINGLE distinctive word it argued the other way and
   * proposed folding a hardware store into an equipment yard.
   */
  it("does not group Ace Hardware with Ace Rentals", () => {
    const m = matchSupplierNames("Ace Hardware", "Ace Rentals");
    expect(m?.confidence === "strong" || m?.confidence === "likely").toBe(false);
  });
  it("still groups two spellings of the same one-word name", () => {
    const m = matchSupplierNames("Ace Hardware", "Ace Hardware Inc.");
    expect(m?.confidence === "strong" || m?.confidence === "likely").toBe(true);
  });
  it("keeps the real CED spellings together", () => {
    const m = matchSupplierNames("Consolidated Electrical Distributors, Inc.", "Consolidated Electrical Dist.");
    expect(m?.confidence === "strong" || m?.confidence === "likely").toBe(true);
  });
});

describe("a shorter name is not a conflicting one (cn-v963 review, second pass)", () => {
  it("still pairs Swigards with Swigard's Hardware", () => {
    const m = matchSupplierNames("Swigards", "Swigard's Hardware");
    expect(m?.confidence === "strong" || m?.confidence === "likely").toBe(true);
  });
  it("still refuses Ace Hardware against Ace Rentals", () => {
    const m = matchSupplierNames("Ace Hardware", "Ace Rentals");
    expect(m?.confidence === "strong" || m?.confidence === "likely").toBe(false);
  });
});
