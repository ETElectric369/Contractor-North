import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { quoteDraftShown, quoteDraftToolFor } from "./quote-draft-tax";

/**
 * SALES TAX OFF (0352, rule g) on Nort's live estimate preview. On: the very same tool and draft
 * (byte-identical). Off: no tax_rate offered, and none reaches the preview.
 */
const TOOL = {
  name: "quote_draft",
  description: "Include customer_name, a short title, tax_rate as a fraction, and the items.",
  input_schema: {
    type: "object",
    properties: { title: { type: "string" }, tax_rate: { type: "number" }, items: { type: "array" } },
    required: ["items"],
  },
};

describe("quote_draft and the Sales Tax switch", () => {
  it("on: the very same tool object", () => {
    expect(quoteDraftToolFor(TOOL, true)).toBe(TOOL);
  });

  it("off: no tax_rate property and no word of it in the description; the rest untouched", () => {
    const off = quoteDraftToolFor(TOOL, false);
    expect(Object.keys(off.input_schema.properties)).toEqual(["title", "items"]);
    expect(off.description).toBe("Include customer_name, a short title, and the items.");
    expect(off.input_schema.required).toEqual(["items"]);
    // The original is never mutated (it is a module constant shared by every request).
    expect(Object.keys(TOOL.input_schema.properties)).toContain("tax_rate");
  });

  it("the preview: on, byte-identical to today's spread; off, the rate is dropped", () => {
    const input = { title: "Panel", tax_rate: 0.0825, items: [{ description: "Panel" }] };
    expect(JSON.stringify({ kind: "quote", ...quoteDraftShown(input, true) })).toBe(JSON.stringify({ kind: "quote", ...(input as object) }));
    expect(quoteDraftShown(input, false)).toEqual({ title: "Panel", items: [{ description: "Panel" }] });
  });

  it("the real tool's description carries the exact words the off path takes out", () => {
    const route = readFileSync(fileURLToPath(new URL("../../app/api/chat/route.ts", import.meta.url)), "utf8");
    expect(route).toContain("a short title, tax_rate as a fraction, and the items.");
    expect(route).toContain("quoteDraftToolFor(QUOTE_DRAFT_TOOL, salesTax)");
    expect(route).toContain("quoteDraftShown(tu.input, salesTax)");
  });
});
