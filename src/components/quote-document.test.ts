import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuoteDocument, type QuoteDocItem } from "@/components/quote-document";
import type { EstimateFormat } from "@/lib/doc-style";

/**
 * THE BREAKDOWN UNDER A TASK LINE, ONE BULLET PER LABOR ROW (cn-v1131). Erik: "time and material
 * line items for each task optionally visible on the estimate itself". The document takes the
 * format from its mounter (estimateFormat, resolved through estimateFormatFor) and never reads
 * doc_style.estimate_format itself; under "detailed" each labor row prints its hours at its rate,
 * then the parts; a row that names a person reaches the public wire with its label null and prints
 * "Labor". An old row's {hours, rate} still prints as one bullet. A hand-priced line prints none.
 */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const render = (items: QuoteDocItem[], estimateFormat: EstimateFormat) =>
  text(
    renderToStaticMarkup(
      createElement(QuoteDocument, {
        co: { name: "Main Street Builders", brand: "#0f766e" },
        template: "classic",
        docLabel: "Estimate",
        number: "E-001",
        createdAt: "2026-08-29",
        customer: { name: "Sample Customer" },
        items,
        subtotal: items.reduce((t, i) => t + i.line_total, 0),
        tax: 0,
        total: items.reduce((t, i) => t + i.line_total, 0),
        estimateFormat,
      }),
    ),
  );

const breaker = { code: null, name: "Tandem breaker, 20A", qty: 2, cost: null, sell: 20 };

/** Two labor rows (one nameless — a person's row as the public wire ships it — one "Helper") + parts. */
const twoRows = {
  task_id: "t1",
  labor: [
    { label: null, person_id: null, hours: 4, rate: 125, rate_from: "rule" },
    { label: "Helper", person_id: null, hours: 4, rate: 85, rate_from: "hand" },
  ],
  units: null,
  kit_id: null,
  materials: [breaker],
};

const line = (unit_price: number, detail: unknown): QuoteDocItem => ({
  id: "q4",
  description: "Panel work: two tandem breakers, labeling, torque check",
  quantity: 1,
  unit: "ea",
  unit_price,
  line_total: unit_price,
  detail,
});

describe("QuoteDocument prints the breakdown the format asks for", () => {
  it("detailed: one bullet per labor row with its figures, the nameless row as Labor, then the parts", () => {
    const html = render([line(880, twoRows)], "detailed");
    expect(html).toContain("Labor · 4 h × $125.00 = $500.00");
    expect(html).toContain("Helper · 4 h × $85.00 = $340.00");
    expect(html).toContain("Tandem breaker, 20A × 2 · $40.00");
  });

  it("an old row's {hours, rate} prints as the one Labor bullet", () => {
    const html = render([line(290, { task_id: "t1", hours: 2, rate: 125, units: null, kit_id: null, materials: [breaker] })], "detailed");
    expect(html).toContain("Labor · 2 h × $125.00 = $250.00");
    expect(html.match(/ h × /g)?.length).toBe(1);
  });

  it("a row with no hours yet prints nothing; the rows with hours still do", () => {
    const html = render(
      [line(200, { ...twoRows, labor: [{ label: "Helper", person_id: null, hours: null, rate: 85, rate_from: "rule" }, { label: null, person_id: null, hours: 2, rate: 100, rate_from: "rule" }], materials: [] })],
      "detailed",
    );
    expect(html).toContain("Labor · 2 h × $100.00 = $200.00");
    expect(html).not.toContain("Helper");
  });

  it("THIS MANY OF THE TASK (cn-v1133; S1): at qty 2 the breakdown still explains the UNIT price, ONE sub-heading above the bullets says 'For each one:' and no bullet says 'each' (a part's money is its count × its price per task, never per part); at qty 1 nothing says it", () => {
    const two = render([{ ...line(880, twoRows), quantity: 2, line_total: 1760 }], "detailed");
    expect(two).toContain("For each one:");
    expect(two.indexOf("For each one:")).toBeLessThan(two.indexOf("Labor · 4 h"));
    expect(two).toContain("Labor · 4 h × $125.00 = $500.00");
    expect(two).toContain("Helper · 4 h × $85.00 = $340.00");
    expect(two).toContain("Tandem breaker, 20A × 2 · $40.00");
    expect(two).not.toMatch(/\$[\d,.]+ each/); // "$40.00 each" read as $40 per breaker: it is $20 × 2 per task
    expect(two).toContain("$1,760.00");
    const one = render([line(880, twoRows)], "detailed");
    expect(one).not.toContain("For each one:");
    expect(one).not.toContain(" each");
    // A part with no count prints as before under the one heading: no figure, no word.
    const uncounted = render([{ ...line(840, { ...twoRows, materials: [{ ...breaker, qty: null }] }), quantity: 3, line_total: 2520 }], "detailed");
    expect(uncounted).toContain("For each one:");
    expect(uncounted).toContain("Labor · 4 h × $125.00 = $500.00");
    expect(uncounted).toContain("Tandem breaker, 20A ");
    expect(uncounted).not.toContain("Tandem breaker, 20A each");
    // The heading rides only with a breakdown: a hand-priced line at qty 2 prints neither.
    const hand = render([{ ...line(999, twoRows), quantity: 2, line_total: 1998 }], "detailed");
    expect(hand).not.toContain("For each one:");
    expect(hand).not.toContain(" h × ");
  });

  it("tasks: the line alone, no bullets", () => {
    const html = render([line(880, twoRows)], "tasks");
    expect(html).not.toContain(" h × ");
    expect(html).not.toContain("Tandem breaker");
    expect(html).toContain("Panel work: two tandem breakers, labeling, torque check");
  });

  it("a hand-priced line prints no breakdown: the bullets must add up to the figure beside them", () => {
    const html = render([line(900, twoRows)], "detailed");
    expect(html).not.toContain(" h × ");
    expect(html).not.toContain("Tandem breaker");
    expect(html).toContain("$900.00");
  });

  it("a line with no detail prints as it always did under either format", () => {
    const plain: QuoteDocItem = { id: "q1", description: "Under-cabinet lighting run, kitchen", quantity: 1, unit: "lot", unit_price: 640, line_total: 640 };
    expect(render([plain], "detailed")).toBe(render([plain], "tasks"));
  });
});

/**
 * ONE MATERIALS LINE (cn-v1158). Erik, 2026-11-10: "an option to list out all the materials shown as
 * it is now and an option to group the materials into one materials line as im finding that different
 * people require different solutions." The third format, "grouped", is "detailed" with the parts
 * folded into ONE bullet under each task: the same labor bullets, the same gate, the same "For each
 * one:", and the figure is the sum the parts' bullets would have added up to. The whole table of the
 * three formats is tests/an-estimate-prints-three-ways.test.ts; the decision is paperBreakdown's
 * (lib/estimate/task-lines-paper.test.ts). These are the document's own.
 */
describe("QuoteDocument, grouped: the labor bullets, then ONE Materials line under the task", () => {
  it("one bullet per labor row exactly as detailed prints them, then the parts as one figure — no part is named", () => {
    const html = render([line(880, twoRows)], "grouped");
    expect(html).toContain("Labor · 4 h × $125.00 = $500.00");
    expect(html).toContain("Helper · 4 h × $85.00 = $340.00");
    expect(html).toContain("Materials · $40.00");
    expect(html.indexOf("Helper · 4 h")).toBeLessThan(html.indexOf("Materials · $40.00"));
    expect(html).not.toContain("Tandem breaker");
    expect(html.match(/Materials · /g)).toHaveLength(1);
    expect(html).not.toContain("For each one:");
  });

  it("an old row's {hours, rate} prints as the one Labor bullet and the Materials line", () => {
    const html = render([line(290, { task_id: "t1", hours: 2, rate: 125, units: null, kit_id: null, materials: [breaker] })], "grouped");
    expect(html).toContain("Labor · 2 h × $125.00 = $250.00");
    expect(html).toContain("Materials · $40.00");
    expect(html.match(/ h × /g)?.length).toBe(1);
  });

  it("no parts, or none priced: no Materials line at all — never $0.00", () => {
    const none = render([line(840, { ...twoRows, materials: [] })], "grouped");
    expect(none).toContain("Helper · 4 h × $85.00 = $340.00");
    expect(none).not.toContain("Materials");
    const unpriced = render([line(840, { ...twoRows, materials: [{ ...breaker, sell: null }, { ...breaker, name: "Blank plate", qty: null }] })], "grouped");
    expect(unpriced).toContain("Labor · 4 h × $125.00 = $500.00");
    expect(unpriced).not.toContain("Materials");
    expect(unpriced).not.toContain("Blank plate");
    expect(unpriced).not.toContain("Tandem breaker");
  });

  it("at qty 2 'For each one:' stands above the bullets and the figure is for ONE of the task; a hand-priced line prints none of it", () => {
    const two = render([{ ...line(880, twoRows), quantity: 2, line_total: 1760 }], "grouped");
    expect(two).toContain("For each one:");
    expect(two.indexOf("For each one:")).toBeLessThan(two.indexOf("Labor · 4 h"));
    expect(two).toContain("Materials · $40.00"); // one of the task, never $80.00 for the two
    expect(two).not.toContain("$80.00");
    expect(two).toContain("$1,760.00");
    const hand = render([{ ...line(900, twoRows), quantity: 2, line_total: 1800 }], "grouped");
    expect(hand).not.toContain("For each one:");
    expect(hand).not.toContain(" h × ");
    expect(hand).not.toContain("Materials");
    expect(hand).toContain("$900.00");
  });

  it("the customer's page: public_quote's grouped detail — no parts, their total in their place — prints the same paper", () => {
    const shipped = {
      hours: null,
      rate: null,
      units: null,
      labor: twoRows.labor.map(({ label, hours, rate }) => ({ label, hours, rate })),
      materials: [],
      materials_total: 40,
    };
    expect(render([line(880, shipped)], "grouped")).toBe(render([line(880, twoRows)], "grouped"));
    // A total that does not add up to the line prints nothing: the line alone, as under "tasks".
    expect(render([line(880, { ...shipped, materials_total: 45 })], "grouped")).toBe(render([line(880, shipped)], "tasks"));
  });

  it("a line with no detail prints as it always did under all three formats, and so does a note under a line", () => {
    const plain: QuoteDocItem = { id: "q1", description: "Under-cabinet lighting run, kitchen", quantity: 1, unit: "lot", unit_price: 640, line_total: 640 };
    expect(render([plain], "grouped")).toBe(render([plain], "tasks"));
    const noted: QuoteDocItem = { id: "q2", description: "Panel upgrade, 200A\nIncludes the permit\nTwo-day job", quantity: 1, unit: "ea", unit_price: 2400, line_total: 2400 };
    expect(render([noted], "grouped")).toBe(render([noted], "tasks"));
    expect(render([noted], "grouped")).toContain("Includes the permit");
  });
});

describe("A NOTE UNDER A LINE (cn-v1137): the description's lines after the head print as bullets", () => {
  it("'Head\\nNote line' prints the head and the note as one bullet under it, under either format", () => {
    const noted: QuoteDocItem = { id: "q2", description: "Panel upgrade, 200A\nIncludes the permit\nTwo-day job", quantity: 1, unit: "ea", unit_price: 2400, line_total: 2400 };
    for (const format of ["tasks", "detailed"] as EstimateFormat[]) {
      const html = renderToStaticMarkup(
        createElement(QuoteDocument, {
          co: { name: "Main Street Builders", brand: "#0f766e" },
          template: "classic",
          docLabel: "Estimate",
          number: "E-002",
          createdAt: "2026-10-28",
          customer: { name: "Sample Customer" },
          items: [noted],
          subtotal: 2400,
          tax: 0,
          total: 2400,
          estimateFormat: format,
        }),
      );
      expect(html).toContain("<div>Panel upgrade, 200A</div>");
      expect(html).toContain("<li>Includes the permit</li><li>Two-day job</li>");
    }
  });
});
