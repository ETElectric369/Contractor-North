import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CALL BACK (the switch board, 0352). With Leads switched off a request still reaches Needs You as
 * "New Request from …", and the one thing to do about it is one tap: Call Back dials the number.
 * With Leads on the row's button is Called (the number is behind its ⋯).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/action-items/dispatch", () => ({ dispatchAction: vi.fn() }));
vi.mock("@/components/supplier-paper-cards", () => ({ SupplierPaperCards: () => null, SUPPLIER_PAPERS_SCOPE: "my-day" }));
vi.mock("@/components/move-to-day", () => ({ MoveToDay: ({ children }: { children: unknown }) => children as never }));
vi.mock("@/components/send-sheet", () => ({ SendSheet: () => null }));

import { ActionList, ROW_BUTTON, keepInFlight, prettyWhen, verbLanding } from "./action-list";
import { WaitingFold, waitingLine } from "./waiting-fold";
import { inquiryActionItem } from "@/lib/action-items/switches";
import { AFFORDANCES, KIND_GROUP, WHEN_IS_A_DEADLINE, waitingForViewer, waitingRow, type ActionItem, type WaitingItem } from "@/lib/action-items/types";
import { rollUpPiles } from "@/lib/action-items/piles";
import { GROUP_ORDER } from "@/lib/action-items/needs-you-rule";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import { LangProvider } from "@/components/lang-provider";

/** The catalog's English, so a pin reads the words the box reads (lib/words/needs-you). */
const t = translator("en");
const say = (key: string, vars: Record<string, string | number>) => fillSlots(t(key), vars);
/** No chip is drawn any more: the Badge's own markup. */
const BADGE = "inline-flex items-center rounded-full px-2.5 py-0.5";

const row = { id: "i1", name: "Dana Reyes", status: "new", next_follow_up_at: null, phone: "(530) 555-0142" };
const render = (leadsOn: boolean) => {
  const item = { ...inquiryActionItem(row, "2026-09-26", leadsOn), group: KIND_GROUP.inquiry };
  return renderToStaticMarkup(createElement(ActionList, { items: [item], todayStr: "2026-09-26", leadsOn, isStaff: true }));
};

describe("ActionList — a request with Leads off", () => {
  it("Leads on: the lead row's button is Called; no Call Back, and the number waits behind ⋯", () => {
    const html = render(true);
    expect(html).toContain("Dana Reyes");
    expect(html).not.toContain("Call Back");
    expect(html).not.toContain("tel:");
    expect(html).toMatch(/<button[^>]*>Called<\/button>/);
    expect(html).toContain('aria-label="More for Dana Reyes"');
  });

  it("Leads off: her row with a 44px Call Back that dials her", () => {
    const html = render(false);
    expect(html).toContain("Dana Reyes");
    const a = html.match(/<a [^>]*href="tel:[^"]*"[^>]*>.*?<\/a>/)![0];
    expect(a).toContain('href="tel:(530) 555-0142"');
    expect(a).toContain("Call Back");
    expect(a).toMatch(/\bh-11\b/);
  });

  it("no chip is drawn (cn-v1161): neither Request nor Lead stands as a word of its own, and no section header either way", () => {
    for (const leadsOn of [false, true]) {
      const html = render(leadsOn);
      expect(html).not.toContain(BADGE);
      const lines = html.replace(/<[^>]+>/g, "\n");
      expect(lines).not.toMatch(/\nRequests?\n/);
      expect(lines).not.toMatch(/\nLeads?\n/);
    }
  });

  it("the Request chip still rides on the row itself (inquiryActionItem): a state key the buttons read, never drawn", () => {
    expect(inquiryActionItem(row, "2026-09-26", false).chip).toBe("Request");
    expect(inquiryActionItem(row, "2026-09-26", true).chip).toBeUndefined();
  });
});

/**
 * ONE FLAT LIST OF PLAIN CHIPS (Wave 1, W1-15, NY-list). No Money / Leads / Today / Waiting headers;
 * each row's chip says the state it is in. The list draws rows in the SERVER's order (the build sorts
 * once: NOW, then the tiles in order) and only sinks a row ticked done.
 */
const item = (o: Partial<ActionItem> & Pick<ActionItem, "id" | "kind">): ActionItem => ({
  group: KIND_GROUP[o.kind],
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
/** One render per tile, each with that tile open: every row the board can show, once. */
const everyTile = (items: ActionItem[], extra: Record<string, unknown> = {}) =>
  GROUP_ORDER.map((g) => renderToStaticMarkup(createElement(ActionList, { items, todayStr: "2026-09-26", isStaff: true, defaultOpen: g, ...extra }))).join("\n");

describe("ActionList — the board: Act Today, four tiles, the open tile's rows, in the server's order", () => {
  // As the build stamps them (query.ts): a NOW row, three Sales rows, one Operations row.
  const given = [
    item({ id: "row-now", kind: "quote_accepted", level: "now" }),
    item({ id: "row-other", kind: "contract_unsigned" }),
    item({ id: "row-lead", kind: "inquiry", level: "soon" }),
    item({ id: "row-draft", kind: "quote_draft" }),
    item({ id: "row-today", kind: "job_to_schedule" }),
  ];

  it("draws the four tile names in order and no section headers (no Money, Leads, Today)", () => {
    const w = words(given);
    const names = ["ny_btn_tileGetPaid", "ny_btn_tileSales", "ny_btn_tileOperations", "ny_btn_tileBookkeeping"].map(t);
    for (const n of names) expect(w, n).toContain(n);
    for (let i = 1; i < names.length; i++) expect(w.indexOf(names[i - 1])).toBeLessThan(w.indexOf(names[i]));
    for (const header of ["Money", "Leads", "Today", "Waiting", "Requests"]) expect(w, header).not.toContain(header);
  });

  it("the strip comes first, then the tiles, then the open tile's rows in the order the server sent them; a reversed list stays reversed", () => {
    const w = words(given, { defaultOpen: "win_work" });
    const at = (id: string) => w.indexOf(id);
    expect(at(t("ny_stripTitle"))).toBeLessThan(at("row-now"));
    expect(at("row-now")).toBeLessThan(at(t("ny_btn_tileGetPaid")));
    expect(at(t("ny_btn_tileBookkeeping"))).toBeLessThan(at("row-other"));
    expect(at("row-other")).toBeLessThan(at("row-lead"));
    expect(at("row-lead")).toBeLessThan(at("row-draft"));
    // Another tile's rows wait behind their tile.
    expect(w).not.toContain("row-today");
    // Given another order, it keeps it: the board never re-sorts what the server sorted.
    const flipped = words([...given].reverse(), { defaultOpen: "win_work" });
    expect(flipped.indexOf("row-draft")).toBeLessThan(flipped.indexOf("row-lead"));
    expect(flipped.indexOf("row-lead")).toBeLessThan(flipped.indexOf("row-other"));
  });

  it("a NOW row is drawn in the strip and nowhere else, whichever tile is open; no NOW, no strip", () => {
    for (const g of GROUP_ORDER) {
      const html = renderToStaticMarkup(createElement(ActionList, { items: given, todayStr: "2026-09-26", isStaff: true, defaultOpen: g }));
      expect(html.match(/data-row="row-now"/g), g).toHaveLength(1);
      const strip = html.slice(html.indexOf("data-strip"), html.indexOf("data-tile="));
      expect(strip).toContain('data-row="row-now"');
    }
    const calm = renderToStaticMarkup(createElement(ActionList, { items: given.slice(1), todayStr: "2026-09-26", isStaff: true }));
    expect(calm).not.toContain("data-strip");
    expect(calm).not.toContain(t("ny_stripTitle"));
  });

  it("the tile that opens first is the first with a SOON row (Sales here); one tile is pressed; a closed board draws no rows under the tiles", () => {
    const html = renderToStaticMarkup(createElement(ActionList, { items: given, todayStr: "2026-09-26", isStaff: true }));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/data-tile="win_work"[^>]*aria-pressed="true"/);
    const closed = renderToStaticMarkup(createElement(ActionList, { items: given, todayStr: "2026-09-26", isStaff: true, defaultOpen: null }));
    expect(closed).not.toContain("aria-pressed=\"true\"");
    for (const id of ["row-other", "row-lead", "row-draft", "row-today"]) expect(closed).not.toContain(`data-row="${id}"`);
  });

  it("the header counts what is open (an octagon and 1, a triangle and 1, then the rest); an empty tile is drawn dimmed and disabled", () => {
    const html = renderToStaticMarkup(createElement(ActionList, { items: given, todayStr: "2026-09-26", isStaff: true }));
    const counts = html.slice(html.indexOf("data-counts"), html.indexOf("data-tile="));
    expect(counts).toContain('data-shape="octagon"');
    expect(counts).toContain('data-shape="triangle"');
    expect(counts).toContain(say("ny_countMore", { n: 3 }));
    // Get Paid and Bookkeeping hold nothing: drawn, disabled, no number.
    expect(html).toMatch(/<button[^>]*data-tile="get_paid"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*data-tile="keep_books"[^>]*disabled=""/);
    // An open tile left with nothing says so.
    const empty = renderToStaticMarkup(createElement(ActionList, { items: given, todayStr: "2026-09-26", isStaff: true, defaultOpen: "keep_books" }));
    expect(empty).toContain(t("ny_groupEmpty"));
  });

  it("no chip is drawn: no Badge, no kind word, no red '!', no pip", () => {
    const html = everyTile([
      item({ id: "a", kind: "invoice_overdue", urgency: 2 }),
      item({ id: "b", kind: "quote_accepted", level: "now" }),
      item({ id: "c", kind: "time_stray", chip: "Clock Left Running", subtitle: "Clock left running since Tuesday" }),
      item({ id: "e", kind: "visit_unbilled", chip: "Billed, Not Paid" }),
      item({ id: "f", kind: "stock_short" }),
      item({ id: "g", kind: "job_on_hold" }),
    ]);
    expect(html).not.toContain(BADGE);
    expect(html).not.toContain("data-pip");
    const w = html.replace(/<[^>]+>/g, "\n").split("\n").map((x) => x.trim());
    for (const chip of ["Past Due", "Won", "Clock Left Running", "Billed, Not Paid", "To Settle", "Reminder", "!"]) expect(w, chip).not.toContain(chip);
    // The row's own words are drawn (its WHAT; until a feeder says one, its subtitle).
    expect(w).toContain("Clock left running since Tuesday");
  });

  it("a row already done sinks below the rest of its tile, keeping their order", () => {
    const w = words([item({ id: "first", kind: "quote_draft", done: true }), item({ id: "second", kind: "inquiry" }), item({ id: "third", kind: "contract_unsigned" })], { defaultOpen: "win_work" });
    expect(w.indexOf("second")).toBeLessThan(w.indexOf("third"));
    expect(w.indexOf("third")).toBeLessThan(w.indexOf("first"));
  });

  it("a tech sees no tiles and no strip: the title, the counts and his rows flat, with no button, no ⋯ and no money", () => {
    const html = renderToStaticMarkup(
      createElement(ActionList, {
        // A visit nobody closed out is never Due (cn-v1162): the tech's rows are plain.
        items: [item({ id: "visit", kind: "appointment", amount: 120, affordances: ["open"] }), item({ id: "visit2", kind: "appointment" })],
        todayStr: "2026-09-26",
        isStaff: false,
        title: "My Board",
      }),
    );
    expect(html).toContain("My Board");
    expect(html).not.toContain("data-tile=");
    expect(html).not.toContain("data-strip");
    expect(html).toContain('data-row="visit"');
    expect(html).toContain('data-row="visit2"');
    expect(html).not.toContain("$");
    expect(html).not.toContain("More for");
    expect(html).not.toMatch(/-my-3 inline-flex h-11/);
  });

  it("a failed read is a row with no mark and no button, its sentence never cut", () => {
    const html = renderToStaticMarkup(
      createElement(ActionList, {
        items: [item({ id: "receipts-unread", kind: "receipt_unbilled", title: "Receipts", subtitle: "The receipts could not be read. Open Bills to see them." })],
        todayStr: "2026-09-26",
        isStaff: true,
      }),
    );
    const r = html.slice(html.indexOf('data-row="receipts-unread"'));
    expect(r).not.toContain("data-mark=");
    expect(r).not.toMatch(/-my-3 inline-flex h-11/);
    expect(r).toContain("whitespace-normal");
    expect(html.replace(/&#x27;/g, "'")).toContain(say("ny_tileUnread", { n: 1 }));
  });

  it("every tile is a 72px button with aria-pressed and aria-controls naming the rows' region, which follows the tiles", () => {
    const html = renderToStaticMarkup(createElement(ActionList, { items: given, todayStr: "2026-09-26", isStaff: true }));
    const tiles = Array.from(html.matchAll(/<button[^>]*data-tile="[^"]*"[^>]*>/g)).map((m) => m[0]);
    expect(tiles).toHaveLength(4);
    const controls = new Set(tiles.map((b) => b.match(/aria-controls="([^"]*)"/)![1]));
    expect(controls.size).toBe(1);
    const id = [...controls][0];
    for (const b of tiles) expect(b).toContain("min-h-[72px]");
    expect(html.indexOf(`id="${id}"`)).toBeGreaterThan(html.lastIndexOf("data-tile="));
  });
});

describe("ActionList — one named button per row, and ⋯ (W1-13)", () => {
  it("each row says its verb; the icon strip, the 20px box and the chevron are gone (five kinds in three tiles, each tile open once)", () => {
    const html = everyTile([
      item({ id: "inv", kind: "invoice_overdue" }),
      item({ id: "stock", kind: "stock_short" }),
      item({ id: "rec", kind: "receipt_unbilled" }),
      item({ id: "job", kind: "job_to_schedule", affordances: AFFORDANCES.job_to_schedule }),
      item({ id: "hold", kind: "job_on_hold", affordances: AFFORDANCES.job_on_hold, holdReason: "Waiting on the permit" }),
    ]);
    for (const label of ["Get Paid", "Settle It", "Record It", "Pick a Day", "Snooze", "Take Off Hold"]) expect(html, label).toContain(`>${label}<`);
    for (const gone of ['title="Dismiss"', 'aria-label="Mark done"', 'title="Open"', 'title="Assign to someone"', 'title="Schedule / set a date"']) expect(html, gone).not.toContain(gone);
    expect(html).not.toMatch(/Dismiss|Delete/);
    // A job needing a day has ⋯ (Assign, Finish, Cancel); an overdue invoice has nothing behind one.
    expect(html).toContain('aria-label="More for job"');
    expect(html).not.toContain('aria-label="More for inv"');
  });

  it("every button is 44px: the row's (the Call Back pattern) and the ⋯; the row opens from one target the size of the row", () => {
    expect(ROW_BUTTON).toMatch(/\bh-11\b/);
    expect(ROW_BUTTON).toContain("-my-3");
    const html = renderToStaticMarkup(createElement(ActionList, { items: [item({ id: "inv", kind: "invoice_overdue" })], todayStr: "2026-09-26", isStaff: true }));
    const link = html.match(/<a [^>]*>Get Paid<\/a>/)![0];
    expect(link).toMatch(/\bh-11\b/);
    // The open target covers the whole row (never two 20px lines), under the words.
    expect(html).toContain(`<button type="button" aria-label="${say("ny_openRow", { title: "inv" })}" class="absolute inset-0 rounded-xl"></button>`);
    expect(html).toContain('class="pointer-events-none relative min-w-0 flex-1"');
    // The group may wrap inside the row on a narrow phone (no shrink-0): its buttons never run off the card.
    expect(html).toMatch(/class="pointer-events-auto ml-auto flex max-w-full flex-wrap items-center justify-end gap-x-1 gap-y-6"><a [^>]*>Get Paid<\/a>/);
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
    expect(list).toContain("rowButtons(item, { leadsOn, isStaff: p.isStaff, lang: p.lang, words: p.t })");
    // The client never sorts: everything it shows is a filter of the server's order.
    for (const f of ["action-list.tsx", "needs-you-tiles.tsx", "level-mark.tsx", "waiting-fold.tsx"]) {
      const src = readFileSync(join(process.cwd(), "src/components/action-items", f), "utf8");
      expect(src, f).not.toMatch(/\.sort\(|toSorted|localeCompare/);
    }
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
    const seeAll = Array.from(html.matchAll(/<button[^>]*aria-expanded="false"[^>]*>([^<]*)<\/button>/g)).find((m) => m[1] === say("ny_btn_seeAll", { n: 3 }))![0];
    expect(seeAll).toMatch(/\bmin-h-11\b/);
    // An estimate not sent has no clock, so it is never Due (cn-v1162): the pile is plain, its picture
    // grey (the one for sending), and it says no due count; no pips.
    const pileHead = html.slice(html.indexOf('data-pile="estimates_not_sent"'));
    expect(pileHead).not.toContain("data-mark=");
    expect(pileHead).not.toContain("data-soon-count");
    expect(pileHead).toMatch(/data-picture="send" class="[^"]*text-slate-500"/);
    expect(pileHead.slice(0, pileHead.indexOf("data-row="))).not.toContain("data-tint");
    expect(html).not.toContain("data-pip");
    // Its verb is its pile's.
    expect(html).toMatch(/<button[^>]*>Send It<\/button>/);
  });

  it("a pile of rows that are Due wears its children's mark, says how many, and its picture is coloured in with its tile", () => {
    const due = [1, 2].map((i) =>
      item({ id: `invd-${i}`, kind: "invoice_draft", level: "soon", title: `Invoice INV-0${i} not sent`, when: `2026-09-0${i}`, affordances: AFFORDANCES.invoice_draft }),
    );
    const html = renderToStaticMarkup(createElement(ActionList, { items: rollUpPiles(due, { todayStr: "2026-09-26", isStaff: true, counts: {} }), todayStr: "2026-09-26", isStaff: true, defaultOpen: "get_paid" }));
    const head = html.slice(html.indexOf('data-pile="invoices_not_sent"'));
    expect(head).toMatch(/data-mark="soon"[^>]*data-shape="triangle"/);
    expect(head).toContain('data-soon-count="2"');
    expect(head).toMatch(/data-picture="send" data-tint="get_paid" class="[^"]*bg-lime-100 text-lime-800"/);
  });

  it("when not every one is here, See All opens the list page instead", () => {
    const html = renderToStaticMarkup(createElement(ActionList, { items: pile({ estimates_not_sent: { capped: true } }), todayStr: "2026-09-26", isStaff: true }));
    expect(html).toContain("Estimates Not Sent · 3+");
    expect(html).toContain(`>${t("ny_btn_seeAllOnEstimates")}</a>`);
    expect(html).toMatch(/<a[^>]*href="\/quotes\?status=draft"/);
  });

  it("a capped Done, Not Billed pile has no page that lists its rows: See All unfolds every row read here, never a link to /billing", () => {
    const done = [1, 2, 3].map((i) => item({ id: `unbilled-a${i}`, kind: "visit_unbilled", title: `Service call ${i}`, when: `2026-09-0${i}`, affordances: AFFORDANCES.visit_unbilled }));
    const items = rollUpPiles(done, { todayStr: "2026-09-26", isStaff: true, counts: { done_not_billed: { capped: true } } });
    const html = renderToStaticMarkup(createElement(ActionList, { items, todayStr: "2026-09-26", isStaff: true }));
    expect(html).toContain("Done, Not Billed · 3+");
    expect(html).toMatch(new RegExp(`<button[^>]*aria-expanded="false"[^>]*>${say("ny_btn_seeAllHere", { n: 3 })}</button>`));
    expect(html).not.toContain('href="/billing"');
    expect(html).not.toMatch(/See All On (Billing|Invoices)/);
  });

  it("the unfold and the fold are one client toggle (a second tap folds them)", () => {
    const list = readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");
    expect(list).toContain('{open ? t("ny_btn_seeLess") : fillSlots(t("ny_btn_seeAll"), { n: count })}');
    // ONE keyed list: the first child is keyed like the rest, so an open sheet leaves with its own row.
    expect(list).toContain("{[first, ...(open ? rest : [])].map((c) => (");
    expect(list).toContain("<Row key={c.id} {...p} item={c} nested />");
    const pile = list.slice(list.indexOf("function PileRow"), list.indexOf("function", list.indexOf("function PileRow") + 10));
    const rowsInPile = pile.match(/<Row\b[^>]*>/g) ?? [];
    expect(rowsInPile.length).toBeGreaterThan(0);
    for (const r of rowsInPile) expect(r, "no <Row in the pile is unkeyed").toMatch(/\bkey=\{/);
    // Acting on a child drops it and counts down in place; a lone one left is a plain row.
    expect(list).toContain("const count = Math.max(0, item.pile.count - gone);");
    expect(list).toContain("if (kids.length === 1 && !item.pile.capped && count <= 1) return <Row key={kids[0].id} item={kids[0]} {...rowProps} />;");
  });
});

describe("ActionList — a verb's refusal is always said, and the server's list decides what shows", () => {
  const list = () => readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");

  it("a sheet's verb (⋯, Snooze, Still Waiting, Set Aside Until…, Assign, a confirm, Pick a Day) waits for the server: its row and sheet stay to say a refusal", () => {
    for (const verb of ["snooze", "dismiss", "schedule", "do"] as const) {
      expect(verbLanding({ kind: "invoice_draft" }, verb, { sheet: true }).optimistic, verb).toBe(false);
    }
    // Every sheet sends with sheet: true (DoorForm, the ⋯ run rows, MoveToDay).
    const src = list();
    expect(src).toContain("const r = await p.run(item, verb, payload, { child: p.nested, sheet: true });");
    expect(src).toContain("const r = await p.run(p.item, a.verb, undefined, { child: p.nested, sheet: true });");
    expect(src).toContain("p.run(item, a.verb, { date: d }, { child: p.nested, sheet: true })");
    // The ⋯ run rows say a refusal in the sheet instead of closing on nothing.
    expect(src).toContain('else setErr(r.error ?? p.t("ny_couldntDoThat"));');
    expect(src).not.toContain("else setAsking(null);");
  });

  it("the list's own banner is neutral (BANNER); the three inside sheets wear the app's refusal look (ui/refusal)", () => {
    const src = list();
    const banners = src.match(/<div role="alert" className=\{.*?\}>/g) ?? [];
    expect(banners.filter((b) => b.includes("BANNER"))).toEqual(['<div role="alert" className={BANNER}>']);
    expect(banners.filter((b) => b.includes("SHEET_REFUSAL"))).toHaveLength(3);
    expect(banners).toHaveLength(4);
    expect(src).toContain('import { SHEET_REFUSAL } from "@/components/ui/refusal";');
    // The list's banner is the one drawn on the list (outside every sheet): MoreSheetBody and DoorForm hold the other three.
    const sheets = src.slice(src.indexOf("function MoreSheetBody"));
    expect(sheets).not.toContain("className={BANNER}");
    expect((sheets.match(/SHEET_REFUSAL/g) ?? []).length).toBe(3);
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
  const w = (o: Partial<WaitingItem>): WaitingItem => ({ id: "w1", kind: "job_on_hold", title: "Fernhill Panel · J-034", why: "Waiting on the permit", backOn: "2026-10-03", href: "/jobs/j34", ...o });

  it("drawn only when something waits; a grey count, never a badge; collapsed", () => {
    expect(renderToStaticMarkup(createElement(WaitingFold, { items: [] }))).toBe("");
    const html = renderToStaticMarkup(createElement(WaitingFold, { items: [w({}), w({ id: "w2" })] }));
    expect(html).toContain(t("ny_waiting"));
    // Its count is grey, but slate-500: slate-400 text is too faint to read (2.6:1).
    expect(html).toContain('<span class="text-slate-500">(2)</span>');
    expect(html).not.toContain("text-slate-400");
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
    expect(waitingLine(w({}))).toBe("Fernhill Panel · J-034 · Waiting on the permit · Back Oct 3");
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
      expect(KIND_GROUP[r.kind]).toBe("run_jobs");
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
    group: KIND_GROUP.time_stray,
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

/**
 * A DAY THAT HAPPENED IS NOT A DAY MISSED (cn-v1069 follow-up). An inspection done yesterday read
 * "1d overdue" and a visit from June "115d overdue": the one `when` field carries a deadline on
 * some kinds and the day the thing happened on others, and the list said overdue for both.
 */
describe("the when line: overdue for a deadline, ago for a day that happened", () => {
  const TZ = "America/Los_Angeles";
  it("a deadline past is overdue; a happened day past is yesterday or N days ago; today and the future read the same either way", () => {
    // Its words are the catalog's (ny_age*); English when no language is handed in.
    expect(prettyWhen("2026-10-07", "2026-10-08", TZ, true)).toBe(say("ny_ageOverdue", { n: 1 }));
    expect(prettyWhen("2026-10-07", "2026-10-08", TZ, false)).toBe(t("ny_ageYesterday"));
    expect(prettyWhen("2026-06-15", "2026-10-08", TZ, false)).toBe(say("ny_ageAgo", { n: 115 }));
    expect(prettyWhen("2026-10-08", "2026-10-08", TZ, false)).toBe(t("ny_ageToday"));
    expect(prettyWhen("2026-10-09", "2026-10-08", TZ, false)).toBe(t("ny_ageTomorrow"));
    // A timed value keeps its time: the inspection at 10 AM yesterday.
    expect(prettyWhen("2026-10-07T17:00:00.000Z", "2026-10-08", TZ, false)).toBe(`${t("ny_ageYesterday")} · 10:00 AM`);
    expect(prettyWhen("2026-10-07T17:00:00.000Z", "2026-10-08", TZ, true)).toBe(`${say("ny_ageOverdue", { n: 1 })} · 10:00 AM`);
    // Spanish reads the Spanish catalog and a Spanish clock.
    const es = translator("es");
    expect(prettyWhen("2026-10-07T17:00:00.000Z", "2026-10-08", TZ, false, "es", es)).toBe(`${es("ny_ageYesterday")} · 10:00 a. m.`);
  });
  it("every kind says which its day is, and the happened-day kinds are the ones whose day is the deed", () => {
    expect(Object.keys(WHEN_IS_A_DEADLINE).sort()).toEqual(Object.keys(KIND_GROUP).sort());
    for (const k of ["inspection_writeup", "visit_unbilled", "time_stray", "job_unbilled_work", "appointment", "receipt_unbilled"]) expect(WHEN_IS_A_DEADLINE[k as keyof typeof WHEN_IS_A_DEADLINE], k).toBe(false);
    for (const k of ["invoice_overdue", "inquiry", "lien_deadline", "supplier_pay", "job_on_hold", "permit_inspection"]) expect(WHEN_IS_A_DEADLINE[k as keyof typeof WHEN_IS_A_DEADLINE], k).toBe(true);
  });
  it("the list reads it: an inspection done yesterday is Yesterday on the row, never overdue", () => {
    const html = renderToStaticMarkup(createElement(ActionList, { items: [item({ id: "w", kind: "inspection_writeup", when: "2026-10-07T17:00:00.000Z" })], todayStr: "2026-10-08", isStaff: true }));
    // The right edge is row-words' age (lib/action-items/row-words): the day it happened, never a miss.
    expect(html).toContain(t("ny_ageYesterday"));
    expect(html).not.toContain("overdue");
  });
});

/**
 * A RECEIPT THAT NEVER WAS A COST (2026-11-10: a supplier's quote filed on a job as a Receipt). The
 * row keeps its one button, Record It, and gains a ⋯ holding Not a Cost (row-buttons.ts). It is a
 * confirm door, so the list's own sheet asks first, the row leaves once the server has answered and
 * a refusal is said in that sheet: nothing here is new machinery.
 */
describe("ActionList — a receipt row's Not a Cost", () => {
  const receipt = (o: Partial<ActionItem> = {}) =>
    item({ id: "receipt-doc-1", kind: "receipt_unbilled", title: "Receipt · Jun 18", subtitle: "Larkspur · J-014", href: "/jobs/job-1?tab=costs", affordances: AFFORDANCES.receipt_unbilled, ...o });
  const draw = (items: ActionItem[], isStaff = true) => renderToStaticMarkup(createElement(ActionList, { items, todayStr: "2026-11-10", isStaff }));

  it("Record It stays the row's one button, and the row has a 44px ⋯", () => {
    const html = draw([receipt()]);
    expect(html).toMatch(/<a [^>]*href="\/jobs\/job-1\?tab=costs"[^>]*>Record It<\/a>/);
    expect(html).toContain('aria-label="More for Receipt · Jun 18"');
    // The Couldn't Check line, a row built without the verb, and a tech's view have no ⋯.
    expect(draw([receipt({ id: "receipts-unread", title: "Receipts · Couldn't Check", affordances: ["open"] })])).not.toContain("More for");
    expect(draw([receipt({ affordances: ["open"] })])).not.toContain("More for");
    expect(draw([receipt()], false)).not.toContain("More for");
  });

  it("the row leaves once the server answers (never before): its sheet stays to say a refusal, and a pile counts down in place", () => {
    expect(verbLanding({ kind: "receipt_unbilled" }, "notACost", { sheet: true })).toEqual({ hides: "remove", optimistic: false });
    expect(verbLanding({ kind: "receipt_unbilled" }, "notACost", { sheet: true, child: true })).toEqual({ hides: "remove", optimistic: false });
    const list = readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");
    // A confirm door sends from DoorForm with sheet: true, then the list asks the server for its rows again.
    expect(list).toContain('<Button type="button" variant="destructive" onClick={() => send(a.verb)} disabled={pending}>');
    expect(list).toMatch(/if \(!landing\.optimistic\) hide\(\);[\s\S]{0,260}router\.refresh\(\);/);
    // Never the browser's own confirm.
    expect(list).not.toMatch(/window\.confirm|[^.\w]confirm\(/);
  });

  it("in a pile, each receipt carries its own ⋯ under the pile's one verb", () => {
    const rows = [1, 2, 3].map((i) => receipt({ id: `receipt-doc-${i}`, title: `Receipt · Jun ${17 + i}`, since: `2026-06-${17 + i}` }));
    const html = draw(rollUpPiles(rows, { todayStr: "2026-11-10", isStaff: true, counts: {} }));
    expect(html).toContain("Receipts Not on a Bill · 3");
    expect(html).toContain('aria-label="More for Receipt · Jun 18"');
    expect(html).toMatch(/<button[^>]*>Record It<\/button>/);
  });
});

/**
 * A NAME'S LAST SHORT TAG STAYS WITH ITS WORD, AND ONE LONG WORD STILL WRAPS (cn-v1162 fixer). A
 * name may run to two lines on a phone (one from sm up), clamped there, never `truncate`d; Tagged
 * keeps " · J-061" or " · 3" with the word before it; and since a clamp draws no ellipsis for one
 * unbreakable word (a file name), the name wraps anywhere, so the clamp ends it.
 */
describe("ActionList — the name's tag and its clamp", () => {
  const rowHtml = (who: string) =>
    renderToStaticMarkup(createElement(ActionList, { items: [item({ id: "r-tag", kind: "job_to_schedule", who })], todayStr: "2026-09-26", isStaff: true, defaultOpen: "run_jobs" }));
  const CLAMP = ["line-clamp-2", "sm:line-clamp-1", "[overflow-wrap:anywhere]"];

  it("a WHO ending in a short tag keeps the tag in one nowrap span, the words unchanged", () => {
    const html = rowHtml("Larkspur Panel · J-061");
    expect(html).toContain('Larkspur Panel<span class="whitespace-nowrap"> · J-061</span>');
    expect(html.replace(/<[^>]+>/g, "")).toContain("Larkspur Panel · J-061");
  });

  it("a WHO with no tag, or whose last part has a space, draws no nowrap span", () => {
    for (const who of ["Theo Vance", "Receipts · Couldn't Check"]) {
      const html = rowHtml(who);
      expect(html).toContain(who.replace("'", "&#x27;"));
      expect(html).not.toContain('class="whitespace-nowrap"');
    }
  });

  it("the WHO is clamped (two lines, one from sm), wraps anywhere, and is never truncate", () => {
    const html = rowHtml("PXL_20261104_171233456.jpg");
    const span = /<span class="([^"]*)">PXL_20261104_171233456\.jpg<\/span>/.exec(html)![1].split(" ");
    for (const c of CLAMP) expect(span).toContain(c);
    expect(span).not.toContain("truncate");
  });

  it("a pile's title keeps ' · 3' and ' · 3+' in a nowrap span, and is clamped the same way", () => {
    const drafts = [1, 2, 3].map((i) =>
      item({ id: `qdraft-t${i}`, kind: "quote_draft", title: `Estimate E-0${i} started, never sent`, when: `2026-09-0${i}`, affordances: AFFORDANCES.quote_draft }),
    );
    for (const capped of [false, true]) {
      const html = renderToStaticMarkup(
        createElement(ActionList, { items: rollUpPiles(drafts, { todayStr: "2026-09-26", isStaff: true, counts: capped ? { estimates_not_sent: { capped: true } } : {} }), todayStr: "2026-09-26", isStaff: true }),
      );
      const tag = capped ? " · 3+" : " · 3";
      const m = new RegExp(`<span class="([^"]*)">Estimates Not Sent<span class="whitespace-nowrap">${tag.replace("+", "\\+")}</span></span>`).exec(html);
      expect(m, tag).not.toBeNull();
      const cls = m![1].split(" ");
      for (const c of CLAMP) expect(cls).toContain(c);
      expect(cls).not.toContain("truncate");
    }
  });
});

/**
 * ONE DUE VERSUS SEVERAL ON A PILE'S HEADER (cn-v1162 fixer): the visible count under a pile's name
 * says "1 due" / "3 due", and in Spanish "1 vence" / "3 vencen", built here from the real catalog.
 */
describe("ActionList — a pile's due count, one versus several", () => {
  const due = (lang: "en" | "es", n: number) => fillSlots(translator(lang)(n === 1 ? "ny_countDueOne" : "ny_countDue"), { n });
  const pileOf = (soon: number) =>
    rollUpPiles(
      [1, 2, 3].map((i) =>
        item({ id: `invd-s${i}`, kind: "invoice_draft", level: i <= soon ? "soon" : "none", title: `Invoice INV-0${i} not sent`, when: `2026-09-0${i}`, affordances: AFFORDANCES.invoice_draft }),
      ),
      { todayStr: "2026-09-26", isStaff: true, counts: {} },
    );

  it("says the catalog's words in both languages", () => {
    expect([due("en", 1), due("en", 3), due("es", 1), due("es", 3)]).toEqual(["1 due", "3 due", "1 vence", "3 vencen"]);
    for (const lang of ["en", "es"] as const)
      for (const n of [1, 3]) {
        const html = renderToStaticMarkup(
          createElement(LangProvider, { lang, children: createElement(ActionList, { items: pileOf(n), todayStr: "2026-09-26", isStaff: true, defaultOpen: "get_paid" }) }),
        );
        expect(html, `${lang} ${n}`).toContain(`<span data-soon-count="${n}">${due(lang, n)}</span>`);
      }
  });
});
