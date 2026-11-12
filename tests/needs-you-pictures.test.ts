import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PICTURES, PROVED WHERE A PERSON SEES THEM (cn-v1162, the owner's design, 2026-11-11: "the big
 * tiles get a picture with color and the smaller tiles that drop down get a picture with no color until
 * they get an alert then they get a colored in picture next to the alert").
 *
 * The real board is rendered (English and Spanish, staff and tech) over a small list of its own, with
 * each row's tile and mark STAMPED BY HAND, so this proof does not lean on the rule that decides them
 * (needs-you-rule.ts); it proves only what the board draws for a row already stamped. The test
 * environment is node: renderToStaticMarkup and a small tag walker.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/action-items/dispatch", () => ({ dispatchAction: vi.fn() }));
vi.mock("@/components/supplier-paper-cards", () => ({ SupplierPaperCards: () => null, SUPPLIER_PAPERS_SCOPE: "my-day" }));
vi.mock("@/components/move-to-day", () => ({ MoveToDay: ({ children }: { children: unknown }) => children as never }));
vi.mock("@/components/send-sheet", () => ({ SendSheet: () => null }));

import { ActionList } from "@/components/action-items/action-list";
import { GROUP_TINT } from "@/components/action-items/kind-picture";
import { LangProvider } from "@/components/lang-provider";
import { AFFORDANCES, type ActionItem, type ActionKind, type Group, type Level } from "@/lib/action-items/types";
import { GROUP_ORDER } from "@/lib/action-items/needs-you-rule";
import { KIND_PICTURE } from "@/lib/action-items/kind-picture";
import { rollUpPiles } from "@/lib/action-items/piles";
import type { Lang } from "@/lib/locale";

const TODAY = "2026-11-11";
const TZ = "America/Los_Angeles";

/** A row as the build hands it over, its tile and mark stamped here by hand. */
const row = (kind: ActionKind, id: string, group: Group, level: Level, o: Partial<ActionItem> = {}): ActionItem => ({
  id,
  kind,
  group,
  level,
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

/** Two invoices a month late: one NOW pile, drawn in the strip. */
const LATE = rollUpPiles(
  [
    row("invoice_overdue", "inv-2201", "get_paid", "now", { who: "Theo Vance", amount: 1875, when: "2026-09-20" }),
    row("invoice_overdue", "inv-2202", "get_paid", "now", { who: "Casey Loam", amount: 640, when: "2026-09-28" }),
  ],
  { todayStr: TODAY, isStaff: true, counts: {} },
);

/** In the server's order: the strip's rows, then each tile's. */
const STAFF: ActionItem[] = [
  ...LATE,
  row("quote_accepted", "won-2240", "run_jobs", "now", { who: "Sam Tillery", amount: 4250 }),
  row("invoice_draft", "invd-2247", "get_paid", "soon", { who: "Dana Rook", amount: 1000 }),
  row("visit_unbilled", "unbilled-v31", "get_paid", "none", { who: "Theo Vance" }),
  row("inquiry", "lead-91", "win_work", "soon", { who: "Casey Loam", phone: "(530) 555-0100" }),
  row("quote_draft", "qdraft-2251", "win_work", "none", { who: "Dana Rook", amount: 980 }),
  // Done: it keeps its stamped mark, and its picture is never coloured in.
  row("quote_awaiting", "qa-2237", "win_work", "soon", { who: "Sam Tillery", done: true }),
  row("materials_needed", "mat-j77", "run_jobs", "soon", { who: "Snowbell Panel · J-077" }),
  row("job_to_schedule", "jneed-j78", "run_jobs", "none", { who: "Bayberry Repair · J-078" }),
  // A failed read: no mark, no picture, the slot kept so its words start at the others' x.
  row("receipt_unbilled", "receipts-unread", "keep_books", "none", { title: "Receipts", subtitle: "The receipts could not be read. Open Bills to see them.", affordances: ["open"], href: "/bills" }),
  row("supplier_pay", "supplierpay-c4", "keep_books", "soon", { who: "Catbird Electric Supply", amount: 2310, payee: "Catbird Electric Supply" }),
  row("stock_short", "short-8", "keep_books", "none", { who: "Thistlewood Remodel · J-080" }),
];

/** A tech's own visits: plain, no money, no buttons. */
const TECH: ActionItem[] = [
  row("appointment", "appt-710", "run_jobs", "none", { who: "Dana Rook", affordances: ["open"] }),
  row("appointment", "appt-711", "run_jobs", "none", { who: "Casey Loam", affordances: ["open"] }),
];

const draw = (items: ActionItem[], o: { isStaff: boolean; open?: Group; lang: Lang }) =>
  renderToStaticMarkup(
    createElement(LangProvider, {
      lang: o.lang,
      children: createElement(ActionList, { items, todayStr: TODAY, tz: TZ, isStaff: o.isStaff, title: "Needs You", ...(o.open ? { defaultOpen: o.open } : {}) }),
    }),
  );

type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; parent: El | null };
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
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
      for (const a of (m[3] ?? "").matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? "";
      const el: El = { tag: m[2], attrs, kids: [], parent: at };
      at.kids.push(el);
      if (!m[4] && !VOID.has(m[2])) at = el;
    } else if (m[5]) {
      at.kids.push(m[5]);
    }
  }
  if (at !== root) throw new Error(`unclosed <${at.tag}>`);
  return root;
}
const elements = (el: El): El[] => el.kids.flatMap((k) => (typeof k === "string" ? [] : [k, ...elements(k)]));
const classes = (el: El) => (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
const ancestors = (el: El): El[] => (el.parent ? [el.parent, ...ancestors(el.parent)] : []);
const all = (root: El, pred: (e: El) => boolean) => elements(root).filter(pred);
const isThing = (e: El) => "data-row" in e.attrs || "data-pile" in e.attrs;
/** The nearest row or pile an element belongs to. */
const ownerOf = (e: El) => ancestors(e).find(isThing);
const siblingsOf = (e: El) => e.parent!.kids.filter((k): k is El => typeof k !== "string");

/** What each thing drawn should be: its tile, its kind, whether it is marked, done or a failed read. */
const facts = new Map<string, ActionItem>();
for (const it of [...STAFF, ...TECH]) {
  facts.set(it.pile ? `pile:${it.pile.name}` : it.id, it);
  for (const c of it.children ?? []) facts.set(c.id, c);
}
const keyOf = (e: El) => e.attrs["data-row"] ?? `pile:${e.attrs["data-pile"]}`;

/** Every render the board can draw: staff once per tile open, and a tech, in both languages. */
const RENDERS = (["en", "es"] as const).flatMap((lang) => [
  ...GROUP_ORDER.map((open) => ({ name: `${lang} staff ${open}`, isStaff: true, html: draw(STAFF, { isStaff: true, open, lang }) })),
  { name: `${lang} tech`, isStaff: false, html: draw(TECH, { isStaff: false, lang }) },
]);

describe("one picture per row and per pile header, right after the mark", () => {
  it("every row and every pile header draws exactly one picture slot, and it is the mark slot's next sibling", () => {
    let things = 0;
    for (const { name, html } of RENDERS) {
      const root = parse(html);
      const slots = all(root, (e) => "data-picture-slot" in e.attrs);
      for (const thing of all(root, isThing)) {
        things++;
        const own = slots.filter((s) => ownerOf(s) === thing);
        expect(own, `${name} ${keyOf(thing)}`).toHaveLength(1);
        const sibs = siblingsOf(own[0]);
        const i = sibs.indexOf(own[0]);
        expect(i, `${name} ${keyOf(thing)}`).toBe(1);
        expect("data-mark-slot" in sibs[0].attrs, `${name} ${keyOf(thing)}`).toBe(true);
      }
      // No slot outside a row or a pile (the header's counts and the tiles have none).
      for (const s of slots) expect(ownerOf(s), name).toBeTruthy();
    }
    expect(things).toBeGreaterThan(20);
  });

  it("each picture is its kind's, and a pile header wears its kind's", () => {
    for (const { name, html } of RENDERS) {
      for (const s of all(parse(html), (e) => "data-picture" in e.attrs)) {
        const it = facts.get(keyOf(ownerOf(s)!))!;
        expect(s.attrs["data-picture"], `${name} ${it.id}`).toBe(KIND_PICTURE[it.kind]);
      }
    }
  });
});

describe("grey until marked, then coloured in with its tile", () => {
  it("an unmarked row's picture is plain grey (no tint, no chip); a marked one's carries its own tile, in the strip too; a done one is never tinted", () => {
    let tinted = 0;
    let inStrip = 0;
    for (const { name, html } of RENDERS) {
      for (const s of all(parse(html), (e) => "data-picture" in e.attrs)) {
        const thing = ownerOf(s)!;
        const it = facts.get(keyOf(thing))!;
        const level = thing.attrs["data-level"];
        const marked = (level === "now" || level === "soon") && !it.done;
        const chips = classes(s).filter((c) => /^bg-/.test(c));
        if (!marked) {
          expect(s.attrs["data-tint"], `${name} ${it.id}`).toBeUndefined();
          expect(chips, `${name} ${it.id}`).toEqual([]);
          expect(classes(s), `${name} ${it.id}`).toContain("text-slate-500");
          continue;
        }
        tinted++;
        if (ancestors(s).some((a) => "data-strip" in a.attrs)) inStrip++;
        expect(s.attrs["data-tint"], `${name} ${it.id}`).toBe(it.group);
        expect(classes(s), `${name} ${it.id}`).toEqual(expect.arrayContaining([GROUP_TINT[it.group!].chip, GROUP_TINT[it.group!].ink]));
      }
    }
    expect(tinted).toBeGreaterThan(0);
    expect(inStrip).toBeGreaterThan(0);
  });

  it("the done row stays grey though its stamp says Due", () => {
    const html = draw(STAFF, { isStaff: true, open: "win_work", lang: "en" });
    const done = all(parse(html), (e) => e.attrs["data-row"] === "qa-2237")[0];
    expect(done.attrs["data-level"]).toBe("soon");
    const pic = all(done, (e) => "data-picture" in e.attrs)[0];
    expect(pic.attrs["data-tint"]).toBeUndefined();
    expect(classes(pic)).toContain("text-slate-500");
  });

  it("the strip's rows say their tile by colour: the late invoices Get Paid's, the yes Operations'", () => {
    const strip = all(parse(draw(STAFF, { isStaff: true, open: "keep_books", lang: "es" })), (e) => "data-strip" in e.attrs)[0];
    const tints = all(strip, (e) => "data-picture" in e.attrs).map((s) => `${keyOf(ownerOf(s)!)}=${s.attrs["data-tint"]}`);
    expect(tints).toEqual(expect.arrayContaining(["pile:late_invoices=get_paid", "inv-2201=get_paid", "won-2240=run_jobs"]));
  });

  it("a failed read's slot is empty: no picture, no tint, nothing inside", () => {
    const html = draw(STAFF, { isStaff: true, open: "keep_books", lang: "en" });
    const line = all(parse(html), (e) => e.attrs["data-row"] === "receipts-unread")[0];
    const slot = all(line, (e) => "data-picture-slot" in e.attrs)[0];
    expect(slot.kids).toEqual([]);
    expect(slot.attrs["data-picture"]).toBeUndefined();
    expect(slot.attrs["data-tint"]).toBeUndefined();
  });

  it("a tech's rows get the column too, plain", () => {
    for (const lang of ["en", "es"] as const) {
      const root = parse(draw(TECH, { isStaff: false, lang }));
      const pics = all(root, (e) => "data-picture" in e.attrs);
      expect(pics.map((p) => p.attrs["data-picture"])).toEqual(["visit", "visit"]);
      for (const p of pics) expect(p.attrs["data-tint"]).toBeUndefined();
      expect(all(root, (e) => "data-group-picture" in e.attrs)).toEqual([]);
    }
  });
});

describe("the tiles", () => {
  it("each of the four tiles draws its picture in its own colour, before its name", () => {
    for (const { name, html, isStaff } of RENDERS) {
      if (!isStaff) continue;
      const tiles = all(parse(html), (e) => e.tag === "button" && "data-tile" in e.attrs);
      expect(tiles.map((t) => t.attrs["data-tile"])).toEqual(GROUP_ORDER);
      for (const t of tiles) {
        const g = t.attrs["data-tile"] as Group;
        const pics = all(t, (e) => "data-group-picture" in e.attrs);
        expect(pics, `${name} ${g}`).toHaveLength(1);
        expect(pics[0].attrs["data-group-picture"]).toBe(g);
        expect(pics[0].attrs["data-tint"]).toBe(g);
        expect(classes(pics[0])).toEqual(expect.arrayContaining([GROUP_TINT[g].chip, GROUP_TINT[g].ink]));
      }
    }
  });
});

describe("the colour laws", () => {
  it("no tile colour is red, amber, orange, yellow, pink or the brand's", () => {
    for (const g of GROUP_ORDER) for (const c of Object.values(GROUP_TINT[g])) expect(c).not.toMatch(/red|amber|orange|yellow|pink|rose|brand/);
  });

  it("no picture is red or amber, no slate-400 anywhere in the box, and every picture is hidden from a screen reader", () => {
    for (const { name, html } of RENDERS) {
      const root = parse(html);
      // The one slate-400 the box draws is the ⋯ icon's, row-more-sheet.tsx's and app-wide (carried
      // from cn-v1161, not this release's): an icon on a 44px button, never words and never a picture.
      for (const el of elements(root)) {
        if (!classes(el).some((c) => /slate-400$/.test(c))) continue;
        expect(el.tag === "button" && /^(?:More for|Más)/.test(el.attrs["aria-label"] ?? ""), `${name} <${el.tag} class="${el.attrs.class}">`).toBe(true);
      }
      const pictures = all(root, (e) => "data-picture-slot" in e.attrs || "data-group-picture" in e.attrs);
      expect(pictures.length).toBeGreaterThan(0);
      for (const p of pictures) {
        expect(p.attrs["aria-hidden"], name).toBe("true");
        expect(p.attrs.role).toBeUndefined();
        for (const e of [p, ...elements(p)]) expect(classes(e).filter((c) => /(?:red|amber|orange|yellow|pink|rose)-\d/.test(c)), name).toEqual([]);
        for (const svg of all(p, (e) => e.tag === "svg")) expect(svg.attrs["aria-hidden"], name).toBe("true");
      }
    }
  });
});
