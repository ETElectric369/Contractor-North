import { describe, it, expect } from "vitest";
import { renderers, text } from "./editor-test-mocks";

/**
 * WHO, THEN WHERE (cn-v1158): the one estimate editor draws the Job Site line directly under the
 * customer card's own contents, on a SAVED estimate. The owner, 2026-11-10: "we need to have sites
 * available to pick from on the estimate sheet, it might already be in place just not visible".
 *
 * The editor is rendered here both ways, as its other suites render it (editor-test-mocks): with a
 * row (/quotes/[id]) and with none (/quotes/new). The line's own states are driven in
 * [id]/job-site-line.test.tsx; this file is only about where it stands and where it does not.
 * NOT BUILT, and pinned as not built: the new-estimate page before its first save has no row to
 * write a site onto, so it draws no line. Every name and street here is invented.
 */
const { EstimateEditor } = await import("./estimate-editor");
const { saved, unsaved } = renderers(EstimateEditor);

const customer = { id: "c1", name: "Sam Tillery", company_name: null, email: null, phone: "(530) 555-0100" };
const cust = { address: "12 Thistlewood Way", unit: null, city: "Testville", state: "CA", zip: "96161" };
const own = { address: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161" };
const site = (over: Record<string, unknown> = {}) => ({ records: { customer: cust }, job: null, otherJobs: [], otherJobsFailed: false, otherJobsFull: false, ...over });

describe("a saved estimate", () => {
  it("the Job Site line stands in the customer card, straight after who the estimate is for and before anything else", () => {
    const html = saved({ customer_id: "c1" }, [], { customer, site: site() });
    const t = text(html);
    const who = t.indexOf("Sam Tillery");
    const where = t.indexOf("Job Site");
    expect(who).toBeGreaterThan(-1);
    expect(where).toBeGreaterThan(who);
    expect(t.slice(where)).toMatch(/^Job Site 12 Thistlewood Way Testville, CA 96161 From the customer/);
    // Before the estimator and the lines: it is part of the card, not of the document below it.
    expect(where).toBeLessThan(t.indexOf("Draft with Estimator"));
    // Once, with its one door.
    expect(t.split("Job Site 12 Thistlewood Way").length - 1).toBe(1);
    expect(html.split("</svg> Change Job Site</button>").length - 1).toBe(1);
    // Same card: no card closes between the customer and the line.
    const card = html.slice(html.indexOf("Sam Tillery"), html.indexOf("Job Site"));
    expect(card).not.toContain("rounded-xl border border-slate-200 bg-white");
  });

  it("an estimate given its own site says it, with the unit", () => {
    const t = text(saved({ customer_id: "c1" }, [], { customer, site: site({ records: { quote: own, customer: cust } }) }));
    expect(t).toContain("Job Site 40 Snowbell Court Unit 14 Testville, CA 96161 Set on this estimate");
  });

  it("no address anywhere (the suites' default): the line says so instead of standing empty", () => {
    const t = text(saved());
    expect(t).toContain("Job Site No job site yet. This estimate prints without one.");
  });

  it("a locked estimate (always on a job) keeps the line and loses the door: the job owns its site", () => {
    const html = saved(
      { status: "accepted", job_id: "j1", customer_id: "c1" },
      [],
      { customer, lock: { reason: "A draw was already billed against it — revise it instead." }, site: site({ records: { job: own, customer: cust }, job: { id: "j1", job_number: "J-040", name: "40 Snowbell #14" } }) },
    );
    const t = text(html);
    expect(t).toContain("Job Site 40 Snowbell Court Unit 14 Testville, CA 96161 From the job");
    expect(html).not.toContain("Change Job Site</button>");
    expect(html).toContain('href="/jobs/j1"');
    expect(t).toContain("Open the Job");
  });
});

describe("an estimate nobody has saved", () => {
  it("/quotes/new draws no Job Site line: there is no row yet to hold a site (not built in this release)", () => {
    for (const html of [unsaved(), unsaved({ items: [{ description: "Snowbell trench", quantity: 1, unit: "ea", unit_price: 290 }] })]) {
      const t = text(html);
      expect(t).not.toContain("Job Site");
      expect(t).not.toContain("No job site yet");
      expect(html).not.toContain('id="js-address"');
    }
  });
});
