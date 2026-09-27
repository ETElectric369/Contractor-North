import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader } from "@/components/doc-templates";
import { QuoteDocument } from "@/components/quote-document";
import { renderInvoiceNoticeEmail, renderQuoteNoticeEmail } from "@/lib/email";
import type { Organization } from "@/lib/types";

/**
 * THE TAGLINE UNDER A COMPANY'S NAME IS ITS OWN (Wave 0). It was ET Electric's constant and printed
 * under every company's name; now it is doc_style.tagline, set in Document Studio, and every
 * letterhead reads it through companyFromOrg: the office pages from the whole row
 * (settings.doc_style), the public /i and /q doors from the projection's one doc_style key.
 * A company that set none prints no line at all.
 */
const TAG = "Quality Work Since 1998";
const fullRow = (docStyle: unknown) => ({ name: "Main Street Builders", settings: { doc_style: docStyle } }) as unknown as Organization;
const projection = (docStyle: unknown) => ({ name: "Main Street Builders", doc_style: docStyle }) as unknown as Organization;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("companyFromOrg reads the company's own tagline", () => {
  it("from the whole row (office pages, /print, emails)", () => {
    expect(companyFromOrg(fullRow({ tagline: TAG, density: "airy" })).tagline).toBe(TAG);
  });

  it("from the public projection's doc_style (/i and /q)", () => {
    expect(companyFromOrg(projection({ tagline: TAG })).tagline).toBe(TAG);
  });

  it("normalized: trimmed, at most 80 characters, and none when none was set", () => {
    expect(companyFromOrg(fullRow({ tagline: `  ${TAG}  ` })).tagline).toBe(TAG);
    expect(companyFromOrg(fullRow({ tagline: "y".repeat(120) })).tagline).toBe("y".repeat(80));
    expect(companyFromOrg(fullRow({ density: "airy" })).tagline).toBe("");
    expect(companyFromOrg(fullRow(undefined)).tagline).toBe("");
    expect(companyFromOrg(projection(null)).tagline).toBe("");
    expect(companyFromOrg(null).tagline).toBe("");
  });
});

describe("the letterhead prints the tagline only when the company set one", () => {
  const meta = { docType: "Invoice", number: "INV-001", rows: [] };
  const header = (tagline: string, template: string) =>
    renderToStaticMarkup(createElement(DocHeader, { co: companyFromOrg(fullRow({ tagline })), template, meta }));

  it("classic and modern print it under the name", () => {
    for (const template of ["classic", "modern"]) {
      const html = header(TAG, template);
      expect(text(html), template).toContain(`Main Street Builders ${TAG}`);
    }
  });

  it("no tagline, no line: nothing is drawn under the name", () => {
    // With no meta rows, the tagline's own line is the only text-xs line either header can draw.
    expect(header("", "classic")).not.toContain('class="text-xs text-slate-500"');
    expect(header("", "modern")).not.toContain('class="text-xs text-white/80"');
    expect(header(TAG, "classic")).toContain(`<div class="text-xs text-slate-500">${TAG}</div>`);
    expect(header(TAG, "modern")).toContain(`<div class="text-xs text-white/80">${TAG}</div>`);
  });

  it("the /q document carries it from the projection, as the customer sees it", () => {
    const co = companyFromOrg(projection({ tagline: TAG, density: "compact" }));
    const html = renderToStaticMarkup(
      createElement(QuoteDocument, {
        co,
        template: "classic",
        docLabel: "Estimate",
        number: "E-001",
        createdAt: "2026-08-29",
        customer: { name: "Sample Customer" },
        items: [],
        subtotal: 0,
        tax: 0,
        total: 0,
        docStyle: { tagline: TAG, density: "compact" },
      }),
    );
    expect(text(html)).toContain(`Main Street Builders ${TAG}`);
  });
});

describe("the document emails carry the same tagline", () => {
  const company = (tagline: string) => ({ name: "Main Street Builders", brand: "#0f766e", tagline });
  const invoice = (tagline: string) =>
    renderInvoiceNoticeEmail({ company: company(tagline), customerName: "Sam", number: "INV-001", balance: 10, invoiceLink: "https://example.com/i/x" });
  const quote = (tagline: string) =>
    renderQuoteNoticeEmail({ docType: "Estimate", company: company(tagline), customerName: "Sam", number: "E-001", total: 10, quoteLink: "https://example.com/q/x" });

  it("prints it when set, escaped, and nothing when blank", () => {
    expect(invoice(TAG)).toContain(TAG);
    expect(quote(TAG)).toContain(TAG);
    expect(quote("Fast & Fair")).toContain("Fast &amp; Fair");
    expect(invoice("")).not.toContain("text-transform:uppercase");
    expect(quote("")).not.toContain("text-transform:uppercase");
  });

  it("both senders hand the email the company's own tagline", () => {
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(src("src/lib/invoice-email.ts")).toMatch(/tagline: co\.tagline,/);
    expect(src("src/app/(app)/quotes/actions.ts")).toMatch(/tagline: companyFromOrg\(org as any\)\.tagline,/);
  });
});

describe("Document Studio has the one plain field, saved with the other knobs", () => {
  const studio = readFileSync(join(process.cwd(), "src/app/(app)/doc-studio/studio.tsx"), "utf8");

  it("Tagline Under Your Name writes doc_style.tagline through the studio's autosave", () => {
    expect(studio).toContain(">Tagline Under Your Name</Label>");
    expect(studio).toContain("maxLength={TAGLINE_MAX}");
    expect(studio).toContain("apply({ ...style, tagline: e.target.value })");
    // The one doc_style writer, whose failure is said in words (toast + "Not saved").
    expect(studio).toContain("updateOrgSettings({ doc_style: next as unknown as Record<string, unknown> })");
  });

  it("the page shows the tagline being typed, and a layout reset keeps it", () => {
    expect(studio).toContain("const coLive = { ...co, tagline: style.tagline };");
    expect(studio.match(/co=\{coLive\}/g)?.length).toBe(2);
    expect(studio).toContain("apply({ ...DEFAULT_DOC_STYLE, tagline: style.tagline })");
  });
});
