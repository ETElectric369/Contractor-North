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
