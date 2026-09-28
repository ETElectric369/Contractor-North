import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CALL BACK (the switch board, 0352). With Leads switched off a request still reaches Needs You as
 * "New Request From …", and the one thing to do about it is one tap: Call Back dials the number.
 * With Leads on the row's button is Called (the number is behind its ⋯).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/action-items/dispatch", () => ({ dispatchAction: vi.fn() }));
vi.mock("@/components/supplier-paper-cards", () => ({ SupplierPaperCards: () => null, SUPPLIER_PAPERS_SCOPE: "my-day" }));
vi.mock("@/components/move-to-day", () => ({ MoveToDay: ({ children }: { children: unknown }) => children as never }));
vi.mock("@/components/send-sheet", () => ({ SendSheet: () => null }));

import { ActionList, ROW_BUTTON, keepInFlight, verbLanding } from "./action-list";
import { WaitingFold, waitingLine } from "./waiting-fold";
import { inquiryActionItem } from "@/lib/action-items/switches";
import { AFFORDANCES, KIND_STREAM, sortActionItems, waitingForViewer, waitingRow, type ActionItem, type WaitingItem } from "@/lib/action-items/types";
import { rollUpPiles } from "@/lib/action-items/piles";

const row = { id: "i1", name: "Dana Reyes", status: "new", next_follow_up_at: null, phone: "(530) 555-0142" };
const render = (leadsOn: boolean) => {
  const item = { ...inquiryActionItem(row, "2026-09-26", leadsOn), stream: KIND_STREAM.inquiry };
  return renderToStaticMarkup(createElement(ActionList, { items: [item], todayStr: "2026-09-26", leadsOn, isStaff: true }));
};

describe("ActionList — a request with Leads off", () => {
  it("Leads on: the lead row's button is Called; no Call Back, and the number waits behind ⋯", () => {
    const html = render(true);
    expect(html).toContain("Dana Reyes");
    expect(html).not.toContain("Call Back");
    expect(html).not.toContain("tel:");
    expect(html).toMatch(/<button[^>]*>Called<\/button>/);
    expect(html).toContain('aria-label="More For Dana Reyes"');
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
const words = (items: ActionItem[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ActionList, { items, todayStr: "2026-09-26", isStaff: true, ...extra }))
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

describe("ActionList — one flat list, the server's order, plain chips", () => {
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
      item({ id: "g", kind: "job_on_hold" }),
    ]);
    for (const chip of ["Past Due", "Won", "Clock Left Running", "On No Job", "Billed, Not Paid", "To Settle", "Reminder"]) expect(w, chip).toContain(chip);
  });

  it("a row already done sinks below the rest, keeping their order", () => {
    const w = words([item({ id: "first", kind: "invoice_draft", done: true }), item({ id: "second", kind: "inquiry" }), item({ id: "third", kind: "job_to_schedule" })]);
    expect(w.indexOf("second")).toBeLessThan(w.indexOf("third"));
    expect(w.indexOf("third")).toBeLessThan(w.indexOf("first"));
  });
});

describe("ActionList — one named button per row, and ⋯ (W1-13)", () => {
  it("each row says its verb; the icon strip, the 20px box and the chevron are gone", () => {
    const html = renderToStaticMarkup(
      createElement(ActionList, {
        items: [
          item({ id: "inv", kind: "invoice_overdue" }),
          item({ id: "stock", kind: "stock_short" }),
          item({ id: "rec", kind: "receipt_unbilled" }),
          item({ id: "job", kind: "job_to_schedule", affordances: AFFORDANCES.job_to_schedule }),
          item({ id: "hold", kind: "job_on_hold", affordances: AFFORDANCES.job_on_hold, holdReason: "Waiting on the permit" }),
        ],
        todayStr: "2026-09-26",
        isStaff: true,
      }),
    );
    for (const label of ["Get Paid", "Settle It", "Record It", "Pick A Day", "Snooze", "Take Off Hold"]) expect(html, label).toContain(`>${label}<`);
    for (const gone of ['title="Dismiss"', 'aria-label="Mark done"', 'title="Open"', 'title="Assign to someone"', 'title="Schedule / set a date"']) expect(html, gone).not.toContain(gone);
    expect(html).not.toMatch(/Dismiss|Delete/);
    // A job needing a day has ⋯ (Assign, Finish, Cancel); an overdue invoice has nothing behind one.
    expect(html).toContain('aria-label="More For job"');
    expect(html).not.toContain('aria-label="More For inv"');
  });

  it("every button is 44px: the row's (the Call Back pattern) and the ⋯; the row opens from one target the size of the row", () => {
    expect(ROW_BUTTON).toMatch(/\bh-11\b/);
    expect(ROW_BUTTON).toContain("-my-3");
    const html = renderToStaticMarkup(createElement(ActionList, { items: [item({ id: "inv", kind: "invoice_overdue" })], todayStr: "2026-09-26", isStaff: true }));
    const link = html.match(/<a [^>]*>Get Paid<\/a>/)![0];
    expect(link).toMatch(/\bh-11\b/);
    // The open target covers the whole row (never two 20px lines), under the words.
    expect(html).toMatch(/<button type="button" aria-label="Open inv" class="absolute inset-0 rounded-xl"><\/button>/);
    expect(html).toContain('class="pointer-events-none relative min-w-0 flex-1"');
    expect(html).toMatch(/class="pointer-events-auto ml-auto flex shrink-0 items-center gap-1"><a [^>]*>Get Paid<\/a>/);
  });

  it("a tech's visit has no button and no ⋯: it only opens", () => {
    const html = renderToStaticMarkup(
      createElement(ActionList, { items: [item({ id: "visit", kind: "appointment", affordances: ["open"] })], todayStr: "2026-09-26", isStaff: false }),
    );
    expect(html).not.toContain("Close Out");
    expect(html).not.toContain("More For");
  });

  it("the list never sorts, and the row table is the only place a row's doors come from", () => {
    const list = readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");
    expect(list).toContain("const doors = rowButtons(item, { leadsOn, isStaff: p.isStaff });");
    expect(list).not.toMatch(/CalendarPlus|Clock3|UserPlus|ChevronRight|Check\b/);
  });
});

describe("ActionList — piles (W1-14)", () => {
  const drafts = [1, 2, 3].map((i) =>
    item({ id: `qdraft-q${i}`, kind: "quote_draft", title: `Estimate E-0${i} started, never sent`, when: `2026-09-0${i}`, affordances: AFFORDANCES.quote_draft }),
  );
  const pile = (o: Parameters<typeof rollUpPiles>[1]["counts"] = {}) => rollUpPiles(drafts, { todayStr: "2026-09-26", isStaff: true, counts: o });

  it("the count, its verb, the first estimate in full, then a 44px See All that unfolds the rest", () => {
    const html = renderToStaticMarkup(createElement(ActionList, { items: pile(), todayStr: "2026-09-26", isStaff: true }));
    expect(html).toContain("Estimates Not Sent · 3");
    expect(html).toContain("Estimate E-01 started, never sent");
    // Folded: the other two wait behind See All.
    expect(html).not.toContain("Estimate E-02 started, never sent");
    const seeAll = html.match(/<button[^>]*aria-expanded="false"[^>]*>See All 3<\/button>/)![0];
    expect(seeAll).toMatch(/\bmin-h-11\b/);
    // Text to visual: one pip per estimate, amber past a week.
    expect(html.match(/data-pip="old"/g)).toHaveLength(3);
    // Its verb is its pile's.
    expect(html).toMatch(/<button[^>]*>Send It<\/button>/);
  });

  it("when not every one is here, See All opens the list page instead", () => {
    const html = renderToStaticMarkup(createElement(ActionList, { items: pile({ estimates_not_sent: { capped: true } }), todayStr: "2026-09-26", isStaff: true }));
    expect(html).toContain("Estimates Not Sent · 3+");
    expect(html).toMatch(/<a[^>]*href="\/quotes\?status=draft"[^>]*>See All On Estimates<\/a>/);
  });

  it("a capped Done, Not Billed pile has no page that lists its rows: See All unfolds every row read here, never a link to /billing", () => {
    const done = [1, 2, 3].map((i) => item({ id: `unbilled-a${i}`, kind: "visit_unbilled", title: `Service call ${i}`, when: `2026-09-0${i}`, affordances: AFFORDANCES.visit_unbilled }));
    const items = rollUpPiles(done, { todayStr: "2026-09-26", isStaff: true, counts: { done_not_billed: { capped: true } } });
    const html = renderToStaticMarkup(createElement(ActionList, { items, todayStr: "2026-09-26", isStaff: true }));
    expect(html).toContain("Done, Not Billed · 3+");
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>See All 3 Here<\/button>/);
    expect(html).not.toContain('href="/billing"');
    expect(html).not.toMatch(/See All On (Billing|Invoices)/);
  });

  it("the unfold and the fold are one client toggle (a second tap folds them)", () => {
    const list = readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");
    expect(list).toContain('{open ? "See Less" : `See All ${count}`}');
    expect(list).toContain("{open && rest.map((c) => <Row key={c.id} {...p} item={c} nested />)}");
    // Acting on a child drops it and counts down in place; a lone one left is a plain row.
    expect(list).toContain("const count = Math.max(0, item.pile.count - gone);");
    expect(list).toContain("if (kids.length === 1 && !item.pile.capped && count <= 1) return <Row key={kids[0].id} item={kids[0]} {...rowProps} />;");
  });
});

describe("ActionList — a verb's refusal is always said, and the server's list decides what shows", () => {
  const list = () => readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");

  it("a sheet's verb (⋯, Snooze, Still Waiting, Set Aside Until…, Assign, a confirm, Pick A Day) waits for the server: its row and sheet stay to say a refusal", () => {
    for (const verb of ["snooze", "dismiss", "schedule", "do"] as const) {
      expect(verbLanding({ kind: "invoice_draft" }, verb, { sheet: true }).optimistic, verb).toBe(false);
    }
    // Every sheet sends with sheet: true (DoorForm, the ⋯ run rows, MoveToDay).
    const src = list();
    expect(src).toContain("const r = await p.run(item, verb, payload, { child: p.nested, sheet: true });");
    expect(src).toContain("const r = await p.run(p.item, a.verb, undefined, { child: p.nested, sheet: true });");
    expect(src).toContain("p.run(item, a.verb, { date: d }, { child: p.nested, sheet: true })");
    // The ⋯ run rows say a refusal in the sheet instead of closing on nothing.
    expect(src).toContain('else setErr(r.error ?? "Couldn\'t do that.");');
    expect(src).not.toContain("else setAsking(null);");
  });

  it("a bare button's verb is optimistic, and its refusal is said on the list by run() itself", () => {
    expect(verbLanding({ kind: "job_to_schedule" }, "schedule")).toEqual({ hides: "remove", optimistic: true });
    expect(verbLanding({ kind: "inquiry" }, "do")).toEqual({ hides: "sink", optimistic: true });
    expect(verbLanding({ kind: "inquiry" }, "do", { child: true })).toEqual({ hides: "remove", optimistic: true });
    expect(list()).toContain("if (!opts?.sheet) setError(message);");
  });

  it("Assign never hides the job: crew puts nothing ahead of it, so it still needs a day (and the badge still counts it)", () => {
    expect(verbLanding({ kind: "job_to_schedule" }, "assign")).toEqual({ hides: "none", optimistic: false });
    expect(verbLanding({ kind: "job_to_schedule" }, "assign", { sheet: true, child: true }).hides).toBe("none");
  });

  it("a fresh list from the server shows every row it holds again, except a row whose verb is still on its way", () => {
    expect([...keepInFlight(new Set(["a", "b", "c"]), new Set(["b"]))]).toEqual(["b"]);
    expect(keepInFlight(new Set(["a"]), new Set()).size).toBe(0);
    const src = list();
    expect(src).toMatch(/if \(seenItems !== items\) \{\s*setSeenItems\(items\);\s*setRemovedIds\(\(s\) => keepInFlight\(s, inFlight\)\);\s*setDoneIds\(\(s\) => keepInFlight\(s, inFlight\)\);/);
  });
});

describe("the Waiting fold", () => {
  const w = (o: Partial<WaitingItem>): WaitingItem => ({ id: "w1", kind: "job_on_hold", title: "Rhodesia Panel · J-034", why: "Waiting on the permit", backOn: "2026-10-03", href: "/jobs/j34", ...o });

  it("drawn only when something waits; a grey count, never a badge; collapsed", () => {
    expect(renderToStaticMarkup(createElement(WaitingFold, { items: [] }))).toBe("");
    const html = renderToStaticMarkup(createElement(WaitingFold, { items: [w({}), w({ id: "w2" })] }));
    expect(html).toContain("Waiting");
    expect(html).toContain("(2)");
    expect(html).not.toContain("rounded-full");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<button[^>]*class="[^"]*min-h-11/);
    // Collapsed: the rows wait behind the toggle.
    expect(html).not.toContain("Waiting on the permit");
  });

  it("a job held until Oct 3 waits in the fold as 'Back Oct 3', never up top", () => {
    // query.ts: heldJobState(hold_until, today) === "later" → waitingRow(...), not a Now row.
    const held = waitingRow({ id: "onhold-j47", kind: "job_on_hold", title: "Kitchen Hood Outlet · J-047", why: "Waiting on the customer", backOn: "2026-10-03", href: "/jobs/j47" })!;
    expect(waitingLine(held)).toBe("Kitchen Hood Outlet · J-047 · Waiting on the customer · Back Oct 3");
    const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    expect(query).toMatch(/if \(withDay && state === "later"\) \{\s*const row = waitingRow\(\{ id: `onhold-\$\{j\.id\}`, kind: "job_on_hold"/);
  });

  it("each row says what, why and the day it comes back", () => {
    expect(waitingLine(w({}))).toBe("Rhodesia Panel · J-034 · Waiting on the permit · Back Oct 3");
    const fold = readFileSync(join(process.cwd(), "src/components/action-items/waiting-fold.tsx"), "utf8");
    expect(fold).toContain('className="flex min-h-11 items-center px-5 py-1.5');
  });

  it("every Waiting row has a day: a row with none is never folded", () => {
    expect(waitingRow({ id: "x", kind: "invoice_draft", title: "INV-078 · $400.00", why: "Set Aside", backOn: null, href: "/billing/x" })).toBeNull();
    expect(waitingRow({ id: "x", kind: "invoice_draft", title: "INV-078 · $400.00", why: "Set Aside", backOn: "Oct 3", href: "/billing/x" })).toBeNull();
    expect(waitingRow({ id: "x", kind: "invoice_draft", title: "INV-078 · $400.00", why: "", backOn: "2026-10-03", href: "/billing/x" })).toEqual({
      id: "x",
      kind: "invoice_draft",
      title: "INV-078 · $400.00",
      why: "Waiting",
      backOn: "2026-10-03",
      href: "/billing/x",
    });
  });

  it("a tech's waiting list holds no money kind and no $ in any title", () => {
    const rows = [
      w({ id: "a", kind: "invoice_draft", title: "INV-078 · $2,340.00" }),
      w({ id: "b", kind: "supplier_paper", title: "Metro 8802 · $59.17" }),
      w({ id: "c", kind: "job_on_hold" }),
      w({ id: "d", kind: "inquiry", title: "Lead with $ in it" }),
    ];
    const tech = waitingForViewer(rows, false);
    expect(tech.map((r) => r.id)).toEqual(["c"]);
    for (const r of tech) {
      expect(KIND_STREAM[r.kind]).not.toBe("money");
      expect(r.title).not.toContain("$");
    }
    expect(waitingForViewer(rows, true)).toHaveLength(4);
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
