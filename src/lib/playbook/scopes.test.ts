import { describe, it, expect } from "vitest";
import { coerceScopes, ownScopes, scopeLines, scopeText, scopeTotal } from "./scopes";
import { coerceNeed } from "./answers";
import { parsePlaybook } from "./parse";
import { publicIntakeNeeds } from "./public-intake";
import type { Need } from "./types";

const need: Need = { key: "remodel", label: "Remodel scopes", ask: "What's in it?", slot: { type: "scopes", codes: ["R1", "R2"] } };
const BOOK = new Map([
  ["R1", { description: "Remodel — Demo & Tear-out", unit: "SQ FT" }],
  ["R2", { description: "Remodel — Framing / Plywood", unit: "SQ FT" }],
]);

describe("THE SECOND PRICING SHAPE — pick scopes, price them on site", () => {
  it("a $0.00 book row is legitimate: the price is discovered on site, not looked up", () => {
    // Erik: "thats why they are at zero becuase it gets built with the inspection". A pick with a
    // price the estimator typed must survive exactly as typed.
    const out = coerceScopes([{ code: "R1", qty: 120, price: 8.5 }]);
    expect(out).toEqual([{ code: "R1", qty: 120, price: 8.5 }]);
    expect(scopeTotal(out!)).toBe(1020);
  });

  it("qty defaults to 1 so a lump-sum scope is one tap, and a missing price is 0 not NaN", () => {
    expect(coerceScopes([{ code: "R5" }])).toEqual([{ code: "R5", qty: 1, price: 0 }]);
  });

  it("one row per code — picking the same scope twice is a mis-tap, never a silent sum", () => {
    const out = coerceScopes([{ code: "R1", qty: 1, price: 10 }, { code: "R1", qty: 5, price: 99 }]);
    expect(out).toHaveLength(1);
    expect(out![0].qty).toBe(1);
  });

  it("refuses junk and negative money rather than storing it", () => {
    expect(coerceScopes("R1")).toBeNull();
    expect(coerceScopes([])).toBeNull();
    expect(coerceScopes([{ code: "" }, null, 7])).toBeNull();
    expect(coerceScopes([{ code: "R1", qty: -4, price: -100 }])).toEqual([{ code: "R1", qty: 1, price: 0 }]);
  });

  it("a code that isn't in the org's own book is dropped at the boundary", () => {
    const picks = coerceScopes([{ code: "R1", qty: 1, price: 5 }, { code: "STOLEN", qty: 1, price: 5 }])!;
    expect(ownScopes(picks, new Set(BOOK.keys())).map((p) => p.code)).toEqual(["R1"]);
  });
});

describe("a pick becomes a quote line with nobody re-typing it", () => {
  it("description and unit come from the BOOK, never from the answer", () => {
    const picks = coerceScopes([{ code: "R1", qty: 120, price: 8.5 }])!;
    expect(scopeLines(picks, BOOK, "Remodel")).toEqual([
      { description: "Remodel — Demo & Tear-out", quantity: 120, unit: "SQ FT", unit_price: 8.5, group: "Remodel" },
    ]);
  });

  it("a code that left the price list still renders honestly rather than as a blank line", () => {
    const picks = coerceScopes([{ code: "GONE", qty: 2, price: 3 }])!;
    expect(scopeLines(picks, BOOK)[0]).toMatchObject({ description: "GONE", unit: "EA" });
  });

  it("says so out loud when a scope hasn't been priced yet", () => {
    expect(scopeText(coerceScopes([{ code: "R2" }])!, BOOK)).toContain("not priced yet");
  });
});

describe("the gates a new slot type has to pass", () => {
  it("the PARSER knows it — the cn-v661 lesson: an unknown slot fails OPEN, silently", () => {
    const parsed = parsePlaybook({ needs: [{ key: "r", label: "R", ask: "R?", slot: { type: "scopes", codes: ["R1"] } }] });
    expect(parsed.needs[0].slot).toEqual({ type: "scopes", codes: ["R1"] });
  });

  it("the COERCER routes to it through the real need", () => {
    expect(coerceNeed(need, [{ code: "R1", qty: 2, price: 50 }])).toEqual([{ code: "R1", qty: 2, price: 50 }]);
  });

  it("and the PUBLIC DOOR never renders it — its options are his price codes", () => {
    const out = publicIntakeNeeds({ needs: [need, { key: "ok", label: "Ok", ask: "Ok?" }] });
    expect(out.map((n) => n.key)).toEqual(["ok"]);
    expect(JSON.stringify(out)).not.toContain("R1");
  });
});
