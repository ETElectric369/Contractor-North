import { describe, it, expect } from "vitest";
import { BLANK_PRESET, FEATURE_BY_KEY, featurePreset, type FeatureMap } from "@/lib/features";
import { TRADE_ORDER, TRADE_PACKAGES } from "@/lib/trade-package";
import { codesAddedWords, codesOfferWords, sheetOfferWords, switchesMovedWords, switchesOfferWords, tradeOffersFor } from "@/lib/trade-offers";

/**
 * THE PURE DIFF BEHIND "YOUR TRADE & PRICING" (cn-v1135): what a trade's package would add to a
 * company that already exists — codes under either spelling, only the switches the package names
 * and the company has the other way, a sheet only when there is none — and the words each offer
 * says. Nothing here moves anything.
 */
const blank: FeatureMap = { ...BLANK_PRESET };

describe("tradeOffersFor: codes", () => {
  it("offers only the codes the company lacks, counting an old spelling as had (TRBL is TROUB)", () => {
    const o = tradeOffersFor("electrical", { codes: ["svc", "TRBL", "Rough"], features: featurePreset("electrical"), hasSheet: true });
    const offered = o.codes.map((c) => c.code);
    expect(offered).not.toContain("SVC");
    expect(offered).not.toContain("TROUB"); // held as TRBL
    expect(offered).not.toContain("ROUGH"); // case does not matter
    expect(offered).toContain("PANEL");
    expect(o.codes.length).toBe(TRADE_PACKAGES.electrical.codes.length - 3);
    expect(o.menu).toBe("Electrical");
  });

  it("a company with the whole list, in any spelling, is offered nothing; a blank company the whole list", () => {
    for (const k of TRADE_ORDER) {
      const all = TRADE_PACKAGES[k].codes.map((c) => c.code.toLowerCase());
      expect(tradeOffersFor(k, { codes: all, features: blank, hasSheet: false }).codes, k).toEqual([]);
      expect(tradeOffersFor(k, { codes: [], features: blank, hasSheet: false }).codes, k).toEqual(TRADE_PACKAGES[k].codes);
    }
    // Every alias of every trade folds to a code in that trade's own list.
    for (const k of TRADE_ORDER) {
      const codes = new Set(TRADE_PACKAGES[k].codes.map((c) => c.code));
      for (const [old, now] of Object.entries(TRADE_PACKAGES[k].codeAliases)) {
        expect(codes.has(now), `${k} ${old} → ${now}`).toBe(true);
        expect(tradeOffersFor(k, { codes: [old], features: blank, hasSheet: false }).codes.map((c) => c.code)).not.toContain(now);
      }
    }
  });

  it("refuses a word that is not a trade rather than offering a blank package", () => {
    expect(() => tradeOffersFor("solar" as never, { codes: [], features: blank, hasSheet: false })).toThrow('There is no trade called "solar".');
  });
});

describe("tradeOffersFor: switches", () => {
  it("offers only the keys the package names whose value differs; a switch the owner set and the package does not name stays", () => {
    // A blank company moving to deck: the builder keys come on; its own hand-set sales_tax is not touched.
    const o = tradeOffersFor("deck", { codes: [], features: { ...blank, sales_tax: true }, hasSheet: false });
    expect(o.switches).toEqual([
      { key: "kits", on: true, words: "Kits & Sizing By Sq Ft on" },
      { key: "contracts", on: true, words: "Contracts & Lien Rights on" },
    ]);
    // A company already on deck's preset is offered nothing.
    expect(tradeOffersFor("deck", { codes: [], features: featurePreset("deck"), hasSheet: false }).switches).toEqual([]);
    // A package that turns a switch OFF offers the off move (landscaping: no permits).
    const land = tradeOffersFor("landscaping", { codes: [], features: { ...blank, permits: true }, hasSheet: false });
    expect(land.switches).toEqual([{ key: "permits", on: false, words: "Permits & Inspections off" }]);
    // An electrician moving to plumbing keeps its own panel map: plumbing's package does not name it.
    const plumb = tradeOffersFor("plumbing", { codes: [], features: featurePreset("electrical"), hasSheet: false });
    expect(plumb.switches).toEqual([]);
  });

  it("every move's words are the switch's Title Case label and on/off", () => {
    for (const k of TRADE_ORDER) {
      const o = tradeOffersFor(k, { codes: [], features: blank, hasSheet: false });
      for (const s of o.switches) expect(s.words).toBe(`${FEATURE_BY_KEY[s.key].label} ${s.on ? "on" : "off"}`);
    }
  });
});

describe("the words", () => {
  const o = tradeOffersFor("plumbing", { codes: ["SVC", "TRBL"], features: blank, hasSheet: false });

  it("the codes button counts what is new and names the codes; nothing new is a line, not a button", () => {
    const w = codesOfferWords(o);
    expect(w.button).toBe(`Add Plumbing's Job Codes (${o.codes.length} New)`);
    expect(w.line).toMatch(/^\d+ new: ROUGH, FINISH, /);
    expect(codesOfferWords({ menu: "Plumbing", codes: [] })).toEqual({ button: null, line: "You already have all of Plumbing's codes." });
  });

  it("the switches button lists the moves; none is a line", () => {
    expect(switchesOfferWords(o)).toEqual({ button: "Use Plumbing's Usual Switches", line: "Shop Stock on." });
    expect(switchesOfferWords({ menu: "Plumbing", switches: [] })).toEqual({ button: null, line: "Your switches already match." });
  });

  it("the sheet button only when there is no sheet; one that exists stays", () => {
    expect(sheetOfferWords(o).button).toBe("Start Plumbing's Inspection Sheet");
    expect(sheetOfferWords({ menu: "Plumbing", hasSheet: true })).toEqual({ button: null, line: "You already have an inspection sheet; it stays." });
  });

  it("after the doors ran: what moved, what was added, or that there was nothing to do", () => {
    expect(switchesMovedWords(o.switches)).toBe("Shop Stock on.");
    expect(switchesMovedWords([])).toBe("Nothing to change.");
    expect(codesAddedWords("Plumbing", 3, 2)).toBe("Added 3 of Plumbing's codes. 2 you already had stayed as they were.");
    expect(codesAddedWords("Plumbing", 3, 0)).toBe("Added 3 of Plumbing's codes.");
    expect(codesAddedWords("Plumbing", 0, 13)).toBe("You already had every one of Plumbing's codes.");
  });

  it("every button is Title Case apart from the trade's own menu row", () => {
    for (const k of TRADE_ORDER) {
      const off = tradeOffersFor(k, { codes: [], features: blank, hasSheet: false });
      const menu = TRADE_PACKAGES[k].menu;
      for (const b of [codesOfferWords(off).button, switchesOfferWords(off).button, sheetOfferWords(off).button]) {
        if (!b) continue;
        const rest = b.replace(menu, "Menu");
        for (const w of rest.split(/\s+/)) expect(w, b).toMatch(/^[A-Z(\d]/);
      }
    }
  });
});
