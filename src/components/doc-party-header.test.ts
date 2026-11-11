import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuoteDocument } from "@/components/quote-document";
import { InvoiceDocument } from "@/components/invoice-document";
import type { DocPartyCustomer } from "@/components/doc-templates";
import type { ResolvedSite } from "@/lib/site-address";

/**
 * THE PAPER'S HEADER, LAYOUT B (cn-v1160). The owner, 2026-11-10, in Document Studio: "it seems
 * like the main address has creeped out way to the right and i have no idea how to bring that back
 * over to the left margin under customer name". The party is ONE column now (label, name, company,
 * the address lines, then phone and email), and the Job Site sits in the right half of the SAME row
 * instead of in rows of its own below. Both papers draw it through DocPartyHeader. Stand-in data.
 */
const co = { name: "Main Street Builders", brand: "#0f766e" };

const full: DocPartyCustomer = {
  name: "Sam Tillery",
  company_name: "Alder Ridge Rentals",
  address: "10410 Bayberry Lane",
  unit: "4B",
  city: "Larkspur",
  state: "CA",
  zip: "96161",
  phone: "(530) 555-0142",
  email: "sam@example.com",
};

const site: ResolvedSite = {
  address: "88 Snowbell Ct",
  unit: "12",
  city: "Thistlewood",
  state: "CA",
  zip: "96145",
  source: "job",
  complete: true,
};

const quote = (customer: DocPartyCustomer, s: ResolvedSite | null) =>
  renderToStaticMarkup(
    createElement(QuoteDocument, {
      co,
      template: "classic",
      docLabel: "Estimate",
      number: "E-001",
      createdAt: "2026-11-10",
      customer,
      site: s,
      title: "Panel upgrade",
      items: [],
      subtotal: 0,
      tax: 0,
      total: 0,
    } as never),
  );

const invoice = (customer: DocPartyCustomer, s: ResolvedSite | null) =>
  renderToStaticMarkup(
    createElement(InvoiceDocument, {
      co,
      template: "classic",
      number: "INV-001",
      createdAt: "2026-11-10",
      customer,
      site: s,
      title: "Panel upgrade",
      items: [],
      subtotal: 0,
      tax: 0,
      total: 0,
      amountPaid: 0,
    } as never),
  );

const papers = [
  { name: "the estimate", render: quote, label: "Prepared for" },
  { name: "the invoice", render: invoice, label: "Bill to" },
] as const;

/** The markup of the header row: from the party label to the end of the grid that holds it. */
function headerRow(html: string, label: string): string {
  const at = html.indexOf(`>${label}</div>`);
  expect(at).toBeGreaterThan(-1);
  const gridAt = html.lastIndexOf('<div class="grid grid-cols-2 gap-x-6">', at);
  expect(gridAt).toBeGreaterThan(-1);
  // Walk the divs from the grid's opening tag to its matching close.
  let depth = 0;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = gridAt;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(gridAt, m.index + 6);
  }
  throw new Error("unclosed header row");
}

const inOrder = (s: string, parts: string[]) => {
  let from = 0;
  for (const p of parts) {
    const i = s.indexOf(p, from);
    expect(i, `${p} after position ${from}`).toBeGreaterThan(-1);
    from = i + p.length;
  }
};

describe.each(papers)("$name: the party column, then the Job Site in the same row", ({ render, label }) => {
  it("the party reads name, company, address, unit, town, then phone and email", () => {
    const row = headerRow(render(full, site), label);
    inOrder(row, [
      `>${label}</div>`,
      ">Sam Tillery<",
      ">Alder Ridge Rentals<",
      ">10410 Bayberry Lane<",
      ">Unit 4B<",
      ">Larkspur, CA 96161<",
      ">(530) 555-0142<",
      ">sam@example.com<",
      // the right half comes after the whole party column
      ">Job site</div>",
      ">88 Snowbell Ct<",
      ">Unit 12<",
      ">Thistlewood, CA 96145<",
    ]);
  });

  it("the Job Site is inside the header row, not below it, and prints exactly once", () => {
    const html = render(full, site);
    const row = headerRow(html, label);
    expect(row).toContain(">Job site</div>");
    expect(html.split(">Job site</div>").length).toBe(2);
    expect(html.split(">88 Snowbell Ct<").length).toBe(2);
  });

  it("no site: no Job site heading, and the party keeps its half of the row", () => {
    const html = render(full, null);
    expect(html).not.toContain("Job site");
    const row = headerRow(html, label);
    expect(row).toContain(">10410 Bayberry Lane<");
    expect(row).toMatch(/<div class="min-w-0"><\/div><\/div>$/); // the right half, empty
  });

  it("an address that already ends in a town, state and ZIP prints no second town line", () => {
    const row = headerRow(render({ ...full, unit: null, address: "10410 Bayberry Lane, Larkspur, CA 96161", city: "Larkspur Valley" }, null), label);
    expect(row).toContain(">10410 Bayberry Lane, Larkspur, CA 96161<");
    expect(row).not.toContain("Larkspur Valley");
  });

  it("a customer with no address prints no blank lines: name, company, then contact", () => {
    const row = headerRow(render({ ...full, address: null, unit: null, city: null, state: null, zip: null }, site), label);
    expect(row).not.toMatch(/<div class="text-slate-700"><\/div>/);
    expect(row).toMatch(/>Alder Ridge Rentals<\/div><div class="mt-1\.5 space-y-0\.5 border-l-2/);
  });

  it("no customer: the dash, and the site still prints in its half", () => {
    const row = headerRow(render(null, site), label);
    expect(row).toContain(">—</div>");
    expect(row).toContain(">Job site</div>");
  });

  it("the labels are the customer's words, exactly", () => {
    const html = render(full, site);
    expect(html).toContain(`>${label}</div>`);
    expect(html).toContain(">Job site</div>");
  });
});
