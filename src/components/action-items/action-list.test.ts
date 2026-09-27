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
import { AFFORDANCES, KIND_STREAM, type ActionItem } from "@/lib/action-items/types";

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

  it("Leads off: its section reads Requests and its chip Request; Leads on: Leads and Lead, as always", () => {
    const off = render(false).replace(/<[^>]+>/g, "\n");
    expect(off).toMatch(/\nRequests\n/);
    expect(off).toMatch(/\nRequest\n/);
    expect(off).not.toMatch(/\nLeads?\n/);
    const on = render(true).replace(/<[^>]+>/g, "\n");
    expect(on).toMatch(/\nLeads\n/);
    expect(on).toMatch(/\nLead\n/);
    expect(on).not.toMatch(/\nRequests?\n/);
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
