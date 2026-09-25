import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { shapePortalJob, type PortalJobRaw, type PublicInvoiceDoc } from "@/lib/portal/job-view-shape";
import { INV_078, LINES, PAYMENTS, STRETCHES } from "@/lib/portal/j011-fixture";
import { PortalJobPage } from "./portal-job-page";
import { fmtDay, fmtHours, fmtRange, fmtWeekday, portalJobStatus, seaGlassStyle, siteLine } from "./portal-format";

/**
 * The customer's job page as it renders, on J-011's real money rows (the fixture holds no name and
 * no address). The ledger's figures are tested in stretch-ledger.test; this pins that the PAGE
 * shows them, says a draft is not a bill, offers a pay door only for a sent bill, and never
 * prints a field the shape does not carry.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-24T23:00:00Z");

const DOC: PublicInvoiceDoc = {
  invoice: {
    invoice_number: "INV-078",
    status: "draft",
    created_at: "2026-09-24T07:46:35Z",
    due_date: null,
    billing_type: "tm",
    invoice_kind: "progress",
    subtotal: 8318.62,
    tax_rate: 0,
    tax: 0,
    total: 8318.62,
    amount_paid: 6760,
  },
  items: [{ description: "Labor - Erik", quantity: 50.5, unit: "hr", unit_price: 100, line_total: 5050 }],
  payments: [{ amount: 1850, paid_at: "2026-08-10T19:00:00Z", method: "cash" }],
  customer: { name: "A Customer" },
  site_candidates: [],
  org: { name: "ET Electric" },
};

function raw(over: Partial<PortalJobRaw> = {}): PortalJobRaw {
  return {
    scope: { org_id: ORG, job_id: JOB, customer_id: "33333333-3333-4333-8333-333333333333" },
    org: { name: "ET Electric", logo_url: null, phone: "(530) 555-0100", email: "office@example.com", license: "C-10", brand_color: null, glass_tint: "#006d8f", timezone: "America/Los_Angeles" },
    customer: { name: "A Customer", company_name: null },
    job: { id: JOB, name: "Remodel", job_number: "J-011", status: "in_progress", address: "1 Main St", unit: null, city: "Truckee", state: "CA", zip: "96161" },
    billing: { billing_type: "tm", quote_statuses: [], milestones: 0 },
    stretches: STRETCHES,
    invoices: [{ ...INV_078, invoice_kind: "progress", public_token: "a".repeat(32), doc: DOC }],
    lines: LINES,
    payments: PAYMENTS,
    picks: [
      {
        id: "p1",
        category: "Paint Color",
        brand: "Benjamin Moore",
        name: "Swiss Coffee",
        code: "OC-45",
        location: "Kitchen",
        note: "Eggshell on the walls",
        color_hex: "#F2EFE6",
        link_url: "https://example.com/oc-45",
        file_path: null,
        file_kind: null,
        updated_at: "2026-09-24T18:00:00Z",
        ...({ buy_price: 41.5, markup_pct: 25 } as object),
      },
    ],
    photos: [{ id: "ph1", file_path: `${ORG}/${JOB}/100-panel.jpg`, taken_at: "2026-09-19T00:30:00Z" }],
    ...over,
  };
}
const signed = new Map([[`${ORG}/${JOB}/100-panel.jpg`, "https://signed.example/panel?t=1"]]);
const render = (r: PortalJobRaw) =>
  renderToStaticMarkup(createElement(PortalJobPage, { view: shapePortalJob(r, { signed, unbilled: null, now: NOW }), homeHref: "/portal/x" }));
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the customer's job page, drawn from the allowlisted view", () => {
  const html = render(raw());
  const t = text(html);

  it("says a draft is a running total, not a bill, and offers no pay door for it", () => {
    expect(t).toContain("Running total, not a bill yet.");
    expect(html).not.toContain('href="/i/');
    expect(t).not.toMatch(/View And Pay/);
  });

  it("shows every stretch's balance after it, ending at the bill's balance to the cent", () => {
    for (const label of ["Rough-in Start", "Rough-in", "Trim", "Fixtures"]) expect(t).toContain(label);
    for (const fig of ["$2,259.12", "$409.12", "$4,144.52", "$503.64", "$1,795.39", "$1,439.03", "$119.59", "$1,558.62"]) {
      expect(t).toContain(fig);
    }
    expect(t).toContain("Jul 14 to Aug 10");
    // The Sep 18 5 PM Pacific shift is Sep 18, never UTC's Sep 19.
    expect(t).toContain("Fri, Sep 18");
    expect(t).toContain("Erik 1 hour");
  });

  it("stretches and days are real disclosure widgets, the last stretch open", () => {
    expect((html.match(/<details data-portal-stretch/g) ?? []).length).toBe(4);
    expect(html).toMatch(/<details data-portal-stretch[^>]*open=""[^>]*>(?:(?!<details data-portal-stretch).)*Fixtures/s);
  });

  it("carries the picks and the shared photo, never a price from the price book", () => {
    expect(t).toContain("Swiss Coffee");
    expect(html).toContain("https://signed.example/panel?t=1");
    expect(t).not.toContain("41.5");
    expect(html).not.toMatch(/buy_price|markup/);
  });

  it("prints the bill through the same document /i uses", () => {
    expect(t).toContain("INV-078");
    expect(t).toContain("Labor - Erik");
  });

  it("a sent bill with a balance keeps its /i pay door and no running-total banner", () => {
    const sent = render(raw({ invoices: [{ ...INV_078, status: "sent", sent_at: "2026-09-24T20:00:00Z", invoice_kind: "progress", public_token: "a".repeat(32), doc: DOC }] }));
    expect(sent).toContain(`href="/i/${"a".repeat(32)}"`);
    expect(text(sent)).toContain("View And Pay INV-078 ($1,558.62 due)");
    expect(text(sent)).not.toContain("Running total, not a bill yet.");
  });

  it("wears the org's own glass color", () => {
    expect(html).toContain("--glass-tint:0 109 143");
  });
});

describe("how the customer's pages say things", () => {
  it("never moves a day: the org's date prints as that date in any timezone", () => {
    expect(fmtDay("2026-09-18")).toBe("Sep 18");
    expect(fmtWeekday("2026-09-18", "2026")).toBe("Fri, Sep 18");
    expect(fmtDay("2025-12-31", "2026")).toBe("Dec 31, 2025");
    expect(fmtRange("2026-07-14", "2026-08-10")).toBe("Jul 14 to Aug 10");
    expect(fmtRange("2026-09-24", "2026-09-24")).toBe("Sep 24");
    expect(fmtDay("not a date")).toBe("");
  });

  it("hours and plain statuses", () => {
    expect(fmtHours(1)).toBe("1 hour");
    expect(fmtHours(3.5)).toBe("3.5 hours");
    expect(fmtHours(3.509)).toBe("3.51 hours");
    expect(portalJobStatus("in_progress")).toBe("In Progress");
    expect(portalJobStatus("complete")).toBe("Done");
    expect(portalJobStatus("something_else")).toBe("In Progress");
  });

  it("the skin's variables follow the app dock's rule, and a bad color falls back to teal", () => {
    expect(seaGlassStyle("#1b9488")).toMatchObject({ "--glass-tint": "27 148 136", "--glass-ink": "17 92 84" });
    expect(seaGlassStyle("url(x)")).toMatchObject({ "--glass-tint": "27 148 136" });
  });

  it("one address line", () => {
    expect(siteLine({ address: "1 Main St", unit: "Unit 2", city: "Truckee", state: "CA", zip: "96161" })).toBe("1 Main St Unit 2, Truckee, CA 96161");
    expect(siteLine({ address: null, unit: null, city: null, state: null, zip: null })).toBe("");
  });
});
