import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/jobs/already-billed-actions", () => ({
  alreadyBilledSheet: vi.fn(async () => ({ ok: false, error: "not in a test" })),
  noJobHoursSheet: vi.fn(async () => ({ ok: false, error: "not in a test" })),
  markAlreadyBilled: vi.fn(),
  unmarkAlreadyBilled: vi.fn(),
}));
vi.mock("@/app/(app)/bills/receipt-for-billing-action", () => ({ receiptForBilling: vi.fn() }));
vi.mock("@/app/(app)/bills/receipt-billing-actions", () => ({
  putRestOnShelf: vi.fn(),
  setReceiptLineBillable: vi.fn(),
  setReceiptLineUsage: vi.fn(),
  takeRollOffShelf: vi.fn(),
}));

import { AlreadyBilledButton, AlreadyBilledSheet, NotBilledAfterAllButton, hoursWhat, type AlreadyBilledLoad } from "./already-billed-sheet";
import { NEEDS_UPDATE, type AbInvoice } from "@/lib/already-billed";
import type { AlreadyBilledSheetData } from "@/lib/already-billed-read";

/**
 * THE ALREADY BILLED SHEET, AS ERIK READS IT (0357). What these pin is the law, not the styling:
 * the question in his words beside what the cost was, only lines that can hold it, the button that
 * names the bill, Purple Sage's question only when it is likely, the hours ticked up to the day the
 * bill was written, a database without 0357 said plainly, and every clickable 44px and Title Case.
 */

const INV00023: AbInvoice = {
  id: "inv-23",
  invoice_number: "INV-00023",
  status: "paid",
  invoice_kind: "standard",
  job_id: "j-010",
  created_at: "2026-06-22T04:57:19.535Z",
  lines: [
    { id: "materials", description: "Materials", quantity: 1, unit: "ea", unit_price: 110, line_total: 110, import_source: null, import_key: null, edited: false, line_kind: null },
    { id: "brian", description: "Labor - Brian", quantity: 13, unit: "hr", unit_price: 95, line_total: 1235, import_source: null, import_key: null, edited: false, line_kind: null },
  ],
};

const data = (o: Partial<AlreadyBilledSheetData> = {}): AlreadyBilledSheetData => ({
  jobId: "j-010",
  jobNumber: "J-010",
  tz: "America/Los_Angeles",
  shopStock: true,
  target: { kind: "bill", ids: ["bill-ps"], words: "Consolidated Electrical Distributors 8802-1101475", cost: 186.93, date: "2026-06-16", negative: false, billHasLines: true, billId: "bill-ps" },
  invoices: [{ invoice: INV00023, preselect: "materials" }],
  drafts: [],
  entries: [],
  ...o,
});

const render = (load: AlreadyBilledLoad, extra: { lineId?: string | null; step?: "pick" | "ask" | "shelf"; checked?: string[] } = {}) =>
  renderToStaticMarkup(
    createElement(AlreadyBilledSheet, {
      jobId: "j-010",
      target: { kind: "bill", ids: ["bill-ps"], what: "8802-1101475" },
      onClose: () => {},
      initial: { load, ...extra },
    }),
  );
/** The sheet's own buttons (the shared Modal's header X is the Modal's, pinned with it). */
const buttons = (html: string) =>
  Array.from(html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g))
    .filter((m) => !/aria-label="Close"/.test(m[1]))
    .map((m) => ({ attrs: m[1], words: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** Title Case: every word that starts with a letter starts with a capital ("INV-00023", "h" and "$" aside). */
const titleCase = (s: string) => s.split(/\s+/).filter((w) => /^[a-z]/i.test(w) && w !== "h").every((w) => /^[A-Z]/.test(w));

describe("the sheet, Purple Sage", () => {
  it("asks which line, beside what the bill cost, and names the bill on its button", () => {
    const html = render({ state: "ok", data: data() }, { lineId: "materials" });
    const t = text(html);
    expect(t).toContain("This bill: $186.93 at cost");
    expect(t).toContain("Which line already charged for this?");
    expect(t).toContain("INV-00023 · Materials · $110.00");
    expect(t).toContain("Nothing on INV-00023 changes");
    const b = buttons(html);
    expect(b.map((x) => x.words)).toEqual(expect.arrayContaining(["Cancel", "Mark Billed On INV-00023"]));
    for (const x of b) {
      expect(x.attrs, x.words).toMatch(/\bh-11\b|\bmin-h-11\b/);
      expect(titleCase(x.words), x.words).toBe(true);
    }
    // Each line to pick is a 44px row.
    expect(Array.from(html.matchAll(/<label class="([^"]*)"/g)).every((m) => /\bmin-h-11\b/.test(m[1]))).toBe(true);
  });

  it("with no line picked, Mark is there but can't be pressed", () => {
    const html = render({ state: "ok", data: data() }, { lineId: null });
    const mark = buttons(html).find((x) => x.words === "Mark Billed On The Bill")!;
    expect(mark.attrs).toMatch(/disabled/);
  });

  it("asks Did J-010 Use All Of It? before it marks, with a way to the shelf and a way back", () => {
    const html = render({ state: "ok", data: data() }, { lineId: "materials", step: "ask" });
    expect(text(html)).toContain("Did J-010 Use All Of It?");
    const b = buttons(html).map((x) => x.words);
    expect(b).toEqual(expect.arrayContaining(["Yes, All Of It", "No, Some Went On The Shelf", "Back"]));
    for (const x of buttons(html)) expect(titleCase(x.words), x.words).toBe(true);
  });

  it("says the drafts it can't use, and why, and says when no sent bill has a line that could", () => {
    const html = render({ state: "ok", data: data({ invoices: [], drafts: ["INV-081 is still a draft: Add To INV-081 puts it there."] }) });
    const t = text(html);
    expect(t).toContain("No bill that went out on J-010 has a line that could have charged for this.");
    expect(t).toContain("INV-081 is still a draft: Add To INV-081 puts it there.");
  });

  it("a return says what came back, not a cost", () => {
    const html = render({ state: "ok", data: data({ target: { ...data().target, negative: true, cost: -40 } }) });
    expect(text(html)).toContain("This return: $40.00 back from the supplier");
  });

  it("a return with no line to hold it says which line could, not one that can't", () => {
    const t = text(render({ state: "ok", data: data({ invoices: [], target: { ...data().target, negative: true, cost: -40 } }) }));
    expect(t).toContain("Only a line typed by hand that takes money off can hold a return.");
    expect(t).not.toContain("or one you changed");
  });
});

describe("the sheet, hours", () => {
  const entries = [
    { id: "b1", person: "p-brian", name: "Brian Taylor", clockIn: "2026-06-16T15:00:00Z", hours: 8 },
    { id: "b2", person: "p-brian", name: "Brian Taylor", clockIn: "2026-06-17T15:00:00Z", hours: 4.5 },
    { id: "b3", person: "p-brian", name: "Brian Taylor", clockIn: "2026-07-01T15:00:00Z", hours: 8 },
  ];
  const hoursData = () =>
    data({
      target: { kind: "time", ids: ["b1", "b2", "b3"], words: "", cost: null, date: null, negative: false, billHasLines: false, billId: null },
      invoices: [{ invoice: INV00023, preselect: null }],
      entries,
    });

  it("lists the open shifts, 44px each, and compares the line's hours with the ticked ones", () => {
    const html = render({ state: "ok", data: hoursData() }, { lineId: "brian", checked: ["b1", "b2"] });
    const t = text(html);
    expect(t).toContain("Not billed yet: 20.5 h");
    expect(t).toContain("Which hours did it charge for?");
    expect(t).toContain("Line: 13 h · Checked: 12.5 h");
    expect(t).toContain("up to the day INV-00023 was written (Jun 21), not the day it was sent");
    expect(Array.from(html.matchAll(/<input type="checkbox"[^>]*>/g))).toHaveLength(3);
  });

  it("a line that already holds most of its hours says so, and ticks only what it has room for", () => {
    const bumped = { ...INV00023, lines: [{ ...INV00023.lines[1], heldHours: 8 }] };
    const html = render({ state: "ok", data: { ...hoursData(), invoices: [{ invoice: bumped, preselect: "brian" }] } }, { lineId: "brian", checked: ["b2"] });
    const t = text(html);
    expect(t).toContain("Line: 13 h · Already Holds: 8 h · Checked: 4.5 h");
    expect(t).toContain("and only as many as fit beside the 8 h the line already holds.");
  });

  it("names whose time it is in the sentence", () => {
    expect(hoursWhat(entries, ["b1", "b2"])).toBe("12.5 h of Brian Taylor's time");
  });

  it("a line that names one person lists only that person's shifts, says why, and never counts a tick on anyone else's (0361)", () => {
    const withErik = [...entries, { id: "e1", person: "p-erik", name: "Erik Taylor", clockIn: "2026-06-18T15:00:00Z", hours: 6 }];
    const judged = { ...INV00023, lines: [{ ...INV00023.lines[1], person: "p-brian", personName: "Brian Taylor" }] };
    const html = render(
      { state: "ok", data: { ...hoursData(), entries: withErik, invoices: [{ invoice: judged, preselect: "brian" }] } },
      { lineId: "brian", checked: ["b1", "e1"] },
    );
    const t = text(html);
    expect(Array.from(html.matchAll(/<input type="checkbox"[^>]*>/g))).toHaveLength(3);
    expect(t).not.toContain("Erik Taylor");
    expect(t).toContain(`"Labor - Brian" names Brian Taylor, so only Brian Taylor's hours are listed here.`);
    // Erik's tick is not on the list, so it is not counted (and never sent).
    expect(t).toContain("Line: 13 h · Checked: 8 h");
    // A crew line lists everyone's.
    const crew = { ...INV00023, lines: [{ ...INV00023.lines[1], description: "Labor - hourly with 2 guys", person: null, personName: null }] };
    const all = render({ state: "ok", data: { ...hoursData(), entries: withErik, invoices: [{ invoice: crew, preselect: "brian" }] } }, { lineId: "brian" });
    expect(Array.from(all.matchAll(/<input type="checkbox"[^>]*>/g))).toHaveLength(4);
    expect(text(all)).not.toContain("are listed here");
  });

  it("a line whose person has no open shifts says so, instead of listing someone else's", () => {
    const erikOnly = [{ id: "e1", person: "p-erik", name: "Erik Taylor", clockIn: "2026-06-18T15:00:00Z", hours: 6 }];
    const judged = { ...INV00023, lines: [{ ...INV00023.lines[1], person: "p-brian", personName: "Brian Taylor" }] };
    const html = render({ state: "ok", data: { ...hoursData(), entries: erikOnly, invoices: [{ invoice: judged, preselect: "brian" }] } }, { lineId: "brian" });
    expect(Array.from(html.matchAll(/<input type="checkbox"[^>]*>/g))).toHaveLength(0);
    expect(text(html)).toContain("None of Brian Taylor's hours on J-010 are open to mark.");
  });
});

describe("a database without 0357", () => {
  it("says it needs an update, with no Try Again that could only fail", () => {
    const html = render({ state: "error", error: NEEDS_UPDATE, needsUpdate: true });
    expect(text(html)).toContain("Already Billed needs an update to the app's database before it works.");
    expect(buttons(html).map((x) => x.words)).not.toContain("Try Again");
  });

  it("a lost read offers Try Again", () => {
    const html = render({ state: "error", error: "Couldn't read this job's bills just now." });
    expect(buttons(html).map((x) => x.words)).toContain("Try Again");
  });
});

describe("the doors", () => {
  it("Already Billed and Not Billed After All are 44px and Title Case", () => {
    const html = renderToStaticMarkup(
      createElement("div", null, [
        createElement(AlreadyBilledButton, { key: "a", jobId: "j", target: { kind: "bill", ids: ["b"], what: "OSH" } }),
        createElement(AlreadyBilledButton, { key: "h", jobId: "j", target: { kind: "time", ids: [], what: "Those hours" }, label: "Already Billed: The Hours" }),
        createElement(NotBilledAfterAllButton, { key: "n", jobId: "j", lineId: "l", ids: ["b"], what: "OSH" }),
      ]),
    );
    const b = buttons(html);
    expect(b.map((x) => x.words)).toEqual(["Already Billed", "Already Billed: The Hours", "Not Billed After All"]);
    for (const x of b) {
      expect(x.attrs).toMatch(/\bh-11\b/);
      expect(titleCase(x.words)).toBe(true);
    }
  });
});

/**
 * HOURS ON NO JOB (TTUSD on INV-055, Ben Ebenezer on INV-058): the same sheet, opened with no job.
 * It offers the lines of invoices with no job, lists the shifts nobody put on a job, and ticks only
 * the one the door was pressed on (the line names no one the app could match).
 */
describe("the sheet, hours on no job", () => {
  const INV055: AbInvoice = {
    id: "inv-55",
    invoice_number: "INV-055",
    status: "paid",
    invoice_kind: "standard",
    job_id: null,
    created_at: "2026-08-08T18:00:00Z",
    lines: [{ id: "jp", description: "Labor - JP Prince", quantity: 23, unit: "hr", unit_price: 95, line_total: 2185, import_source: null, import_key: null, edited: false, line_kind: null }],
  };
  const entries = [
    { id: "t6", person: "p-jp", name: "JP Prince", clockIn: "2026-08-06T15:00:00Z", hours: 11.5 },
    { id: "t7", person: "p-jp", name: "JP Prince", clockIn: "2026-08-07T15:00:00Z", hours: 11.5 },
    { id: "t8", person: "p-brian", name: "Brian Taylor", clockIn: "2026-08-11T15:00:00Z", hours: 6 },
  ];
  const noJob = (o: Partial<AlreadyBilledSheetData> = {}) =>
    data({
      jobId: "",
      jobNumber: "No Job",
      target: { kind: "time", ids: ["t6", "t7", "t8"], words: "", cost: null, date: "2026-08-06T15:00:00Z", negative: false, billHasLines: false, billId: null },
      invoices: [{ invoice: INV055, preselect: "jp" }],
      entries,
      noJob: true,
      preticked: ["t6"],
      ...o,
    });
  const renderNoJob = (load: AlreadyBilledLoad, extra: { lineId?: string | null; checked?: string[] } = {}) =>
    renderToStaticMarkup(
      createElement(AlreadyBilledSheet, { jobId: null, target: { kind: "time", ids: ["t6"], what: "Those hours" }, onClose: () => {}, initial: { load, ...extra } }),
    );

  it("offers INV-055's labor line, lists the hours on no job, ticks the one pressed, and names the bill on its button", () => {
    const html = renderNoJob({ state: "ok", data: noJob() }, { lineId: "jp", checked: ["t6"] });
    const t = text(html);
    expect(t).toContain("On no job and not billed: 29 h");
    expect(t).toContain("INV-055 · Labor - JP Prince · $2,185.00");
    expect(t).toContain("Which hours did it charge for?");
    expect(t).toContain("Line: 23 h · Checked: 11.5 h");
    expect(t).toContain("Ticked to start: the shift you pressed Already Billed on. Tick any others this line charged for.");
    expect(Array.from(html.matchAll(/<input type="checkbox"[^>]*>/g))).toHaveLength(3);
    expect(Array.from(html.matchAll(/<input type="checkbox"[^>]*checked=""[^>]*>/g))).toHaveLength(1);
    const b = buttons(html);
    expect(b.map((x) => x.words)).toEqual(expect.arrayContaining(["Cancel", "Mark Billed On INV-055"]));
    for (const x of b) {
      expect(x.attrs, x.words).toMatch(/\bh-11\b|\bmin-h-11\b/);
      expect(titleCase(x.words), x.words).toBe(true);
    }
  });

  it("with no invoice with no job that could hold them, it says which line could (no job name in the sentence)", () => {
    const t = text(renderNoJob({ state: "ok", data: noJob({ invoices: [] }) }));
    expect(t).toContain("No invoice with no job that went out has a line that could have charged for these hours.");
    expect(t).not.toContain("on No Job");
  });

  it("a line that names JP lists only JP's hours: Brian's shift, pressed on, is neither listed nor ticked (0361)", () => {
    const judged = { ...INV055, lines: [{ ...INV055.lines[0], person: "p-jp", personName: "JP Prince" }] };
    const html = renderNoJob({ state: "ok", data: noJob({ invoices: [{ invoice: judged, preselect: "jp" }], preticked: ["t8"] }) }, { lineId: "jp", checked: ["t8"] });
    const t = text(html);
    expect(Array.from(html.matchAll(/<input type="checkbox"[^>]*>/g))).toHaveLength(2);
    expect(Array.from(html.matchAll(/<input type="checkbox"[^>]*checked=""[^>]*>/g))).toHaveLength(0);
    expect(t).not.toContain("Brian Taylor");
    expect(t).toContain("Nothing is ticked to start. Tick the hours this line charged for.");
    expect(t).toContain("Line: 23 h · Checked: 0 h");
    // Nothing ticked that is listed: Mark can't be pressed.
    const mark = buttons(html).find((b) => b.words === "Mark Billed On INV-055");
    expect(mark?.attrs).toMatch(/disabled/);
  });

  it("a shift the door named that isn't open any more is said above the list", () => {
    const t = text(renderNoJob({ state: "ok", data: noJob({ preticked: [], note: "That shift isn't open to mark any more: an invoice already holds it, or it is on a job now. Reload the page." }) }, { lineId: "jp" }));
    expect(t).toContain("That shift isn't open to mark any more");
    expect(t).toContain("Nothing is ticked to start. Tick the hours this line charged for.");
  });

  it("the door with no job is the same 44px Already Billed", () => {
    const html = renderToStaticMarkup(createElement(AlreadyBilledButton, { jobId: null, target: { kind: "time", ids: ["t6"], what: "Those hours" } }));
    const b = buttons(html);
    expect(b.map((x) => x.words)).toEqual(["Already Billed"]);
    expect(b[0].attrs).toMatch(/\bh-11\b/);
  });
});
