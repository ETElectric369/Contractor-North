import { describe, expect, it } from "vitest";
import { didYouMeanSupplier, exactKnownSupplier, knownSuppliersFrom, snapSupplierSpelling, type KnownSupplier } from "./supplier-suggest";

/**
 * "DID YOU MEAN?" FOR THE SUPPLIER BOX (item D, 2026-10-07). Made-up suppliers. The rule is
 * supplier-identity's own: exact keeps quiet and snaps to the one name; fuzzy only asks.
 */
const KNOWN: KnownSupplier[] = [
  { name: "Consolidated Electrical Distributors", spellings: ["CED", "C.E.D. Anytown"] },
  { name: "Anytown Electric Supply", spellings: [] },
  { name: "Mountain Hardware Inc", spellings: [] },
];

describe("exact: quiet, and snapped to the one name", () => {
  it("case, punctuation, an alias and a normalised spelling are all exact", () => {
    expect(exactKnownSupplier("ced", KNOWN)?.name).toBe("Consolidated Electrical Distributors");
    expect(exactKnownSupplier("c.e.d. anytown", KNOWN)?.name).toBe("Consolidated Electrical Distributors");
    expect(exactKnownSupplier("ANYTOWN ELECTRIC SUPPLY", KNOWN)?.name).toBe("Anytown Electric Supply");
    expect(exactKnownSupplier("Mountain Hardware, Inc.", KNOWN)?.name).toBe("Mountain Hardware Inc");
    expect(exactKnownSupplier("Home Depot", KNOWN)).toBeNull();
    expect(exactKnownSupplier("", KNOWN)).toBeNull();
  });

  it("snapSupplierSpelling stores the one name for an exact spelling and what was typed otherwise", () => {
    expect(snapSupplierSpelling("  ced ", KNOWN)).toBe("Consolidated Electrical Distributors");
    expect(snapSupplierSpelling("Mountain Hardware, Inc.", KNOWN)).toBe("Mountain Hardware Inc");
    expect(snapSupplierSpelling("  Home Depot ", KNOWN)).toBe("Home Depot");
    expect(snapSupplierSpelling("", KNOWN)).toBe("");
    // Nothing fuzzy is ever written: a near miss is kept as typed.
    expect(snapSupplierSpelling("Anytown Electric", KNOWN)).toBe("Anytown Electric");
  });
});

describe("fuzzy: it only asks", () => {
  it("says nothing on an exact spelling, under three letters, or on nothing like a known supplier", () => {
    expect(didYouMeanSupplier("CED", KNOWN)).toBeNull();
    expect(didYouMeanSupplier("Ce", KNOWN)).toBeNull();
    expect(didYouMeanSupplier("Pat's Plumbing", KNOWN)).toBeNull();
  });

  it("offers the one supplier it looks like, with the matcher's own reason", () => {
    const hint = didYouMeanSupplier("Anytown Electric", KNOWN);
    expect(hint && "name" in hint ? hint.name : null).toBe("Anytown Electric Supply");
    expect(hint && "name" in hint ? hint.why.length : 0).toBeGreaterThan(0);
    // The alias is enough to recognise the account by ("C.E.D." reads as the initials "CED").
    const byAlias = didYouMeanSupplier("C.E.D.", KNOWN);
    expect(byAlias && "name" in byAlias ? byAlias.name : null).toBe("Consolidated Electrical Distributors");
    // A plain typo is not the matcher's business: it asks nothing rather than guess.
    expect(didYouMeanSupplier("Home Depo", [{ name: "Home Depot #4421", spellings: [] }])).toBeNull();
  });

  it("two suppliers it could equally be: it asks which", () => {
    const twins: KnownSupplier[] = [
      { name: "Anytown Electric Supply", spellings: [] },
      { name: "Anytown Electric Distributors", spellings: [] },
    ];
    const hint = didYouMeanSupplier("Anytown Electric", twins);
    expect(hint && "choices" in hint ? hint.choices.sort() : null).toEqual(["Anytown Electric Distributors", "Anytown Electric Supply"]);
    // "Co" is a corporate suffix the rule sets aside: that one is exact, and quiet.
    expect(didYouMeanSupplier("Anytown Electric", [{ name: "Anytown Electric Co", spellings: [] }])).toBeNull();
  });
});

describe("the known list, folded once", () => {
  it("accounts carry their aliases; a bill spelling an account resolves joins it; the rest group under the fullest spelling", () => {
    const known = knownSuppliersFrom(
      [{ id: "a1", name: "Consolidated Electrical Distributors" }],
      [{ alias: "CED", supplier_account_id: "a1" }],
      ["ced", "C.E.D.", "Consolidated Electrical Distributors", "Home Depot", "HOME DEPOT", "Home Depot Inc", "Pat's Plumbing", null, ""],
    );
    const ced = known.find((k) => k.name === "Consolidated Electrical Distributors")!;
    expect(ced.spellings).toEqual(["CED"]);
    // "C.E.D." reads as the alias's initials: not a supplier of its own, so typing it asks.
    expect(known.some((k) => k.name === "C.E.D.")).toBe(false);
    const asks = didYouMeanSupplier("C.E.D.", known);
    expect(asks && "name" in asks ? asks.name : null).toBe("Consolidated Electrical Distributors");
    // The three Home Depot spellings are ONE known supplier, under the fullest spelling, never three
    // (case is not a spelling: supplier_aliases is unique on lower(alias), and so is this list).
    const hd = known.filter((k) => /home depot/i.test(k.name));
    expect(hd).toHaveLength(1);
    // The head spelling is the identity rule's own pick (pickHeadName); the other rides as a spelling.
    expect([hd[0].name, ...hd[0].spellings].sort()).toEqual(["Home Depot", "Home Depot Inc"]);
    expect(known.find((k) => k.name === "Pat's Plumbing")).toEqual({ name: "Pat's Plumbing", spellings: [] });
    expect(known.some((k) => !k.name)).toBe(false);
  });
});
