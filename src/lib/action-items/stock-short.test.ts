import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { AFFORDANCES, KIND_META, KIND_STREAM } from "./types";

/**
 * RECOUNT (Shop Stock, Phase 3). A take past what the shelf showed saves as a short ($0, billing
 * nothing), and the office gets one Recount item per short that stays until the short is settled or
 * its take undone. It is derived from the shelf's own record, so there is nothing a dismiss could
 * write: Open is its only verb, and it lands on Shop Stock, where Settle From The Shelf lives.
 */
describe("the Recount item", () => {
  it("is a money decision with one door", () => {
    expect(KIND_STREAM.stock_short).toBe("money");
    expect(KIND_META.stock_short.label).toBe("Recount");
    expect(AFFORDANCES.stock_short).toEqual(["open"]);
  });

  it("is fed by every live, unsettled short, staff only, dated by its take", () => {
    const src = readFileSync(new URL("./query.ts", import.meta.url), "utf8");
    const feeder = src.slice(src.indexOf("const shortsP"), src.indexOf(".limit(50))", src.indexOf("const shortsP")));
    expect(feeder).toContain('.from("stock_moves")');
    expect(feeder).toContain('.eq("kind", "short")');
    expect(feeder).toContain('.is("settled_by", null)');
    expect(feeder).toContain('.is("undone_at", null)');
    expect(src).toMatch(/const shortsP[^=]*= isStaff/);
    expect(src).toContain('kind: "stock_short"');
    expect(src).toContain("when: r.created_at");
    // Straight to the item, opened (Shop Stock reads ?item=), and the words name what works.
    expect(src).toContain("/inventory?item=${encodeURIComponent(String(r.item_id))}");
    expect(feeder).toContain("item_id");
    expect(src).toContain("${SHORT_FIX}");
    expect(src).not.toContain("Count it or file the roll");
  });
});
