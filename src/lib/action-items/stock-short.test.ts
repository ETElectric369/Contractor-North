import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { AFFORDANCES, KIND_META, KIND_STREAM } from "./types";

/**
 * SETTLE (Shop Stock, Phase 3). A take past what the shelf showed saves as a short ($0, billing
 * nothing), and the office gets one Settle item per short that stays until the short is settled or
 * its take undone. It is derived from the shelf's own record, so there is nothing a dismiss could
 * write: Open is its only verb, and it lands on Shop Stock, where Settle From The Shelf lives.
 */
describe("the Settle item", () => {
  it("is a money decision with one door", () => {
    expect(KIND_STREAM.stock_short).toBe("money");
    // Named for the fix that works: a count can't settle a short (audit v1018).
    expect(KIND_META.stock_short.label).toBe("Settle");
    expect(AFFORDANCES.stock_short).toEqual(["open"]);
  });

  it("is fed by every live, unsettled short, staff only, with its take's date in the words", () => {
    const src = readFileSync(new URL("./query.ts", import.meta.url), "utf8");
    const feeder = src.slice(src.indexOf("const shortsP"), src.indexOf(".limit(50))", src.indexOf("const shortsP")));
    expect(feeder).toContain('.from("stock_moves")');
    expect(feeder).toContain('.eq("kind", "short")');
    expect(feeder).toContain('.is("settled_by", null)');
    expect(feeder).toContain('.is("undone_at", null)');
    expect(src).toMatch(/const shortsP[^=]*= isStaff/);
    expect(src).toContain('kind: "stock_short"');
    const item = src.slice(src.indexOf('kind: "stock_short"'), src.indexOf("affordances: AFFORDANCES.stock_short"));
    // Never "3d overdue": nobody set a deadline. The date rides in the subtitle.
    expect(item).toContain("when: null");
    expect(item).toContain("formatDateShort(r.created_at");
    expect(item).toContain("Taken Past The Shelf · Settle It");
    expect(item).not.toMatch(/Recount/);
    // Straight to the item, opened (Shop Stock reads ?item=), and the words name what works.
    expect(src).toContain("/inventory?item=${encodeURIComponent(String(r.item_id))}");
    expect(feeder).toContain("item_id");
    expect(src).toContain("${SHORT_FIX}");
    expect(src).not.toContain("Count it or file the roll");
  });
});
