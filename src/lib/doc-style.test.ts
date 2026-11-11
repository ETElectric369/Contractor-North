import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DOC_STYLE, ESTIMATE_FORMATS, TAGLINE_MAX, estimateFormatFor, isEstimateFormat, normalizeDocStyle, type EstimateFormat } from "@/lib/doc-style";

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

/**
 * doc_style.estimate_format (0386): how an estimate built from tasks reads to the customer. Rides
 * the public /q projection inside doc_style, so the one normalizer is its boundary: exactly three
 * words (two until cn-v1158 added "grouped", the parts as ONE Materials line under each task), and
 * "tasks" (one line per task, the price beside it) for anything else.
 */
describe("normalizeDocStyle: the estimate format", () => {
  it("defaults to one line per task", () => {
    expect(DEFAULT_DOC_STYLE.estimate_format).toBe("tasks");
    expect(normalizeDocStyle(undefined).estimate_format).toBe("tasks");
    expect(normalizeDocStyle({}).estimate_format).toBe("tasks");
    expect(normalizeDocStyle({ estimate_format: "itemized" }).estimate_format).toBe("tasks");
    expect(normalizeDocStyle({ estimate_format: 1 }).estimate_format).toBe("tasks");
  });

  it("keeps the detailed format when the company chose it", () => {
    expect(normalizeDocStyle({ estimate_format: "detailed" }).estimate_format).toBe("detailed");
  });

  it("keeps grouped (cn-v1158) when the company chose it, and a word that is not a format is tasks", () => {
    expect(normalizeDocStyle({ estimate_format: "grouped" }).estimate_format).toBe("grouped");
    expect(normalizeDocStyle({ estimate_format: "bogus" }).estimate_format).toBe("tasks");
    // Near misses are not the word: the stored value is exact or it is the default.
    for (const near of ["Grouped", "GROUPED", " grouped", "grouped ", "group", "materials", ["grouped"], { is: "grouped" }, true, null]) {
      expect(normalizeDocStyle({ estimate_format: near }).estimate_format, String(near)).toBe("tasks");
    }
    // The other knobs are untouched by the new word.
    expect(normalizeDocStyle({ estimate_format: "grouped", density: "airy", col_gap: 12 })).toMatchObject({ estimate_format: "grouped", density: "airy", col_gap: 12 });
  });
});

/**
 * isEstimateFormat (cn-v1158): THE one list of the ways a task line prints. Every door that stores or
 * reads a format asks it — the normalizer above, estimateFormatFor below, the estimate's save doors
 * and the customer's page, which takes the word public_quote resolved only when it is one of these.
 */
describe("isEstimateFormat: the three words, nothing else", () => {
  it("tasks, detailed and grouped — in that order, and that is the whole list", () => {
    expect([...ESTIMATE_FORMATS]).toEqual(["tasks", "detailed", "grouped"]);
    for (const word of ESTIMATE_FORMATS) expect(isEstimateFormat(word)).toBe(true);
  });

  it("anything else is not a format: another word, another case, a padded word, or not a string at all", () => {
    for (const not of ["bogus", "itemized", "", "Tasks", "DETAILED", "Grouped", " grouped", "grouped ", "tasks,detailed", 0, 1, true, false, null, undefined, [], ["grouped"], {}, { estimate_format: "grouped" }]) {
      expect(isEstimateFormat(not), JSON.stringify(not)).toBe(false);
    }
  });

  it("narrows: what passes is an EstimateFormat a paper can be handed", () => {
    const raw: unknown = "grouped";
    const format: EstimateFormat = isEstimateFormat(raw) ? raw : "tasks";
    expect(format).toBe("grouped");
  });
});

/**
 * doc_style.show_billing_type (cn-v1152): the "Time & Material · Progress Payment" line over an invoice's
 * title. Erik, 2026-11-07, on a bill he had retitled "Kitchen lighting" so the line said nothing new: it
 * "only needs to be there if its carrying new and needed information". One per-company switch through the
 * one normalizer, read the way show_breakdown is: absent is today's paper (on), anything stored is a boolean.
 */
describe("normalizeDocStyle: the billing-type line", () => {
  it("is on by default — today's paper, and a company that never opened the studio", () => {
    expect(DEFAULT_DOC_STYLE.show_billing_type).toBe(true);
    expect(normalizeDocStyle(undefined).show_billing_type).toBe(true);
    expect(normalizeDocStyle(null).show_billing_type).toBe(true);
    expect(normalizeDocStyle({}).show_billing_type).toBe(true);
    expect(normalizeDocStyle({ show_breakdown: false, density: "airy" }).show_billing_type).toBe(true);
  });

  it("off when the company turned it off; on when it turned it back on", () => {
    expect(normalizeDocStyle({ show_billing_type: false }).show_billing_type).toBe(false);
    expect(normalizeDocStyle({ show_billing_type: true }).show_billing_type).toBe(true);
  });

  it("anything stored is read as a boolean, like show_breakdown", () => {
    expect(normalizeDocStyle({ show_billing_type: "yes" }).show_billing_type).toBe(true);
    expect(normalizeDocStyle({ show_billing_type: 1 }).show_billing_type).toBe(true);
    expect(normalizeDocStyle({ show_billing_type: 0 }).show_billing_type).toBe(false);
    expect(normalizeDocStyle({ show_breakdown: "yes" }).show_breakdown).toBe(true);
    expect(normalizeDocStyle({ show_breakdown: 0 }).show_breakdown).toBe(false);
  });
});

/** The switch is in the Document Studio beside the Labor / Materials Box, and InvoiceDocument is its one reader. */
describe("the billing-type line: one switch, one reader", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("Document Studio: a Billing Type Line switch, saved with the other knobs, shown on the sample sheet", () => {
    const studio = src("src/app/(app)/doc-studio/studio.tsx");
    expect(studio).toContain("checked={style.show_billing_type}");
    expect(studio).toContain("apply({ ...style, show_billing_type: e.target.checked })");
    expect(studio).toMatch(/\n\s+Billing Type Line\n\s+<\/label>/);
    // The sample sheet carries the line, so the switch shows its effect in the preview.
    expect(studio).toContain("billingLabel={SAMPLE_BILLING_LABEL}");
    // The layout reset (DEFAULT_DOC_STYLE) puts the line back on, like every other knob.
    expect(DEFAULT_DOC_STYLE.show_billing_type).toBe(true);
  });

  it("InvoiceDocument draws the line only when the company's doc_style says so, and the title's margin follows", () => {
    const doc = src("src/components/invoice-document.tsx");
    expect(doc).toContain("const typeLine = ds.show_billing_type ? billingLabel : null;");
    expect(doc).toContain("{typeLine && (");
    expect(doc).toContain('${typeLine ? "mt-3" : "mt-5"}');
    expect(doc).not.toContain("{billingLabel && (");
  });
});

/**
 * estimateFormatFor (cn-v1131, 0395): an estimate may say for itself how its task lines read
 * (quotes.estimate_format); null is the company's Doc Studio choice. ONE reader for the print page,
 * the PDF, the studio sample and the /q page's coalesce, so no two surfaces disagree about one estimate.
 */
describe("estimateFormatFor: the estimate's own word, else the company's", () => {
  // The company's word is any of the three since cn-v1158 (it was "tasks" | "detailed"): the type
  // follows the one list, so "grouped" can be the company's default in the cases below.
  const company = (estimate_format: EstimateFormat) => ({ estimate_format });

  it("the estimate's own choice wins over the company's", () => {
    expect(estimateFormatFor({ estimate_format: "detailed" }, company("tasks"))).toBe("detailed");
    expect(estimateFormatFor({ estimate_format: "tasks" }, company("detailed"))).toBe("tasks");
  });

  it("null, absent or no estimate at all is the company's", () => {
    expect(estimateFormatFor({ estimate_format: null }, company("detailed"))).toBe("detailed");
    expect(estimateFormatFor({ estimate_format: null }, company("tasks"))).toBe("tasks");
    expect(estimateFormatFor({}, company("detailed"))).toBe("detailed");
    expect(estimateFormatFor(null, company("detailed"))).toBe("detailed");
    expect(estimateFormatFor(undefined, company("tasks"))).toBe("tasks");
  });

  it("junk on the estimate is the company's; junk on the company is tasks", () => {
    expect(estimateFormatFor({ estimate_format: "itemized" }, company("detailed"))).toBe("detailed");
    expect(estimateFormatFor({ estimate_format: 1 }, company("tasks"))).toBe("tasks");
    expect(estimateFormatFor({ estimate_format: "junk" }, { estimate_format: "nope" as never })).toBe("tasks");
    expect(estimateFormatFor({ estimate_format: "detailed" }, { estimate_format: "nope" as never })).toBe("detailed");
  });

  it("grouped (cn-v1158): the estimate's own grouped wins over either company default", () => {
    expect(estimateFormatFor({ estimate_format: "grouped" }, company("tasks"))).toBe("grouped");
    expect(estimateFormatFor({ estimate_format: "grouped" }, company("detailed"))).toBe("grouped");
    // And the estimate's own word wins over a company that chose grouped.
    expect(estimateFormatFor({ estimate_format: "tasks" }, company("grouped"))).toBe("tasks");
    expect(estimateFormatFor({ estimate_format: "detailed" }, company("grouped"))).toBe("detailed");
  });

  it("grouped: a null estimate (or none) takes the company's grouped", () => {
    expect(estimateFormatFor({ estimate_format: null }, company("grouped"))).toBe("grouped");
    expect(estimateFormatFor({}, company("grouped"))).toBe("grouped");
    expect(estimateFormatFor(null, company("grouped"))).toBe("grouped");
    expect(estimateFormatFor(undefined, company("grouped"))).toBe("grouped");
    // Read straight off a normalized doc_style, the way the print page hands it over.
    expect(estimateFormatFor({ estimate_format: null }, normalizeDocStyle({ estimate_format: "grouped" }))).toBe("grouped");
  });

  it("'bogus' on the estimate is not a choice: it takes the company's, whichever of the three that is", () => {
    for (const theirs of ESTIMATE_FORMATS) {
      expect(estimateFormatFor({ estimate_format: "bogus" }, company(theirs)), theirs).toBe(theirs);
      expect(estimateFormatFor({ estimate_format: "Grouped" }, company(theirs)), theirs).toBe(theirs);
    }
  });

  it("every pairing: the estimate's word when it has one, else the company's — nine in, nine right", () => {
    for (const own of ESTIMATE_FORMATS) for (const theirs of ESTIMATE_FORMATS) expect(estimateFormatFor({ estimate_format: own }, company(theirs))).toBe(own);
  });
});
