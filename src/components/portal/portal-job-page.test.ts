import { describe, it, expect, vi } from "vitest";
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
// The page refreshes itself through the App Router (PortalKeepFresh); a static render has none.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

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
  // INV-078's real lines, as invoice_document_projection hands them over (supplier rows included).
  items: LINES.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, line_total: l.line_total, import_source: l.import_source })),
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
    photos: [{ id: "ph1", file_path: `${ORG}/${JOB}/100-panel.jpg`, added_at: "2026-09-19T00:30:00Z" }],
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

  it("never names a supplier: not in the stretches, not in the bill", () => {
    for (const supplier of ["Consolidated", "Home Depot"]) expect(t).not.toContain(supplier);
    expect(t).toContain("Supplies & Tax");
  });

  it("the bill is closed until tapped, laid out for a phone, and says why its Balance differs", () => {
    expect(html).toMatch(/<details class="portal-glass group rounded-2xl">(?:(?!<\/details>).)*INV-078/s);
    expect(html).toContain('class="portal-bill ');
    expect(html).toContain('class="doc-lines ');
    expect(t).toContain("Balance counts down from the whole bill");
  });

  it("while a bill is a draft, the work outside the running total is 'not added yet', not a second 'not a bill yet'", () => {
    const view = shapePortalJob(raw(), {
      signed,
      unbilled: { hours: 4, laborByPerson: [{ name: "Erik", hours: 4, amount: 400 }], laborAmount: 400, materials: 0, returnsCredit: 0, total: 400 },
      now: NOW,
    });
    const u = text(renderToStaticMarkup(createElement(PortalJobPage, { view, homeHref: "/portal/x" })));
    expect(u).toContain("$400.00 of work not added to the running total yet");
    expect(u).toContain("Work Not Added Yet");
    expect(u).not.toContain("not on a bill yet");
    const sentView = shapePortalJob(raw({ invoices: [{ ...INV_078, status: "sent", sent_at: "2026-09-24T20:00:00Z", invoice_kind: "progress", public_token: "a".repeat(32), doc: DOC }] }), {
      signed,
      unbilled: view.unbilled,
      now: NOW,
    });
    const v2 = text(renderToStaticMarkup(createElement(PortalJobPage, { view: sentView, homeHref: "/portal/x" })));
    expect(v2).toContain("Work Not On A Bill Yet");
  });

  it("a photo's date is the day it was added, never claimed as the day it was taken", () => {
    expect(html).not.toMatch(/taken/i);
    expect(html).toContain("added Sep 18");
  });

  it("wears the org's own glass color", () => {
    expect(html).toContain("--glass-tint:0 109 143");
  });
});

describe("the plans and drawings section (0326)", () => {
  const files: Record<string, string> = {
    [`${ORG}/${JOB}/300-circuit.pdf`]: "https://signed.example/circuit?t=1",
    [`${ORG}/${JOB}/301-floor.jpg`]: "https://signed.example/floor?t=1",
    [`${ORG}/${JOB}/302-house.e57`]: "https://signed.example/scan?t=1",
  };
  const doc = (id: string, kind: string, path: string, over: Record<string, unknown> = {}) => ({
    id,
    kind,
    title: null as string | null,
    file_path: path,
    added_at: "2026-09-24T18:00:00Z",
    shown_at: "2026-09-24T18:05:00Z",
    is_update: false,
    ...over,
  });
  const r = raw({
    documents: [
      doc("d1", "circuit_map", `${ORG}/${JOB}/300-circuit.pdf`, { title: "Circuit Map", is_update: true }),
      doc("d2", "plan", `${ORG}/${JOB}/301-floor.jpg`, { title: "Main Floor Plan", added_at: "2026-08-03T18:00:00Z" }),
      doc("d3", "scan_3d", `${ORG}/${JOB}/302-house.e57`, { title: "House Scan" }),
    ],
  });
  const html = renderToStaticMarkup(
    createElement(PortalJobPage, { view: shapePortalJob(r, { signed: new Map([...signed, ...Object.entries(files)]), unbilled: null, now: NOW }), homeHref: "/portal/x" }),
  );
  const t = text(html);

  it("has its own section and chip, with each paper's title and date", () => {
    expect(html).toContain('id="plans"');
    expect(html).toContain('href="#plans"');
    expect(t).toContain("Plans And Drawings");
    expect(t).toContain("Main Floor Plan");
    expect(t).toContain("Main Floor Plan Added Aug 3");
    // The newer circuit map says it is an update, not a second map.
    expect(t).toContain("Circuit Map Updated Sep 24");
    // Each kind is its own heading.
    for (const h of ["Plan", "Circuit Map", "3D Scan"]) expect(html).toContain(`tracking-wide text-slate-600">${h}</h3>`);
  });

  it("a picture is drawn on the page, a PDF opens in the viewer or full size, a scan is a plain link", () => {
    expect(html).toContain('src="https://signed.example/floor?t=1"');
    expect(t).toContain("Open The Circuit Map");
    expect(html).toContain('href="https://signed.example/circuit?t=1"');
    expect(t).toContain("Open Full Size");
    expect(t).toContain("A 3D file.");
    expect(html).toContain('href="https://signed.example/scan?t=1"');
    expect(t).toContain("Open The File");
  });

  it("no section and no chip when nothing is shown", () => {
    const none = render(raw());
    expect(none).not.toContain('id="plans"');
    expect(text(none)).not.toContain("Plans And Drawings");
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
