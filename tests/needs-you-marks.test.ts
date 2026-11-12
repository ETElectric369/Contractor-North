import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE NEEDS YOU BOX, PROVED WHERE A PERSON SEES IT (cn-v1161, plan section E "New tests 4").
 *
 * Every other test of the redraw proves one lane's half: the rule counts, the feeders say keys, the
 * catalog holds words, the board draws a row. This file renders the REAL board (the real rule, the
 * real piles, the real catalog in both languages) over lists shaped the way the feeders build them,
 * and reads what is DRAWN: where red and amber sit, what the header says against the rows under it,
 * where a NOW row lands, what a tech sees, and that no raw key and no doubled sum ever reaches a
 * screen. The seams between lanes are here because no single lane could see them.
 *
 * The test environment is node: renderToStaticMarkup, no effects, no document. A small tag walker
 * below turns the markup into a tree, so "inside a mark" means inside, not "somewhere after".
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/action-items/dispatch", () => ({ dispatchAction: vi.fn() }));
vi.mock("@/components/supplier-paper-cards", () => ({ SupplierPaperCards: () => null, SUPPLIER_PAPERS_SCOPE: "my-day" }));
vi.mock("@/components/move-to-day", () => ({ MoveToDay: ({ children }: { children: unknown }) => children as never }));
vi.mock("@/components/send-sheet", () => ({ SendSheet: () => null }));

import { ActionList } from "@/components/action-items/action-list";
import { LangProvider } from "@/components/lang-provider";
import { AFFORDANCES, KIND_GROUP, sortActionItems, type ActionItem, type ActionKind, type Group } from "@/lib/action-items/types";
import { GROUP_ORDER, levelOf } from "@/lib/action-items/needs-you-rule";
import { rollUpPiles } from "@/lib/action-items/piles";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";

// ---------------------------------------------------------------------------------------------
// The lists. Dates are handed in (no clock); every name and street is a stand-in.
// ---------------------------------------------------------------------------------------------

const TODAY = "2026-11-11";
const TZ = "America/Los_Angeles";
const dayFrom = (n: number) => new Date(Date.parse(`${TODAY}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ago = (n: number) => dayFrom(-n);
const ahead = (n: number) => dayFrom(n);

type Raw = Omit<ActionItem, "group">;
const raw = (kind: ActionKind, id: string, o: Partial<Raw> = {}): Raw => ({
  id,
  kind,
  title: `${kind} ${id}`,
  subtitle: null,
  who: null,
  when: null,
  urgency: 1,
  done: false,
  href: `/x/${id}`,
  affordances: AFFORDANCES[kind],
  ...o,
});

/** What query.ts does once: stamp each row's tile and mark, sort, then roll the piles. */
const build = (rows: Raw[], isStaff: boolean): ActionItem[] =>
  rollUpPiles(
    sortActionItems(
      rows.map((it) => ({ ...it, group: KIND_GROUP[it.kind], level: levelOf(it, { todayStr: TODAY, tz: TZ }) })),
      TODAY,
    ),
    { todayStr: TODAY, isStaff, counts: {} },
  );

/** About twenty-five rows over all four tiles, each in the shape its feeder hands over. */
const OWNER_ROWS: Raw[] = [
  // NOW: a won estimate that needs a day, and a clock left running from yesterday.
  raw("quote_accepted", "won-1040", {
    who: "Sam Tillery",
    what: { key: "ny_w_saidYes", vars: { ref: "E-1040" }, tail: "Larkspur Panel · J-061" },
    amount: 4250,
    when: ago(2),
    dated: "Accepted",
    urgency: 2,
    targetId: "job-61",
  }),
  raw("time_stray", "stray-clock-7", { who: "Theo", what: { key: "ny_w_clockRunning" }, when: `${ago(1)}T15:30:00Z`, urgency: 2, chip: "Clock Left Running", href: "/timecards" }),
  // NOW: three invoices more than thirty days late (one pile in the strip).
  raw("invoice_overdue", "inv-1022", { who: "Theo Vance", what: { key: "ny_w_invoice", vars: { ref: "INV-1022" } }, amount: 1875, when: ago(66), urgency: 2 }),
  raw("invoice_overdue", "inv-1029", { who: "Casey Loam", what: { key: "ny_w_invoice", vars: { ref: "INV-1029" } }, amount: 640, when: ago(52), urgency: 2 }),
  raw("invoice_overdue", "inv-1031", { who: "Dana Rook", what: { key: "ny_w_invoice", vars: { ref: "INV-1031" } }, amount: 2210.5, when: ago(41), urgency: 2 }),
  // Get Paid: a late invoice not yet a month, two unsent (a pile), a done visit not billed.
  raw("invoice_overdue", "inv-1045", { who: "Casey Loam", what: { key: "ny_w_invoice", vars: { ref: "INV-1045" } }, amount: 860, when: ago(12), urgency: 1 }),
  raw("invoice_draft", "invd-1047", { who: "Dana Rook", what: { key: "ny_w_invoiceNotSent", vars: { ref: "INV-1047" }, tail: "Bayberry Service · J-066" }, amount: 1000, when: ago(2), urgency: 0 }),
  raw("invoice_draft", "invd-1048", { who: "Sam Tillery", what: { key: "ny_w_invoiceNotSent", vars: { ref: "INV-1048" }, tail: "Larkspur Panel · J-061" }, amount: 1340, when: ago(9), urgency: 0 }),
  raw("visit_unbilled", "unbilled-v88", { who: "Theo Vance", what: { key: "ny_w_visitNotBilled", vars: { text: "Service call" } }, when: ago(9) }),
  // Win Work: an offer about to end, three estimates not sent (a pile), a new lead, a contract.
  raw("quote_awaiting", "qa-1037", {
    who: "Casey Loam",
    what: { key: "ny_w_docOfferEnds", vars: { docKey: "ny_docEstimate", ref: "E-1037", day: ahead(3) } },
    amount: 6480,
    when: ahead(3),
    since: ago(11),
    dated: "Sent",
  }),
  raw("quote_draft", "qdraft-1041", { who: "Dana Rook", what: { key: "ny_w_docNotSent", vars: { docKey: "ny_docEstimate", ref: "E-1041" } }, amount: 2150, when: ago(15), dated: "Started", urgency: 0 }),
  raw("quote_draft", "qdraft-1042", { who: "Theo Vance", what: { key: "ny_w_docNotSent", vars: { docKey: "ny_docEstimate", ref: "E-1042" } }, amount: 980, when: ago(10), dated: "Started", urgency: 0 }),
  raw("quote_draft", "qdraft-1043", { who: "Sam Tillery", what: { key: "ny_w_docNotSent", vars: { docKey: "ny_docEstimate", ref: "E-1043" } }, amount: 3400, when: ago(3), dated: "Started", urgency: 0 }),
  raw("inquiry", "lead-77", { who: "Casey Loam", what: { key: "ny_w_leadNew" }, since: ago(1), urgency: 2, phone: "(530) 555-0100" }),
  raw("contract_unsigned", "contract-12", { who: "Sam Tillery", what: { key: "ny_w_contractNotSigned", vars: { ref: "C-012" }, tail: "Larkspur Panel · J-061" }, when: ago(3) }),
  // Run the Jobs: two jobs with no day (a pile), a visit not closed out, materials, a hold back.
  raw("job_to_schedule", "jneed-j58", { who: "Snowbell Remodel · J-058", what: { key: "ny_w_quietSince", vars: { day: ago(12) }, tail: "Dana Rook" }, since: ago(12) }),
  raw("job_to_schedule", "jneed-j63", { who: "Thistlewood Repair · J-063", what: { key: "ny_w_neverHadADay", tail: "Theo Vance" }, since: ago(4) }),
  raw("appointment", "appt-501", { who: "Dana Rook", what: { key: "ny_w_visitNotClosed", vars: { type: "inspection" } }, when: `${ago(2)}T17:00:00Z` }),
  raw("materials_needed", "mat-j61", {
    who: "Larkspur Panel · J-061",
    what: { key: "ny_w_toBuy", vars: { n: 3, text: "200A panel, 4 breakers, 30 ft 2/0", andKey: "ny_w_plusMore", andN: 2 } },
    when: TODAY,
    openToBuy: 5,
  }),
  raw("job_on_hold", "onhold-j49", {
    who: "Thistlewood Addition · J-049",
    what: { key: "ny_w_holdBack", vars: { text: "Waiting on the utility" }, tail: "Casey Loam" },
    since: ago(3),
    holdReason: "Waiting on the utility",
  }),
  // Keep the Books: a failed read, supplier bills, a discount date, stock taken short, a receipt.
  raw("receipt_unbilled", "receipts-unread", {
    title: "Receipts · Couldn't Check",
    whoSay: { key: "ny_who_unread", vars: { labelKey: "ny_lbl_receipts" } },
    what: { key: "ny_w_unreadReceipts" },
    affordances: ["open"],
    href: "/bills",
  }),
  raw("supplier_paper", "supplier-papers", { whoSay: { key: "ny_who_supplierBills", vars: { n: 3 } }, what: { key: "ny_w_fromSuppliers" }, amount: 1284.5, href: "/bills" }),
  raw("supplier_pay", "supplierpay-a1", {
    who: "Bayberry Electric Supply",
    what: { key: "ny_w_payBySavesMany", vars: { day: ahead(6), money: 35.5, n: 2 } },
    amount: 2310,
    when: ahead(6),
    payee: "Bayberry Electric Supply",
  }),
  raw("stock_short", "short-3", { who: "Larkspur Panel · J-061", what: { key: "ny_w_takenPastStock", vars: { name: "Theo", text: "3 × 20A breaker" } }, since: ago(12) }),
  raw("receipt_unbilled", "receipt-doc-9", { who: "Snowbell Remodel · J-058", what: { key: "ny_w_receiptFrom", vars: { name: "Sam" } }, since: ago(2) }),
];
const OWNER = build(OWNER_ROWS, true);

/** Nothing NOW, and Get Paid and Keep the Books empty. */
const CALM = build(
  OWNER_ROWS.filter((r) => KIND_GROUP[r.kind] === "win_work" || (KIND_GROUP[r.kind] === "run_jobs" && r.kind !== "quote_accepted" && r.kind !== "time_stray")),
  true,
);

/** A small mixed list: one NOW row, a lone row in each of three tiles. */
const SMALL = build(
  OWNER_ROWS.filter((r) => ["won-1040", "inv-1045", "lead-77", "appt-501", "receipt-doc-9"].includes(r.id)),
  true,
);

/** A tech's own visits (one even carries money it must never show). */
const TECH = build(
  [
    raw("appointment", "appt-610", { who: "Dana Rook", what: { key: "ny_w_visitNotClosed", vars: { type: "service_call" } }, when: `${ago(9)}T16:00:00Z`, affordances: ["open"], amount: 420 }),
    raw("appointment", "appt-611", { who: "Casey Loam", what: { key: "ny_w_visitNotClosed", vars: { type: "inspection" } }, when: `${ago(1)}T18:00:00Z`, affordances: ["open"] }),
    raw("appointment", "appt-612", { who: "Theo Vance", what: { key: "ny_w_visitNotClosedTitled", vars: { text: "Bayberry hot tub", type: "service_call" } }, when: `${ago(3)}T19:00:00Z`, affordances: ["open"] }),
  ],
  false,
);

const LISTS: Record<string, ActionItem[]> = { owner: OWNER, calm: CALM, small: SMALL };

// ---------------------------------------------------------------------------------------------
// Drawing, and reading what was drawn.
// ---------------------------------------------------------------------------------------------

const draw = (items: ActionItem[], o: { isStaff?: boolean; open?: Group | null; lang?: Lang } = {}) =>
  renderToStaticMarkup(
    createElement(LangProvider, {
      lang: o.lang ?? "en",
      children: createElement(ActionList, {
        items,
        todayStr: TODAY,
        tz: TZ,
        isStaff: o.isStaff ?? true,
        title: translator(o.lang ?? "en")("md_needsYou"),
        ...(o.open !== undefined ? { defaultOpen: o.open } : {}),
      }),
    }),
  );

type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; parent: El | null };
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** renderToStaticMarkup's output is well formed: a tag walker is enough to rebuild the tree. */
function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, kids: [], parent: null };
  let at = root;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[1]) {
      if (at.tag !== m[1]) throw new Error(`unbalanced </${m[1]}> inside <${at.tag}>`);
      at = at.parent!;
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? "").matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? "");
      const el: El = { tag: m[2], attrs, kids: [], parent: at };
      at.kids.push(el);
      if (!m[4] && !VOID.has(m[2])) at = el;
    } else if (m[5]) {
      at.kids.push(decode(m[5]));
    }
  }
  if (at !== root) throw new Error(`unclosed <${at.tag}>`);
  return root;
}
const elements = (el: El): El[] => el.kids.flatMap((k) => (typeof k === "string" ? [] : [k, ...elements(k)]));
const textOf = (el: El): string => el.kids.map((k) => (typeof k === "string" ? k : textOf(k))).join("");
const classes = (el: El) => (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
const ancestors = (el: El): El[] => (el.parent ? [el.parent, ...ancestors(el.parent)] : []);
const holdsText = (el: El): boolean => el.kids.some((k) => (typeof k === "string" ? k.trim().length > 0 : holdsText(k)));
const one = (root: El, pred: (e: El) => boolean) => elements(root).find(pred);
const all = (root: El, pred: (e: El) => boolean) => elements(root).filter(pred);

/** The rows drawn at the top of a place (a plain row or a pile; never a pile's own children). */
const topRows = (place: El | undefined) => (place ? place.kids.filter((k): k is El => typeof k !== "string" && ("data-row" in k.attrs || "data-pile" in k.attrs)) : []);
const stripOf = (root: El) => one(root, (e) => "data-strip" in e.attrs);
const regionOf = (root: El) => one(root, (e) => e.attrs.role === "region");
const idOf = (row: El) => row.attrs["data-row"] ?? `pile:${row.attrs["data-pile"]}`;

/** The header's three numbers, as drawn: the digit beside each mark, and the leading number of "N more". */
function headerCounts(root: El) {
  const num = (which: string) => {
    const c = one(root, (e) => e.attrs["data-count"] === which);
    if (!c) return 0;
    // The drawn digit (the mark beside it is aria-hidden too, decorative: the sr-only sentence says both).
    const digit = which === "more" ? textOf(c) : textOf(one(c, (e) => e.attrs["aria-hidden"] === "true" && classes(e).includes("tabular-nums"))!);
    return Number(digit.match(/\d+/)![0]);
  };
  return { now: num("now"), soon: num("soon"), more: num("more") };
}

/** Each tile as drawn: its id, its big number (none: 0), its SOON count, pressed, disabled. */
function tilesOf(root: El) {
  return all(root, (e) => e.tag === "button" && "data-tile" in e.attrs).map((b) => {
    const big = one(b, (e) => classes(e).includes("text-xl"));
    const soon = one(b, (e) => "data-tile-soon" in e.attrs);
    return {
      id: b.attrs["data-tile"] as Group,
      name: textOf(b.kids.find((k): k is El => typeof k !== "string")!),
      count: big ? Number(textOf(big)) : 0,
      hasNumber: !!big,
      soon: soon ? Number(soon.attrs["data-tile-soon"]) : 0,
      pressed: b.attrs["aria-pressed"] === "true",
      disabled: "disabled" in b.attrs,
      label: b.attrs["aria-label"],
      classes: classes(b),
    };
  });
}

const RED_AMBER = /^(?:[a-z-]+:)*(?:bg|text|fill|stroke|border|ring|outline|from|to|via|decoration|shadow|accent|caret)-(?:red|amber)-\d{2,3}(?:\/\d+)?$/;
const RAW_KEY = /(?<![A-Za-z0-9])(?:ny|ag|md|su|ld)_[A-Za-z]/;
const BOX_FILES = [
  "src/components/action-items/action-list.tsx",
  "src/components/action-items/needs-you-tiles.tsx",
  "src/components/action-items/level-mark.tsx",
  "src/components/action-items/waiting-fold.tsx",
  "src/components/ui/tile-grid.tsx",
];
const en = translator("en");
const es = translator("es");

/** Every render a list can draw for staff: once per tile open, in both languages. */
const everyRender = (items: ActionItem[]) => (["en", "es"] as const).flatMap((lang) => GROUP_ORDER.map((g) => ({ lang, open: g, html: draw(items, { open: g, lang }) })));

// ---------------------------------------------------------------------------------------------
// The proofs.
// ---------------------------------------------------------------------------------------------

describe("red and amber mean urgency, and live only in the mark", () => {
  it("every element with a red or amber class sits inside a [data-mark], in every render of every list (staff and tech)", () => {
    const renders = [...Object.values(LISTS).flatMap(everyRender).map((r) => r.html), draw(TECH, { isStaff: false }), draw(TECH, { isStaff: false, lang: "es" })];
    let seen = 0;
    for (const html of renders) {
      for (const el of elements(parse(html))) {
        if (!classes(el).some((c) => RED_AMBER.test(c))) continue;
        seen++;
        const inMark = "data-mark" in el.attrs || ancestors(el).some((a) => "data-mark" in a.attrs);
        expect(inMark, `<${el.tag} class="${el.attrs.class}"> outside a mark`).toBe(true);
      }
    }
    // The owner's board draws marks, so the proof above is not proving nothing.
    expect(seen).toBeGreaterThan(0);
  });

  it("every NOW or SOON mark has a shape, a colour and a label; the octagon is red, the triangle amber with its darker edge", () => {
    for (const { html, lang } of everyRender(OWNER)) {
      const marks = all(parse(html), (e) => "data-mark" in e.attrs);
      expect(marks.length).toBeGreaterThan(0);
      const t = translator(lang);
      for (const m of marks) {
        const level = m.attrs["data-mark"];
        expect(["now", "soon"]).toContain(level);
        const inside = elements(m).flatMap(classes);
        expect(m.attrs["data-shape"]).toBe(level === "now" ? "octagon" : "triangle");
        if (level === "now") expect(inside).toContain("fill-red-600");
        else expect(inside).toEqual(expect.arrayContaining(["fill-amber-400", "stroke-amber-700"]));
        // In the header's counts the mark is decorative: its words are the sr-only sentence beside it,
        // so a screen reader says it once. Everywhere else the mark is an image with its own label.
        const count = ancestors(m).find((a) => "data-count" in a.attrs);
        if (count) {
          expect(m.attrs["aria-hidden"]).toBe("true");
          expect(m.attrs.role).toBeUndefined();
          expect(m.attrs["aria-label"]).toBeUndefined();
          expect(all(count, (e) => classes(e).includes("sr-only")).length).toBe(1);
          continue;
        }
        expect(m.attrs.role).toBe("img");
        expect(m.attrs["aria-label"]).toBe(t(level === "now" ? "ny_markNow" : "ny_markSoon"));
        expect(m.attrs["aria-label"]!.length).toBeGreaterThan(0);
      }
    }
  });

  it("in SOURCE, only level-mark.tsx holds a red or amber class across the box's files and the tile grid", () => {
    for (const f of BOX_FILES) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      const hits = src.match(/\b(?:[a-z-]+:)*(?:bg|text|fill|stroke|border|ring|outline|from|to|via|decoration|shadow|accent|caret)-(?:red|amber)-\d{2,3}\b/g) ?? [];
      if (f.endsWith("level-mark.tsx")) expect(hits.length, f).toBeGreaterThan(0);
      else expect(hits, f).toEqual([]);
    }
  });
});

describe("the header", () => {
  it("each count is a shape and a number: the octagon and the strip's count, the triangle and the SOON count", () => {
    const root = parse(draw(OWNER));
    const counts = one(root, (e) => "data-counts" in e.attrs)!;
    const now = one(counts, (e) => e.attrs["data-count"] === "now")!;
    const soon = one(counts, (e) => e.attrs["data-count"] === "soon")!;
    expect(one(now, (e) => e.attrs["data-shape"] === "octagon")).toBeTruthy();
    expect(one(soon, (e) => e.attrs["data-shape"] === "triangle")).toBeTruthy();
    for (const c of [now, soon]) expect(textOf(one(c, (e) => e.attrs["aria-hidden"] === "true" && classes(e).includes("tabular-nums"))!)).toMatch(/^\d+$/);
    // A screen reader hears the number said whole, never a bare digit.
    expect(textOf(one(now, (e) => classes(e).includes("sr-only"))!)).toBe(fillSlots(en("ny_countNow"), { n: headerCounts(root).now }));
    expect(headerCounts(root).now).toBe(3);
  });

  it("the three count invariants hold on what is DRAWN, for three lists: now + soon + more = the rows drawn; the tiles' numbers add to soon + more; their triangles add to soon", () => {
    for (const [name, items] of Object.entries(LISTS)) {
      const renders = GROUP_ORDER.map((g) => parse(draw(items, { open: g })));
      const h = headerCounts(renders[0]);
      const strip = topRows(stripOf(renders[0]));
      // Every render draws the same header and the same tiles: the open tile changes nothing it counts.
      for (const r of renders) {
        expect(headerCounts(r), name).toEqual(h);
        expect(tilesOf(r).map((x) => [x.id, x.count, x.soon]), name).toEqual(tilesOf(renders[0]).map((x) => [x.id, x.count, x.soon]));
      }
      const tiles = tilesOf(renders[0]);
      const inTiles = renders.map((r) => topRows(regionOf(r)));
      // Each tile's number is the rows that open under it, and its triangle the SOON ones among them.
      GROUP_ORDER.forEach((g, i) => {
        expect(tiles[i].count, `${name} ${g}`).toBe(inTiles[i].length);
        expect(tiles[i].soon, `${name} ${g}`).toBe(inTiles[i].filter((r) => r.attrs["data-level"] === "soon").length);
      });
      const drawn = [...strip, ...inTiles.flat()];
      expect(h.now, name).toBe(strip.length);
      expect(h.now + h.soon + h.more, name).toBe(drawn.length);
      expect(tiles.reduce((s, x) => s + x.count, 0), name).toBe(h.soon + h.more);
      expect(tiles.reduce((s, x) => s + x.soon, 0), name).toBe(h.soon);
      expect(drawn.filter((r) => r.attrs["data-level"] === "soon").length, name).toBe(h.soon);
      // Every row the server sent is drawn exactly once across the four renders (none lost, none twice).
      expect(new Set(drawn.map(idOf)).size, name).toBe(drawn.length);
      expect(drawn.length, name).toBe(items.length);
    }
    // A tech's flat rows answer to the same header.
    const tech = parse(draw(TECH, { isStaff: false }));
    const h = headerCounts(tech);
    const flat = elements(tech).filter((e) => ("data-row" in e.attrs || "data-pile" in e.attrs) && !ancestors(e).some((a) => "data-pile" in a.attrs));
    expect(h.now + h.soon + h.more).toBe(flat.length);
  });
});

describe("Act Today and the tiles", () => {
  it("a NOW row is in the strip and nowhere else, whichever tile is open, in both languages", () => {
    const nowIds = OWNER.filter((i) => i.level === "now").map((i) => i.id);
    // The server's order: oldest first, so the month-late invoices lead.
    expect(nowIds).toEqual(["pile:late_invoices:now", "won-1040", "stray-clock-7"]);
    for (const { html, open, lang } of everyRender(OWNER)) {
      const root = parse(html);
      const strip = stripOf(root)!;
      expect(topRows(strip).map(idOf), `${lang} ${open}`).toEqual(["pile:late_invoices", "won-1040", "stray-clock-7"]);
      // Every NOW thing drawn (a row, a pile, a pile's child) lies inside the strip.
      for (const el of all(root, (e) => e.attrs["data-level"] === "now")) expect(ancestors(el).includes(strip), `${lang} ${open}`).toBe(true);
      // And the strip's rows are drawn once: never again in the open tile.
      for (const id of ["won-1040", "stray-clock-7"]) expect(html.match(new RegExp(`data-row="${id}"`, "g")), id).toHaveLength(1);
      expect(html.match(/data-pile="late_invoices"/g)).toHaveLength(1);
      expect(topRows(regionOf(root)).some((r) => r.attrs["data-level"] === "now")).toBe(false);
    }
    // Nothing NOW: no strip at all.
    for (const g of GROUP_ORDER) expect(draw(CALM, { open: g })).not.toContain("data-strip");
  });

  it("four tiles in the fixed order, exactly one pressed (the one opened), all naming the same rows region", () => {
    for (const { html, open, lang } of everyRender(OWNER)) {
      const root = parse(html);
      const tiles = tilesOf(root);
      expect(tiles.map((x) => x.id)).toEqual(GROUP_ORDER);
      expect(tiles.filter((x) => x.pressed).map((x) => x.id), `${lang} ${open}`).toEqual([open]);
      const region = regionOf(root)!;
      for (const b of all(root, (e) => "data-tile" in e.attrs)) expect(b.attrs["aria-controls"]).toBe(region.attrs.id);
      expect(region.attrs["data-group"]).toBe(open);
    }
  });

  it("a zero tile is drawn, disabled, with no number; its label says nothing is open", () => {
    const root = parse(draw(CALM, { open: "win_work" }));
    const tiles = tilesOf(root);
    for (const id of ["get_paid", "keep_books"] as const) {
      const z = tiles.find((x) => x.id === id)!;
      expect(z.disabled, id).toBe(true);
      expect(z.hasNumber, id).toBe(false);
      expect(z.soon, id).toBe(0);
      expect(z.label).toBe(fillSlots(en("ny_tileNothing"), { name: z.name }));
    }
    for (const id of ["win_work", "run_jobs"] as const) {
      const live = tiles.find((x) => x.id === id)!;
      expect(live.disabled, id).toBe(false);
      expect(live.count, id).toBeGreaterThan(0);
    }
  });

  it("tiles, See All, every named button and every ⋯ are 44px targets or more", () => {
    for (const { html } of everyRender(OWNER)) {
      const root = parse(html);
      for (const t of tilesOf(root)) expect(t.classes).toContain("min-h-[72px]");
      const seeAll = all(root, (e) => (e.tag === "button" || e.tag === "a") && ancestors(e).some((a) => "data-pile" in a.attrs) && !classes(e).includes("absolute") && !classes(e).includes("-my-3") && !e.attrs["aria-label"]);
      expect(seeAll.length).toBeGreaterThan(0);
      for (const s of seeAll) expect(classes(s), textOf(s)).toContain("min-h-11");
      for (const b of all(root, (e) => classes(e).includes("-my-3"))) expect(classes(b)).toContain("h-11");
      const more = all(root, (e) => e.tag === "button" && /^(More for|Más para|Más de)/i.test(e.attrs["aria-label"] ?? ""));
      for (const m of more) expect(classes(m)).toEqual(expect.arrayContaining(["h-11", "w-11"]));
    }
  });

  it("no slate-400 text anywhere in the box (it reads 2.6:1); the Waiting fold included", () => {
    const renders = [...everyRender(OWNER).map((r) => r.html), draw(TECH, { isStaff: false }), draw([], {})];
    for (const html of renders) {
      for (const el of elements(parse(html))) {
        if (classes(el).some((c) => /^text-slate-(?:300|400)$/.test(c))) expect(holdsText(el), `<${el.tag} class="${el.attrs.class}">${textOf(el)}`).toBe(false);
      }
    }
  });
});

describe("a tech", () => {
  it("sees no $, no tiles, no strip and no buttons: only rows that open (and a pile's See All)", () => {
    for (const lang of ["en", "es"] as const) {
      const html = draw(TECH, { isStaff: false, lang });
      const root = parse(html);
      expect(html).not.toContain("$");
      expect(html).not.toMatch(/US\$|USD/);
      expect(html).not.toContain("data-tile");
      expect(html).not.toContain("data-strip");
      expect(html).not.toContain("tel:");
      for (const b of all(root, (e) => e.tag === "button" || e.tag === "a")) {
        const opens = classes(b).includes("absolute") && classes(b).includes("inset-0");
        const seeAll = "aria-expanded" in b.attrs && classes(b).includes("min-h-11");
        expect(opens || seeAll, `${lang}: <${b.tag} class="${b.attrs.class}">${textOf(b)}`).toBe(true);
      }
      // His rows are there, said as WHO and WHAT, with the age at the right edge.
      expect(textOf(root)).toContain("Dana Rook");
      expect(all(root, (e) => e.attrs["data-right"] === "money")).toHaveLength(0);
    }
  });
});

describe("Spanish, through the real catalog", () => {
  it("the four tile names are Spanish, and differ from the English", () => {
    const tiles = tilesOf(parse(draw(OWNER, { lang: "es", open: "get_paid" })));
    expect(tiles.map((x) => x.name)).toEqual(["Cobrar", "Ganar Trabajo", "Sacar los Trabajos", "Llevar las Cuentas"]);
    expect(tiles.map((x) => x.name)).toEqual(["ny_btn_tileGetPaid", "ny_btn_tileWinWork", "ny_btn_tileRunJobs", "ny_btn_tileKeepBooks"].map((k) => es(k)));
    const english = tilesOf(parse(draw(OWNER, { open: "get_paid" }))).map((x) => x.name);
    tiles.forEach((x, i) => expect(x.name).not.toBe(english[i]));
  });

  it("a row's WHAT is said in Spanish (the strip's won estimate, the open tile's late invoice)", () => {
    const text = textOf(parse(draw(OWNER, { lang: "es", open: "get_paid" })));
    expect(text).toContain("Dijo que sí a E-1040 · falta el día · Larkspur Panel · J-061");
    expect(text).toContain("Factura INV-1045");
    expect(text).toContain("Reloj sin cerrar");
    expect(text).toContain("Atender Hoy");
    expect(text).not.toContain("Said yes");
  });
});

describe("the seams between lanes", () => {
  /** The feeders' shapes: a docKey, an andKey with andN, a type, a day, money (and money2 as a second phrase). */
  const SEAM = build(
    [
      raw("quote_awaiting", "qa-1037", { who: "Casey Loam", what: { key: "ny_w_docOfferEnds", vars: { docKey: "ny_docEstimate", ref: "E-1037", day: ahead(3) } }, amount: 6480, when: ahead(3), since: ago(11), dated: "Sent" }),
      raw("materials_needed", "mat-j61", { who: "Larkspur Panel · J-061", what: { key: "ny_w_toBuy", vars: { n: 3, text: "panel, breakers, wire", andKey: "ny_w_plusMore", andN: 2 } }, when: TODAY, openToBuy: 5 }),
      raw("appointment", "appt-501", { who: "Dana Rook", what: { key: "ny_w_visitNotClosed", vars: { type: "inspection" } }, when: `${ago(2)}T17:00:00Z` }),
      raw("supplier_pay", "supplierpay-a1", {
        who: "Bayberry Electric Supply",
        what: { key: "ny_w_payBySavesOne", vars: { day: ahead(6), money: 35.5, n: 1, andKey: "ny_w_alreadySent", money2: 200 } },
        amount: 2310,
        when: ahead(6),
      }),
      raw("job_to_schedule", "jneed-j58", { who: "Snowbell Remodel · J-058", what: { key: "ny_w_quietSince", vars: { day: ago(12) }, tail: "Dana Rook" }, since: ago(12) }),
    ],
    true,
  );
  const whatOf = (root: El, id: string) => {
    const row = one(root, (e) => e.attrs["data-row"] === id)!;
    return textOf(one(row, (e) => classes(e).includes("text-xs") && classes(e).includes("text-slate-600") && classes(e).some((c) => c.startsWith("flex-[")))!);
  };

  it("(a) a feeder's Say (docKey, andKey/andN, type, day, money) is drawn as words in English, never as a key or an open slot", () => {
    const at = (g: Group) => parse(draw(SEAM, { open: g }));
    const win = at("win_work");
    const jobs = at("run_jobs");
    const books = at("keep_books");
    expect(whatOf(win, "qa-1037")).toMatch(/^Estimate E-1037 · offer ends \S.*\d/);
    expect(whatOf(jobs, "mat-j61")).toBe("3 to buy · panel, breakers, wire · +2 more");
    expect(whatOf(jobs, "appt-501")).toBe("Inspection · not closed out");
    expect(whatOf(books, "supplierpay-a1")).toMatch(/^Pay by \S.*\d · saves \$35\.50 on 1 invoice · \$200\.00 already sent$/);
    expect(whatOf(jobs, "jneed-j58")).toMatch(/^Quiet since \S.*\d · Dana Rook$/);
    for (const r of [win, jobs, books]) {
      expect(textOf(r)).not.toMatch(RAW_KEY);
      expect(textOf(r)).not.toMatch(/[{}]/);
    }
  });

  it("(a) the same rows in Spanish: Spanish words, never a key, never an open slot", () => {
    const at = (g: Group) => parse(draw(SEAM, { open: g, lang: "es" }));
    const win = at("win_work");
    const jobs = at("run_jobs");
    const books = at("keep_books");
    expect(whatOf(win, "qa-1037")).toMatch(/^Presupuesto E-1037 · la oferta termina el /);
    expect(whatOf(jobs, "mat-j61")).toBe("3 por comprar · panel, breakers, wire · +2 más");
    expect(whatOf(jobs, "appt-501")).toMatch(/ · sin cerrar$/);
    expect(whatOf(jobs, "appt-501")).not.toBe("Inspection · not closed out");
    expect(whatOf(books, "supplierpay-a1")).toMatch(/^Paga antes del \d{1,2} \S+ · ahorras \$35\.50 en 1 factura · Ya se envió \$200\.00$/);
    for (const r of [win, jobs, books]) {
      expect(textOf(r)).not.toMatch(RAW_KEY);
      expect(textOf(r)).not.toMatch(/[{}]/);
    }
  });

  it("(b) no raw key anywhere in a rendered box: English or Spanish, staff or tech, every tile, the empty box too", () => {
    const renders = [
      ...[...Object.values(LISTS), SEAM].flatMap(everyRender).map((r) => r.html),
      draw(TECH, { isStaff: false }),
      draw(TECH, { isStaff: false, lang: "es" }),
      draw([], {}),
      draw([], { lang: "es" }),
    ];
    for (const html of renders) {
      const hit = html.match(new RegExp(`.{0,40}${RAW_KEY.source}.{0,40}`));
      expect(hit?.[0] ?? null).toBeNull();
    }
  });

  it("(c) a staff pile draws its sum once, at its right edge, never a second time as '$X across N'", () => {
    for (const lang of ["en", "es"] as const) {
      // Invoices Not Sent: $1,000 + $1,340 in Get Paid; the late invoices' NOW pile in the strip.
      const root = parse(draw(OWNER, { open: "get_paid", lang }));
      for (const [name, sum] of [
        ["invoices_not_sent", 2340],
        ["late_invoices", 1875 + 640 + 2210.5],
      ] as const) {
        const pile = one(root, (e) => e.attrs["data-pile"] === name)!;
        const said = new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", { style: "currency", currency: "USD" }).format(sum);
        const header = pile.kids.find((k): k is El => typeof k !== "string")!;
        const right = all(header, (e) => e.attrs["data-right"] === "money");
        expect(right, `${lang} ${name}`).toHaveLength(1);
        // Whatever the locale's spelling, the pile's own header says one figure, and the whole pile says it once.
        const figure = textOf(right[0]);
        expect(figure).toMatch(/\d/);
        expect(textOf(pile).split(figure).length - 1, `${lang} ${name} ${figure}`).toBe(1);
        expect(textOf(pile)).not.toMatch(/across|entre \d/);
        if (lang === "en") expect(figure).toBe(said);
      }
    }
  });
});

describe("one right edge, and WHAT that wraps on a phone", () => {
  const MORE = /^(More for|Más para) /;
  const isMore = (e: El) => e.tag === "button" && MORE.test(e.attrs["aria-label"] ?? "");
  // The button group (cn-v1161 fixer): it may wrap inside the row, so it is no longer shrink-0.
  const isDoors = (e: El) => ["pointer-events-auto", "ml-auto", "flex", "flex-wrap"].every((c) => classes(e).includes(c));
  const isWhat = (e: El) => classes(e).includes("text-xs") && classes(e).some((c) => c.startsWith("flex-["));
  const staffRows = () => everyRender(OWNER).flatMap(({ html }) => all(parse(html), (e) => "data-row" in e.attrs));

  it("the ⋯ rides the row's second line inside its button wrapper, and the right edge shares its line with WHO only", () => {
    let withMore = 0;
    let withRight = 0;
    for (const row of staffRows()) {
      const mores = all(row, isMore);
      const doors = all(row, isDoors);
      expect(doors.length, row.attrs["data-row"]).toBeLessThanOrEqual(1);
      for (const m of mores) {
        withMore++;
        // Inside the one button wrapper, which sits on the WHAT line (the second line), never beside the row.
        expect(ancestors(m).includes(doors[0]), row.attrs["data-row"]).toBe(true);
        expect(classes(doors[0].parent!)).toContain("mt-0.5");
      }
      const right = one(row, (e) => "data-right" in e.attrs);
      if (!right) continue;
      withRight++;
      const line = right.parent!;
      const kids = line.kids.filter((k): k is El => typeof k !== "string");
      // The first line holds WHO and the right edge, nothing else: no button, no ⋯ pushes it in.
      expect(kids, row.attrs["data-row"]).toHaveLength(2);
      expect(classes(kids[0])).toContain("font-semibold");
      expect(kids[1]).toBe(right);
      expect(all(line, (e) => e.tag === "button" || e.tag === "a")).toHaveLength(0);
    }
    expect(withMore).toBeGreaterThan(0);
    expect(withRight).toBeGreaterThan(0);
  });

  it("the buttons can never run off a narrow phone: the group wraps inside the row, and a long label wraps inside its button", () => {
    let groups = 0;
    let buttons = 0;
    for (const row of staffRows()) {
      for (const g of all(row, isDoors)) {
        groups++;
        const c = classes(g);
        expect(c).toEqual(expect.arrayContaining(["max-w-full", "flex-wrap", "justify-end", "gap-x-1"]));
        expect(c).not.toContain("shrink-0");
        // A wrapped ⋯ (its wrapper is -my-3, 44px tall in a 20px line) clears the button above it.
        expect(c).toContain("gap-y-6");
      }
      for (const b of all(row, (e) => classes(e).includes("-my-3") && classes(e).includes("inline-flex"))) {
        buttons++;
        expect(classes(b)).toEqual(expect.arrayContaining(["max-w-full", "text-right", "h-11"]));
        expect(classes(b)).not.toContain("shrink-0");
        expect(classes(b)).not.toContain("whitespace-nowrap");
      }
    }
    expect(groups).toBeGreaterThan(0);
    expect(buttons).toBeGreaterThan(0);
  });

  it("an ordinary row's WHAT clamps at two lines on a phone and one from sm; a Couldn't Check sentence is never cut", () => {
    let ordinary = 0;
    let unread = 0;
    for (const row of staffRows()) {
      const what = one(row, isWhat);
      if (!what) continue;
      const c = classes(what);
      expect(c).not.toContain("truncate");
      if (row.attrs["data-row"]!.endsWith("-unread")) {
        unread++;
        expect(c).toContain("whitespace-normal");
        expect(c.filter((x) => /line-clamp/.test(x))).toEqual([]);
      } else {
        ordinary++;
        expect(c, row.attrs["data-row"]).toEqual(expect.arrayContaining(["line-clamp-2", "sm:line-clamp-1"]));
      }
    }
    expect(ordinary).toBeGreaterThan(0);
    expect(unread).toBeGreaterThan(0);
  });
});
