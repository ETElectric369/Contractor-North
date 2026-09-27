import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CALL BACK (the switch board, 0352). With Leads switched off a request still reaches Needs You as
 * "New Request From …", and the one thing to do about it is one tap: Call Back dials the number.
 * With Leads on the row is exactly the lead row it always was (no Call Back).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/action-items/dispatch", () => ({ dispatchAction: vi.fn() }));
vi.mock("@/components/supplier-paper-cards", () => ({ SupplierPaperCards: () => null, SUPPLIER_PAPERS_SCOPE: "my-day" }));
vi.mock("@/components/move-to-day", () => ({ MoveToDay: ({ children }: { children: unknown }) => children as never }));

import { ActionList } from "./action-list";
import { inquiryActionItem } from "@/lib/action-items/switches";
import { AFFORDANCES, KIND_STREAM, sortActionItems, type ActionItem } from "@/lib/action-items/types";

const row = { id: "i1", name: "Dana Reyes", status: "new", next_follow_up_at: null, phone: "(530) 555-0142" };
const render = (leadsOn: boolean) => {
  const item = { ...inquiryActionItem(row, "2026-09-26", leadsOn), stream: KIND_STREAM.inquiry };
  return renderToStaticMarkup(createElement(ActionList, { items: [item], todayStr: "2026-09-26", leadsOn }));
};

describe("ActionList — a request with Leads off", () => {
  it("Leads on: the lead row as before, no Call Back", () => {
    const html = render(true);
    expect(html).toContain("Dana Reyes");
    expect(html).not.toContain("Call Back");
    expect(html).not.toContain("tel:");
  });

  it("Leads off: 'New Request From Dana Reyes' with a 44px Call Back that dials her", () => {
    const html = render(false);
    expect(html).toContain("New Request From Dana Reyes");
    const a = html.match(/<a [^>]*href="tel:[^"]*"[^>]*>.*?<\/a>/)![0];
    expect(a).toContain('href="tel:(530) 555-0142"');
    expect(a).toContain("Call Back");
    expect(a).toMatch(/\bh-11\b/);
  });

  it("Leads off: its chip reads Request; Leads on: Lead, as always; and no section header either way", () => {
    const off = render(false).replace(/<[^>]+>/g, "\n");
    expect(off).toMatch(/\nRequest\n/);
    expect(off).not.toMatch(/\nLeads?\n/);
    expect(off).not.toMatch(/\nRequests\n/);
    const on = render(true).replace(/<[^>]+>/g, "\n");
    expect(on).toMatch(/\nLead\n/);
    expect(on).not.toMatch(/\nLeads\n/);
    expect(on).not.toMatch(/\nRequests?\n/);
  });

  it("the Request chip rides on the row itself (inquiryActionItem), so any list says it", () => {
    expect(inquiryActionItem(row, "2026-09-26", false).chip).toBe("Request");
    expect(inquiryActionItem(row, "2026-09-26", true).chip).toBeUndefined();
    // A row built without its chip still reads Request with Leads off (the list's fallback).
    const bare = { ...inquiryActionItem(row, "2026-09-26", true), stream: KIND_STREAM.inquiry };
    const html = renderToStaticMarkup(createElement(ActionList, { items: [bare], todayStr: "2026-09-26", leadsOn: false })).replace(/<[^>]+>/g, "\n");
    expect(html).toMatch(/\nRequest\n/);
  });
});

/**
 * ONE FLAT LIST OF PLAIN CHIPS (Wave 1, W1-15, NY-list). No Money / Leads / Today / Waiting headers;
 * each row's chip says the state it is in. The list draws rows in the SERVER's order (the build sorts
 * once: money, leads, today, other) and only sinks a row ticked done.
 */
describe("ActionList — one flat list, the server's order, plain chips", () => {
  const item = (o: Partial<ActionItem> & Pick<ActionItem, "id" | "kind">): ActionItem => ({
    stream: KIND_STREAM[o.kind],
    title: o.id,
    subtitle: null,
    who: null,
    when: null,
    urgency: 1,
    done: false,
    href: `/x/${o.id}`,
    affordances: ["open"],
    ...o,
  });
  const words = (items: ActionItem[]) =>
    renderToStaticMarkup(createElement(ActionList, { items, todayStr: "2026-09-26" }))
      .replace(/<[^>]+>/g, "\n")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  const built = sortActionItems(
    [
      item({ id: "row-other", kind: "contract_unsigned" }),
      item({ id: "row-today", kind: "job_to_schedule", urgency: 2 }),
      item({ id: "row-lead", kind: "inquiry" }),
      item({ id: "row-money", kind: "invoice_draft", urgency: 0 }),
    ],
    "2026-09-26",
  );

  it("draws no section headers", () => {
    const w = words(built);
    for (const header of ["Money", "Leads", "Today", "Waiting", "Requests"]) expect(w, header).not.toContain(header);
  });

  it("the rows run money, leads, today, other, in the order the server sent them", () => {
    const w = words(built);
    const at = (id: string) => w.indexOf(id);
    expect(at("row-money")).toBeGreaterThanOrEqual(0);
    expect(at("row-money")).toBeLessThan(at("row-lead"));
    expect(at("row-lead")).toBeLessThan(at("row-today"));
    expect(at("row-today")).toBeLessThan(at("row-other"));
    // Given another order, it keeps it: the list never re-sorts what the server sorted.
    const flipped = words([...built].reverse());
    expect(flipped.indexOf("row-other")).toBeLessThan(flipped.indexOf("row-money"));
  });

  it("each row's chip is the state it is in: the kind's words, or the row's own", () => {
    const w = words([
      item({ id: "a", kind: "invoice_overdue" }),
      item({ id: "b", kind: "quote_accepted" }),
      item({ id: "c", kind: "time_stray", chip: "Clock Left Running" }),
      item({ id: "d", kind: "time_stray", chip: "On No Job" }),
      item({ id: "e", kind: "visit_unbilled", chip: "Billed, Not Paid" }),
      item({ id: "f", kind: "stock_short" }),
    ]);
    for (const chip of ["Past Due", "Won", "Clock Left Running", "On No Job", "Billed, Not Paid", "To Settle"]) expect(w, chip).toContain(chip);
  });

  it("a row already done sinks below the rest, keeping their order", () => {
    const w = words([item({ id: "first", kind: "invoice_draft", done: true }), item({ id: "second", kind: "inquiry" }), item({ id: "third", kind: "job_to_schedule" })]);
    expect(w.indexOf("second")).toBeLessThan(w.indexOf("third"));
    expect(w.indexOf("third")).toBeLessThan(w.indexOf("first"));
  });
});

/**
 * HOURS ON NO JOB, BILLED BY HAND (0357, TTUSD on INV-055): the Needs You row of a closed shift on no
 * job carries Already Billed when an invoice with no job could hold it (query.ts, noJobStrayDoors).
 * The door is on the row itself, 44px and Title Case; a row without it (a running clock, or nothing
 * that could hold it) is the row it always was.
 */
describe("ActionList — a shift on no job", () => {
  const stray = (o: Partial<ActionItem> = {}): ActionItem => ({
    id: "stray-t6",
    kind: "time_stray",
    stream: KIND_STREAM.time_stray,
    title: "JP's Aug 6 entry has no job",
    subtitle: "Closed hours nobody can bill",
    who: "JP",
    when: "2026-08-06T15:00:00Z",
    urgency: 1,
    done: false,
    href: "/timecards",
    affordances: AFFORDANCES.time_stray,
    ...o,
  });
  const html = (item: ActionItem) => renderToStaticMarkup(createElement(ActionList, { items: [item], todayStr: "2026-09-26" }));

  it("Already Billed on the row, 44px, when an invoice with no job could hold it", () => {
    const h = html(stray({ noJobHours: { entryIds: ["t6"] } }));
    const tag = Array.from(h.matchAll(/<button[^>]*>Already Billed<\/button>/g))[0]?.[0];
    expect(tag).toBeTruthy();
    expect(tag).toMatch(/\bh-11\b/);
  });

  it("no door without it", () => {
    expect(html(stray())).not.toContain("Already Billed");
  });
});
