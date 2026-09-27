import { describe, it, expect } from "vitest";
import { DEFAULT_DOC_STYLE, TAGLINE_MAX, normalizeDocStyle } from "@/lib/doc-style";

/**
 * doc_style.tagline (Wave 0): the line under a company's name on its letterhead. It rides the public
 * /i and /q projections inside doc_style, so the one normalizer is its boundary: a trimmed string
 * of at most 80 characters, and "" (no line at all) for anything else. There is no default.
 */
describe("normalizeDocStyle: the tagline", () => {
  it("defaults to no tagline", () => {
    expect(DEFAULT_DOC_STYLE.tagline).toBe("");
    expect(normalizeDocStyle(undefined).tagline).toBe("");
    expect(normalizeDocStyle(null).tagline).toBe("");
    expect(normalizeDocStyle({}).tagline).toBe("");
    expect(normalizeDocStyle("junk").tagline).toBe("");
  });

  it("keeps the company's words, trimmed", () => {
    expect(normalizeDocStyle({ tagline: "Quality Work Since 1998" }).tagline).toBe("Quality Work Since 1998");
    expect(normalizeDocStyle({ tagline: "  Quality Work  " }).tagline).toBe("Quality Work");
    expect(normalizeDocStyle({ tagline: "   " }).tagline).toBe("");
  });

  it("is at most 80 characters, with no space left dangling at the cut", () => {
    expect(TAGLINE_MAX).toBe(80);
    const long = `${"a".repeat(79)} ${"b".repeat(30)}`;
    const out = normalizeDocStyle({ tagline: long }).tagline;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).toBe("a".repeat(79));
    expect(normalizeDocStyle({ tagline: "x".repeat(200) }).tagline).toBe("x".repeat(80));
  });

  it("anything but a string is no tagline", () => {
    for (const v of [42, true, ["Quality"], { text: "Quality" }, null]) {
      expect(normalizeDocStyle({ tagline: v }).tagline).toBe("");
    }
  });

  it("leaves the other knobs as they were, and stores only known keys", () => {
    const s = normalizeDocStyle({ tagline: "Quality Work", density: "airy", col_gap: 12, note: "INTERNAL" });
    expect(s.density).toBe("airy");
    expect(s.col_gap).toBe(12);
    expect(s).not.toHaveProperty("note");
    expect(Object.keys(normalizeDocStyle({})).sort()).toEqual(Object.keys(DEFAULT_DOC_STYLE).sort());
  });
});
