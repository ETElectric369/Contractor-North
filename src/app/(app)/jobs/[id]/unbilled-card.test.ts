import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE RUNNING TOTAL LEADS WITH ONE NUMBER (Erik, 2026-09-26: "the only thing i was looking for was
 * the amount open"). The card says "Open: $X", and $X is exactly what its button bills: on a T&M job
 * billed with draws the button is Create Progress Payment (the draw door, net of the deposit), on an
 * open draft it is Add to INV-0xx, on a plain T&M job Create Invoice. A tech sees hours, never money.
 */

vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("../actions", () => ({ createInvoiceForJob: vi.fn() }));
vi.mock("../../billing/actions", () => ({ createProgressReportInvoice: vi.fn() }));

import { UnbilledCard, type UnbilledView } from "./unbilled-card";

const WORK = {
  kind: "staff" as const,
  hours: 26,
  laborAmount: 3055,
  laborByPerson: [
    { name: "Erik Taylor", hours: 13, amount: 1950 },
    { name: "Brian", hours: 13, amount: 1105 },
  ],
  billsAmount: 114.32,
  excluded: 0,
  billsCount: 2,
  markupPct: 25,
  billsBilled: 142.9,
  returnsAmount: 0,
  returnsCount: 0,
  returnsCredit: 0,
  stockCount: 0,
  stockAmount: 0,
  stockBilled: 0,
  stockShorts: 0,
  stockShortsWords: null,
  total: 3197.9,
  lastInvoiceNumber: "INV-00028",
  lastInvoiceAt: "2026-07-01T00:00:00Z",
  lastInvoiceStatus: "paid",
} as unknown as UnbilledView;

const card = (props: Partial<Parameters<typeof UnbilledCard>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(UnbilledCard, { jobId: "j-002", customerId: "c-tess", view: WORK, viewerIsStaff: true, openDraft: null, ...props }),
  );

describe("UnbilledCard - Open: $X and the door that bills it", () => {
  it("Tess J-002 with new hours: Open is the figure, the door is Create Progress Payment", () => {
    const html = card({ drawBilled: true });
    expect(html).toContain("Open: $3,197.90");
    expect(html).toContain("Create Progress Payment for $3,197.90");
    expect(html).not.toContain("Create Invoice for");
  });

  it("a deposit not yet taken off a bill: Open is the net, and the note says why", () => {
    const html = card({ drawBilled: true, lumpToNet: 1000 });
    expect(html).toContain("Open: $2,197.90");
    expect(html).toContain("Create Progress Payment for $2,197.90");
    expect(html).toContain("less the $1,000.00 deposit not yet taken off a bill");
  });

  it("an open draft: Add to it, with the same figure", () => {
    const html = card({ drawBilled: true, openDraft: { id: "inv-078", number: "INV-078", refreshable: true } });
    expect(html).toContain("Open: $3,197.90");
    expect(html).toContain("Add to INV-078 ($3,197.90)");
  });

  it("a plain T&M job keeps Create Invoice", () => {
    expect(card()).toContain("Create Invoice for $3,197.90");
  });

  it("everything billed: Open: $0.00 and no button", () => {
    const html = card({
      drawBilled: true,
      view: { ...WORK, hours: 0, laborAmount: 0, laborByPerson: [], billsCount: 0, billsAmount: 0, billsBilled: 0, total: 0 } as UnbilledView,
    });
    expect(html).toContain("Open: $0.00");
    expect(html).not.toContain("<button");
  });

  it("a tech sees his hours, never the money", () => {
    const html = card({ viewerIsStaff: false, view: { kind: "tech", hours: 13, lastInvoiceNumber: "INV-00028", lastInvoiceAt: null } });
    expect(html).not.toContain("$");
    expect(html).not.toContain("Open:");
    expect(html).not.toContain("<details");
  });

  it("a tech with no new time is sent to the job's one clock at the top (W1-20)", () => {
    const html = card({ viewerIsStaff: false, view: { kind: "tech", hours: 0, lastInvoiceNumber: null, lastInvoiceAt: null } });
    expect(html).toContain("No new time yet. Tap Clock In at the top of this job.");
    expect(html).not.toContain("Time tab");
  });

  it("on the clock here (first shift, nothing closed yet), he is never told to tap a Clock In the dock isn't showing", () => {
    const html = card({ viewerIsStaff: false, view: { kind: "tech", hours: 0, lastInvoiceNumber: null, lastInvoiceAt: null, onClockHere: true } });
    expect(html).toContain("On the clock here now. Your time shows once you clock out.");
    expect(html).not.toContain("Clock In");
  });

  it("on the clock on another job, or on a punch with no job, he is sent to the Switch the dock is showing", () => {
    const view = { kind: "tech" as const, hours: 0, lastInvoiceNumber: null, lastInvoiceAt: null };
    const other = card({ viewerIsStaff: false, view: { ...view, onClockElsewhere: "another_job" } });
    expect(other).toContain("You&#x27;re on the clock on another job. Tap Switch at the top to move your time here.");
    expect(other).not.toContain("Clock In");
    const noJob = card({ viewerIsStaff: false, view: { ...view, onClockElsewhere: "no_job" } });
    expect(noJob).toContain("You&#x27;re on the clock, but not on a job. Tap Switch at the top to move your time here.");
    expect(noJob).not.toContain("Clock In");
    // True in code: the dock's button reads Switch whenever his open entry is not on this job.
    const button = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-time-button.tsx"), "utf8");
    expect(button).toContain('openEntry.job_id === jobId ? "here" : "switch"');
    expect(button).toMatch(/Switch<span/);
  });

  it("the page tells the card when his open shift is on this job (source)", () => {
    const s = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(s).toContain("onClockHere: !!openEntryRow && String((openEntryRow as { job_id?: string | null }).job_id ?? \"\") === String(j.id),");
    expect(s).toMatch(/onClockElsewhere: !openEntryRow \|\| [^\n]+\n\s+\? null\n\s+: \(openEntryRow as \{ job_id\?: string \| null \}\)\.job_id \? "another_job" : "no_job",/);
  });
});

describe("UnbilledCard - one figure, the reasoning in a Why? fold (W1-19)", () => {
  const foldOf = (html: string) => html.slice(html.indexOf("<details"), html.indexOf("</details>") + "</details>".length);

  it("the Labor / Bills rows sit in the fold directly under the figure, the button beside it", () => {
    const html = card();
    expect(html).toContain("<details");
    expect(html.indexOf("Open: $3,197.90")).toBeLessThan(html.indexOf("<details"));
    const fold = foldOf(html);
    expect(fold).toContain(">Why?<");
    expect(fold).toContain("Labor");
    expect(fold).toContain("Erik Taylor 13h");
    expect(fold).toContain("+ 25% = $142.90");
    // The one door is outside the fold.
    expect(fold).not.toContain("<button");
    expect(html).toContain("Create Invoice for $3,197.90");
  });

  it("the sentences that change what the button does stay outside the fold", () => {
    const shorts = "2 pieces were taken past what stock holds; they wait for a roll.";
    const html = card({
      drawBilled: true,
      lumpToNet: 1000,
      view: { ...WORK, stockShortsWords: shorts } as UnbilledView,
    });
    const fold = foldOf(html);
    expect(html).toContain(shorts);
    expect(fold).not.toContain(shorts);
    // The deposit note is said beside the figure, not folded.
    expect(html).toContain("less the $1,000.00 deposit not yet taken off a bill");
    expect(fold).not.toContain("deposit not yet taken off a bill");
  });

  it("nothing new: the sentence, no fold", () => {
    const html = card({
      view: { ...WORK, hours: 0, laborAmount: 0, laborByPerson: [], billsCount: 0, billsAmount: 0, billsBilled: 0, total: 0 } as UnbilledView,
    });
    expect(html).toContain("Nothing new since INV-00028");
    expect(html).not.toContain("<details");
  });
});
