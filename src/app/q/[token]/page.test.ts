import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE CUSTOMER'S ESTIMATE PAGE READS THE FORMAT THE SERVER RESOLVED (cn-v1158, 0408). public_quote
 * resolves how an estimate's task lines read — the estimate's own choice, else the company's — and
 * ships the breakdown that format prints and nothing more. Until 0408 a breakdown read one way, so
 * its presence on a line WAS the format; now there are two ("detailed": each part; "grouped": ONE
 * Materials figure, with no parts on the wire at all), so the RPC says the word itself as
 * quote.estimate_format and the page takes it. Until the migration is applied the key is absent and
 * the old inference stands exactly as it was.
 *
 * The page is rendered with react-dom/server over a mocked public_quote; the accept widget and the
 * stored-PDF check are not this test's business and are mocked out.
 */
const state = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: async () => ({ data: state.data }) }) }));
vi.mock("@/lib/pdf-cache", () => ({ sharePdfReady: async () => false }));
vi.mock("./accept", () => ({ PublicQuoteAccept: () => null }));

import PublicQuotePage from "./page";

const LABOR = [
  { label: null, hours: 4, rate: 125 },
  { label: "Helper", hours: 4, rate: 85 },
];
/** One line's detail as the "detailed" arm ships it: each part's name, count and sell. */
const DETAILED = { hours: null, rate: null, units: null, labor: LABOR, materials: [{ name: "Tandem breaker, 20A", qty: 2, sell: 20 }] };
/** The same line as the "grouped" arm ships it (0408): no parts, and their one total in their place. */
const GROUPED = { hours: null, rate: null, units: null, labor: LABOR, materials: [], materials_total: 40 };
/** 4 h × $125 + 4 h × $85 + two breakers at $20 = $880. Under "tasks" the RPC ships detail: null. */
const item = (detail: unknown, quantity = 1) => ({
  description: "Panel work: two tandem breakers, labeling, torque check",
  quantity,
  unit: "ea",
  unit_price: 880,
  line_total: 880 * quantity,
  detail,
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** The page over one public_quote answer. `quote` holds only what a case changes. */
async function page(quote: Record<string, unknown>, items: unknown[], docStyle?: unknown): Promise<string> {
  state.data = {
    quote: {
      quote_number: "E-021",
      status: "sent",
      title: "Panel work",
      description: null,
      notes: null,
      tax_rate: 0,
      subtotal: 880,
      tax: 0,
      total: 880,
      valid_until: null,
      circuits: null,
      doc_type: "estimate",
      created_at: "2026-11-10T18:00:00Z",
      ...quote,
    },
    items,
    customer: { name: "Sam Tillery", company_name: null, address: "14 Larkspur Ln", unit: null, city: null, state: null, zip: null },
    site_candidates: [{ source: "quote", parts: { address: null } }, null, null],
    org: { name: "Main Street Builders", doc_style: docStyle },
  };
  return text(renderToStaticMarkup(await PublicQuotePage({ params: Promise.resolve({ token: "tok-larkspur-021" }) })));
}

describe("the public estimate page prints the format public_quote resolved", () => {
  it("grouped: the labor bullets and ONE Materials line — no part is named, and none was on the wire", async () => {
    const html = await page({ estimate_format: "grouped" }, [item(GROUPED)]);
    expect(html).toContain("Labor · 4 h × $125.00 = $500.00");
    expect(html).toContain("Helper · 4 h × $85.00 = $340.00");
    expect(html).toContain("Materials · $40.00");
    expect(html).not.toContain("Tandem breaker");
    expect(html).not.toContain("For each one:");
    expect(JSON.stringify(state.data)).not.toContain("Tandem breaker");
  });

  it("grouped at Qty 2: 'For each one:' over the same bullets, the line total beside them", async () => {
    const html = await page({ estimate_format: "grouped", subtotal: 1760, total: 1760 }, [item(GROUPED, 2)]);
    expect(html).toContain("For each one:");
    expect(html.indexOf("For each one:")).toBeLessThan(html.indexOf("Labor · 4 h"));
    expect(html).toContain("Materials · $40.00");
    expect(html).toContain("$1,760.00");
  });

  it("detailed: each part by name, and no Materials line", async () => {
    const html = await page({ estimate_format: "detailed" }, [item(DETAILED)]);
    expect(html).toContain("Labor · 4 h × $125.00 = $500.00");
    expect(html).toContain("Tandem breaker, 20A × 2 · $40.00");
    expect(html).not.toContain("Materials · ");
  });

  it("tasks: the line alone — and the server's word stands even if a breakdown rode along", async () => {
    for (const detail of [null, DETAILED, GROUPED]) {
      const html = await page({ estimate_format: "tasks" }, [item(detail)]);
      expect(html).toContain("Panel work: two tandem breakers, labeling, torque check");
      expect(html).toContain("$880.00");
      expect(html).not.toContain(" h × ");
      expect(html).not.toContain("Materials · ");
      expect(html).not.toContain("Tandem breaker");
    }
  });

  it("the word is the SERVER's, already resolved: the company's own doc_style on the wire does not out-vote it", async () => {
    expect(await page({ estimate_format: "grouped" }, [item(GROUPED)], { estimate_format: "detailed" })).toContain("Materials · $40.00");
    expect(await page({ estimate_format: "detailed" }, [item(DETAILED)], { estimate_format: "grouped" })).toContain("Tandem breaker, 20A × 2 · $40.00");
    expect(await page({ estimate_format: "tasks" }, [item(null)], { estimate_format: "grouped" })).not.toContain(" h × ");
  });

  it("a grouped figure that does not add up prints nothing, and the price stands", async () => {
    const html = await page({ estimate_format: "grouped" }, [item({ ...GROUPED, materials_total: 41 })]);
    expect(html).not.toContain(" h × ");
    expect(html).not.toContain("Materials · ");
    expect(html).toContain("$880.00");
  });
});

describe("until 0408 is applied the key is absent, and the page reads as it did", () => {
  it("a breakdown on a line means detailed; none means tasks", async () => {
    const detailed = await page({}, [item(DETAILED)]);
    expect(detailed).toContain("Labor · 4 h × $125.00 = $500.00");
    expect(detailed).toContain("Tandem breaker, 20A × 2 · $40.00");
    const tasks = await page({}, [item(null)]);
    expect(tasks).not.toContain(" h × ");
    expect(tasks).toContain("$880.00");
    // One line with a breakdown among plain ones is enough, as before.
    expect(await page({}, [item(null), item(DETAILED)])).toContain("Tandem breaker, 20A × 2 · $40.00");
  });

  it("a company that already chose grouped ships no breakdown from the old RPC, so the page prints the lines alone", async () => {
    // 0395's public_quote ships a detail only when the resolved word is exactly 'detailed'.
    const html = await page({}, [item(null)], { estimate_format: "grouped" });
    expect(html).not.toContain(" h × ");
    expect(html).not.toContain("Materials · ");
  });

  it("a word that is not one of the three is not a format: the inference answers", async () => {
    for (const junk of ["itemized", "GROUPED", "", null, 7, true, ["grouped"]]) {
      expect(await page({ estimate_format: junk }, [item(DETAILED)]), String(junk)).toContain("Tandem breaker, 20A × 2 · $40.00");
      expect(await page({ estimate_format: junk }, [item(null)]), String(junk)).not.toContain(" h × ");
    }
  });
});
