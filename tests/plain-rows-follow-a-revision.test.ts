import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fakeDb, type Row } from "../src/test/fake-supabase";
import { planPlainRows, plainLineOf, plainRowHalf, readPriceBook, takeOffFromQuote, takeOffWords, type PlainRow } from "../src/lib/estimate/take-off-from-quote";
import { syncQuoteMaterials, unkeyedHalf } from "../src/lib/estimate/sync-job-materials";

/**
 * THE PLAIN ROWS FOLLOW A REVISION (Erik 2026-10-11: "yes"). When a revision adopts the original's list,
 * the original's own plain-line rows are the estimate's: an unbought one takes the revision's count or goes
 * when its line is gone; a bought one is kept and said; a row of the crew's is never touched. Everything the
 * take-off did is said. Names are stand-ins ("Bayberry"), never a customer's.
 */
const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const ORG = "org-1";
const BOOK = [
  { org_id: ORG, code: "W142", description: "14/2 romex", supplier: "Northline Supply", buy_price: 90, unit: "roll", archived: false, price_list_item_options: [] },
  { org_id: ORG, code: "STP", description: "Staples", supplier: "Northline Supply", buy_price: 4, unit: "box", archived: false, price_list_item_options: [] },
];
const line = (quote_id: string, id: string, description: string, quantity: number, sort_order = 0): Row => ({ id, quote_id, org_id: ORG, description, quantity, unit: "ea", unit_price: 10, sort_order, detail: null });
const row = (id: string, description: string, part_number: string | null, quantity: number, extra: Record<string, unknown> = {}): Row => ({
  id, list_id: "ml-orig", org_id: ORG, source_key: null, description, part_number, quantity, purchased: false, is_tool: false, sort_order: 0, ...extra,
});

/** A revision Q-0043 of Q-0041, accepted on the same job; the original's list ml-orig carries `rows`. */
function world(origLines: Row[], revLines: Row[], rows: Row[], opts: Parameters<typeof fakeDb>[1] = {}) {
  return fakeDb({
    quotes: [
      { id: "q-orig", quote_number: "Q-0041", job_id: "job-1", status: "superseded", org_id: ORG, revises_quote_id: null, title: "Generator", customer_id: null },
      { id: "q-rev", quote_number: "Q-0043", job_id: "job-1", status: "accepted", org_id: ORG, revises_quote_id: "q-orig", title: "Generator", customer_id: null },
    ],
    material_lists: [{ id: "ml-orig", job_id: "job-1", quote_id: "q-orig", org_id: ORG, created_at: "2026-10-01" }],
    material_list_items: rows,
    quote_line_items: [...origLines, ...revLines],
    price_list_items: BOOK,
    organizations: [{ id: ORG, settings: { default_markup_pct: 25 } }],
    customers: [],
  }, opts);
}
const REV = { quoteId: "q-rev", userId: "u-1", orgId: null };
const item = (db: ReturnType<typeof world>, id: string) => db.tables.material_list_items.find((r) => r.id === id);

describe("a revision's plain rows follow it — the original's own rows", () => {
  it("an unbought row takes the revision's count, and it is said by name", async () => {
    const db = world([line("q-orig", "o1", "Staples [STP]", 3)], [line("q-rev", "r1", "Staples [STP]", 6)], [row("s", "Staples", "STP", 3)]);
    const res = await takeOffFromQuote(db.sb, REV);
    expect(res).toMatchObject({ ok: true, id: "ml-orig", adopted: true, follow: { added: 0, carried: 0, recounted: ["Staples 3 → 6"], removed: [], kept: [], countsDiffer: [], failed: [] } });
    expect(item(db, "s")).toMatchObject({ quantity: 6, source_key: null });
    expect(db.inserted.material_list_items ?? []).toEqual([]);
    expect(takeOffWords(res)).toBe("The crew's list is this estimate's now: 1 re-counted (Staples 3 → 6).");
  });
  it("a bought row is never rewritten: it keeps its count and the difference is said", async () => {
    const db = world([line("q-orig", "o1", "Staples [STP]", 3)], [line("q-rev", "r1", "Staples [STP]", 6)], [row("s", "Staples", "STP", 3, { purchased: true })]);
    const res = await takeOffFromQuote(db.sb, REV);
    expect(res.follow).toMatchObject({ recounted: [], countsDiffer: [{ description: "Staples", shows: 3, estimate: 6 }] });
    expect(item(db, "s")).toMatchObject({ quantity: 3 });
    expect(takeOffWords(res)).toContain("Staples shows 3, the estimate says 6");
  });
  it("a row bought between the read and the write is his: the count is said, not written (the write is conditional and counted)", async () => {
    // The hook runs as the write is issued, before its filters are applied: the crew bought it meanwhile.
    const db: ReturnType<typeof world> = world([line("q-orig", "o1", "Staples [STP]", 3)], [line("q-rev", "r1", "Staples [STP]", 6)], [row("s", "Staples", "STP", 3)], {
      onUpdate: (table) => {
        if (table === "material_list_items") item(db, "s")!.purchased = true;
        return undefined;
      },
    });
    const res = await takeOffFromQuote(db.sb, REV);
    expect(res.follow).toMatchObject({ recounted: [], countsDiffer: [{ description: "Staples", shows: 3, estimate: 6 }] });
    expect(item(db, "s")).toMatchObject({ quantity: 3 });
  });
  it("a line the revision dropped: its unbought row goes, its bought row stays — each said", async () => {
    const db = world(
      [line("q-orig", "o1", "Staples [STP]", 3), line("q-orig", "o2", "14/2 romex [W142]", 2, 1), line("q-orig", "o3", "Wire nuts", 10, 2)],
      [line("q-rev", "r1", "Staples [STP]", 3)],
      [row("s", "Staples", "STP", 3), row("w", "14/2 romex", "W142", 2, { purchased: true }), row("n", "Wire nuts", null, 10)],
    );
    const res = await takeOffFromQuote(db.sb, REV);
    expect(res.follow).toMatchObject({ carried: 1, removed: ["Wire nuts"], kept: ["14/2 romex"], recounted: [], countsDiffer: [] });
    expect(item(db, "n")).toBeUndefined();
    expect(item(db, "w")).toMatchObject({ quantity: 2, purchased: true });
    expect(takeOffWords(res)).toBe("The crew's list is this estimate's now: 1 removed (Wire nuts) — not on this estimate · 1 kept (14/2 romex) — bought, a tool, or a count you typed, though not on this estimate.");
  });
  it("a row of the crew's — on no line of the original — is never the estimate's to re-count or remove; a line it matches only says the difference", async () => {
    const db = world(
      [line("q-orig", "o1", "Staples [STP]", 3)],
      [line("q-rev", "r1", "Staples [STP]", 6), line("q-rev", "r2", "Wire nuts", 10, 1)],
      [row("s", "Staples", "STP", 3), row("g", "Gloves", null, 1), row("n", "Wire nuts", null, 2)],
    );
    const res = await takeOffFromQuote(db.sb, REV);
    expect(res.follow).toMatchObject({ added: 0, recounted: ["Staples 3 → 6"], removed: [], kept: [], countsDiffer: [{ description: "Wire nuts", shows: 2, estimate: 10 }] });
    expect(item(db, "g")).toMatchObject({ quantity: 1 });
    expect(item(db, "n")).toMatchObject({ quantity: 2 }); // the crew's, matched by words: said, not rewritten
    expect(db.inserted.material_list_items ?? []).toEqual([]);
  });
  it("a re-worded line is a new line: the old unbought row goes and the new one is written after the crew's rows", async () => {
    const db = world([line("q-orig", "o1", "14/2 romex", 2)], [line("q-rev", "r1", "14/2 romex, 250 ft", 2)], [row("w", "14/2 romex", "W142", 2, { sort_order: 4 })]);
    const res = await takeOffFromQuote(db.sb, REV);
    expect(res.follow).toMatchObject({ added: 1, removed: ["14/2 romex"] });
    expect(item(db, "w")).toBeUndefined();
    expect(db.inserted.material_list_items.map((r) => [r.description, r.sort_order, r.source_key ?? null])).toEqual([["14/2 romex, 250 ft", 5, null]]);
  });
  it("the original's lines are read BEFORE anything is written: a failed read takes nothing off and adopts nothing", async () => {
    const db = world([line("q-orig", "o1", "Staples [STP]", 3)], [line("q-rev", "r1", "Staples [STP]", 6)], [row("s", "Staples", "STP", 3)]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken: any = {
      from: (t: string) => {
        if (t !== "quote_line_items") return db.sb.from(t);
        // the revision's own lines read fine; the original's read times out
        const real = db.sb.from(t);
        return {
          select: (cols: string) => {
            const q = real.select(cols);
            return { eq: (col: string, v: unknown) => (col === "quote_id" && v === "q-orig" ? { eq: () => Promise.resolve({ data: null, error: { message: "timeout" } }), then: (r: (x: unknown) => unknown) => r({ data: null, error: { message: "timeout" } }) } : q.eq(col, v)) };
          },
        };
      },
    };
    const res = await takeOffFromQuote(broken, REV);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("The estimate this revises could not be read");
    expect(db.tables.material_lists[0].quote_id).toBe("q-orig"); // not adopted
    expect(item(db, "s")).toMatchObject({ quantity: 3 });
    expect(db.inserted.material_list_items ?? []).toEqual([]);
  });
  it("the job's own visit list (no original behind it): a differing count is said, nothing is rewritten or removed", async () => {
    const db = fakeDb({
      quotes: [{ id: "q-1", quote_number: "Q-0041", job_id: "job-1", status: "accepted", org_id: ORG, revises_quote_id: null, title: "Generator", customer_id: null }],
      material_lists: [{ id: "ml-visit", job_id: "job-1", quote_id: null, org_id: ORG, created_at: "2026-10-01" }],
      material_list_items: [{ ...row("s", "Staples", "STP", 3), list_id: "ml-visit" }, { ...row("g", "Gloves", null, 1), list_id: "ml-visit" }],
      quote_line_items: [line("q-1", "l1", "Staples [STP]", 6)],
      price_list_items: BOOK,
      organizations: [{ id: ORG, settings: { default_markup_pct: 25 } }],
      customers: [],
    });
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res).toMatchObject({ ok: true, adopted: true, follow: { added: 0, recounted: [], removed: [], kept: [], countsDiffer: [{ description: "Staples", shows: 3, estimate: 6 }] } });
    expect(item(db, "s")).toMatchObject({ quantity: 3 });
    expect(item(db, "g")).toMatchObject({ quantity: 1 });
  });
  it("WRITE ORDER (the skeptic's HIGH): the new lines land first — when they cannot, nothing is re-counted or removed, the list stays this estimate's, and it is said with the way out", async () => {
    const db = world(
      [line("q-orig", "o1", "Staples [STP]", 3), line("q-orig", "o2", "Wire nuts", 10, 1)],
      [line("q-rev", "r1", "Staples [STP]", 6), line("q-rev", "r2", "Conduit", 4, 1)],
      [row("s", "Staples", "STP", 3), row("n", "Wire nuts", null, 10)],
      { onInsert: (table) => (table === "material_list_items" ? { message: "timeout" } : undefined) },
    );
    const res = await takeOffFromQuote(db.sb, REV);
    expect(res).toMatchObject({ ok: true, adopted: true, follow: { added: 0, recounted: [], removed: [], failed: ["1 line could not be added (timeout) — add them on the list; nothing else was changed"] } });
    expect(item(db, "s")).toMatchObject({ quantity: 3 }); // not re-counted
    expect(item(db, "n")).toBeDefined(); // not removed
    expect(db.tables.material_lists[0].quote_id).toBe("q-rev"); // the list is the estimate's: the next call opens it
    expect(takeOffWords(res)).toContain("1 line could not be added (timeout) — add them on the list; nothing else was changed");
  });
  it("a re-count that fails is said by name with the figure to set; the lines the revision dropped are still removed (the crew never has less than they need)", async () => {
    const db = world(
      [line("q-orig", "o1", "Staples [STP]", 3), line("q-orig", "o2", "Wire nuts", 10, 1)],
      [line("q-rev", "r1", "Staples [STP]", 6)],
      [row("s", "Staples", "STP", 3), row("n", "Wire nuts", null, 10)],
      { onUpdate: (table, patch) => (table === "material_list_items" && "quantity" in patch ? { message: "timeout" } : undefined) },
    );
    const res = await takeOffFromQuote(db.sb, REV);
    expect(res).toMatchObject({ ok: true, follow: { recounted: [], removed: ["Wire nuts"], failed: ["Staples could not be re-counted (timeout) — set it to 6 on the list"] } });
    expect(item(db, "n")).toBeUndefined();
  });
  it("a count someone TYPED over the estimate's row is his: said, never re-counted (the original's own count tells them apart)", async () => {
    const db = world([line("q-orig", "o1", "Staples [STP]", 3)], [line("q-rev", "r1", "Staples [STP]", 6)], [row("s", "Staples", "STP", 4)]); // 4: typed, the original said 3
    const res = await takeOffFromQuote(db.sb, REV);
    expect(res.follow).toMatchObject({ recounted: [], countsDiffer: [{ description: "Staples", shows: 4, estimate: 6 }] });
    expect(item(db, "s")).toMatchObject({ quantity: 4 });
  });
  it("a re-count carries the line's unit when it changed (2 roll → 500 ft), and the write is conditional on the count it read", async () => {
    const db = world([line("q-orig", "o1", "Conduit", 2)], [{ ...line("q-rev", "r1", "Conduit", 500), unit: "ft" }], [row("c", "Conduit", null, 2, { unit: "roll" })]);
    const res = await takeOffFromQuote(db.sb, REV);
    expect(res.follow).toMatchObject({ recounted: ["Conduit 2 → 500"] });
    expect(item(db, "c")).toMatchObject({ quantity: 500, unit: "ft" });
  });
  it("an untouched 'how many?' placeholder from the visit takes the count the estimate gives it, tail dropped, on the job's own list too", async () => {
    const db = fakeDb({
      quotes: [{ id: "q-1", quote_number: "Q-0041", job_id: "job-1", status: "accepted", org_id: ORG, revises_quote_id: null, title: "Generator", customer_id: null }],
      material_lists: [{ id: "ml-visit", job_id: "job-1", quote_id: null, org_id: ORG, created_at: "2026-10-01" }],
      material_list_items: [{ ...row("s", "Staples · how many?", "STP", 1), list_id: "ml-visit", unit: "ea" }],
      quote_line_items: [line("q-1", "l1", "Staples [STP]", 6)],
      price_list_items: BOOK,
      organizations: [{ id: ORG, settings: { default_markup_pct: 25 } }],
      customers: [],
    });
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res.follow).toMatchObject({ recounted: ["Staples 1 → 6"], countsDiffer: [] });
    expect(item(db, "s")).toMatchObject({ quantity: 6, description: "Staples" });
  });
  it("after the take-off, the sync leaves the followed rows alone (they are the estimate's plain rows, not hand rows)", async () => {
    const db = world([line("q-orig", "o1", "Staples [STP]", 3)], [line("q-rev", "r1", "Staples [STP]", 6)], [row("s", "Staples", "STP", 3)]);
    await takeOffFromQuote(db.sb, REV);
    const mats = await syncQuoteMaterials(db.sb, { quoteId: "q-rev", jobId: "job-1", orgId: null, userId: "u-1" });
    expect(mats).toMatchObject({ inserted: 0, rekeyed: 0, removed: 0, kept: 0 });
    expect(item(db, "s")).toMatchObject({ quantity: 6, source_key: null });
  });
});

describe("planPlainRows — the pure rule", () => {
  const L = (half: string, qty: number) => ({ half, qty, row: `${half}×${qty}` });
  const R = (id: string, half: string, quantity: number, his = false): PlainRow => ({ id, half, quantity, description: half, his });
  it("rows with the same words as a line: the line claims one (an equal count first), the estimate's identity is spent once, the rest are the crew's", () => {
    const plan = planPlainRows([L("A", 1)], [R("a", "A", 1), R("a2", "A", 7)], new Map([["A", [1]]]));
    expect(plan).toMatchObject({ carried: 1, insert: [], recount: [], remove: [], kept: [], countsDiffer: [] }); // a2 stays, the crew's
  });
  it("two lines of the original, one on the revision: the untouched row re-counted, the other removed; a bought one kept", () => {
    const plan = planPlainRows([L("A", 5)], [R("a", "A", 2), R("b", "B", 1), R("c", "C", 1, true)], new Map([["A", [2]], ["B", [1]], ["C", [1]]]));
    expect(plan.recount).toEqual([{ id: "a", description: "A", from: 2, to: 5 }]);
    expect(plan.remove.map((r) => r.id)).toEqual(["b"]);
    expect(plan.kept.map((r) => r.id)).toEqual(["c"]);
  });
  it("a count he TYPED over the estimate's row is his (the skeptic's case): said, never re-counted; kept when its line is gone", () => {
    // the original said A ×10; the row shows 4 — someone typed it. The revision says 12.
    const plan = planPlainRows([L("A", 12)], [R("a", "A", 4)], new Map([["A", [10]]]));
    expect(plan).toMatchObject({ recount: [], countsDiffer: [{ description: "A", shows: 4, estimate: 12 }] });
    const gone = planPlainRows([], [R("a", "A", 4)], new Map([["A", [10]]]));
    expect(gone).toMatchObject({ remove: [], kept: [expect.objectContaining({ id: "a" })] });
  });
  it("an untouched 'how many?' placeholder takes the count a line gives it, tail and all — whoever's row it is; a typed count on one does not", () => {
    const ph = { id: "p", half: "STP", quantity: 1, description: "Staples · how many?", his: false };
    expect(planPlainRows([L("STP", 6)], [ph]).recount).toEqual([{ id: "p", description: "Staples · how many?", from: 1, to: 6, words: "Staples" }]);
    expect(planPlainRows([L("STP", 6)], [{ ...ph, quantity: 3 }])).toMatchObject({ recount: [], countsDiffer: [{ shows: 3, estimate: 6 }] });
    expect(planPlainRows([L("STP", 1)], [ph])).toMatchObject({ recount: [], carried: 1 });
  });
  it("the unit follows a re-count when the line's differs (2 roll → 500 ft), never on a row left alone", () => {
    const plan = planPlainRows([{ half: "C", qty: 500, unit: "ft", row: "C×500" }], [{ id: "c", half: "C", quantity: 2, unit: "roll", description: "Conduit", his: false }], new Map([["C", [2]]]));
    expect(plan.recount).toEqual([{ id: "c", description: "Conduit", from: 2, to: 500, unit: "ft" }]);
  });
  it("without an original (the job's own list) nothing is the estimate's: a differing count is said, a row no line wants is left", () => {
    const plan = planPlainRows([L("A", 5)], [R("a", "A", 2), R("b", "B", 1)]);
    expect(plan).toMatchObject({ recount: [], remove: [], kept: [], countsDiffer: [{ description: "A", shows: 2, estimate: 5 }] });
  });
  it("a line nobody has is written; a bought row at another count is not rewritten even when it is the estimate's", () => {
    const plan = planPlainRows([L("A", 5), L("D", 1)], [R("a", "A", 2, true)], new Map([["A", [2]]]));
    expect(plan.insert).toEqual(["D×1"]);
    expect(plan.countsDiffer).toEqual([{ description: "A", shows: 2, estimate: 5 }]);
    expect(plan.recount).toEqual([]);
  });
});

describe("one reading of a plain line, shared by the take-off and the sync", () => {
  it("plainLineOf: the first [CODE], the words without it, the book's code when it knows the part; a task or labor line is none", async () => {
    const { sb } = world([], [], []);
    const { findPl } = await readPriceBook(sb, null);
    expect(plainLineOf({ description: "Staples [STP]", quantity: 3 }, findPl)).toMatchObject({ code: "STP", cleanDesc: "Staples", half: "STP", qty: 3 });
    expect(plainLineOf({ description: "14/2 romex", quantity: "2" }, findPl)).toMatchObject({ pl: expect.objectContaining({ code: "W142" }), half: "W142", qty: 2 });
    expect(plainLineOf({ description: "Wire nuts", quantity: null }, findPl)).toMatchObject({ pl: null, half: "wire-nuts", qty: 1 });
    expect(plainLineOf({ description: "Labor — rough-in", quantity: 4 }, findPl)).toBeNull();
    expect(plainLineOf({ description: "Trenching", quantity: 4, unit: "hr" }, findPl)).toBeNull();
    expect(plainLineOf({ description: "Install switch", quantity: 1, detail: { task_id: "t", hours: 1, rate: 100, units: null, kit_id: null, materials: [] } }, findPl)).toBeNull();
  });
  it("the row the take-off writes matches its line by the same half, and the sync reads a row the same way", () => {
    const r = { part_number: "STP", description: "Staples · how many?" };
    expect(plainRowHalf(r)).toBe("STP");
    expect(unkeyedHalf(r)).toBe(plainRowHalf(r));
    expect(plainRowHalf({ part_number: null, description: "Wire nuts" })).toBe("wire-nuts");
  });
  it("the sync's plain-row recognition goes through plainLineOf (no second reading)", () => {
    const sync = src("src/lib/estimate/sync-job-materials.ts");
    expect(sync).toContain("const p = plainLineOf(l, findPl);");
    expect(sync).not.toContain("const CODE_RE");
  });
});

describe("the doors say what the paperwork did", () => {
  it("Create Material List returns the take-off's words; both Accept branches keep the work order's and the list's results (a failure is a note, the list's words are said)", () => {
    const mats = src("src/app/(app)/materials/actions.ts");
    expect(mats).toContain("const said: string[] = [takeOffWords(res)]");
    const quotes = src("src/app/(app)/quotes/actions.ts");
    expect(quotes.match(/const wo = await createWorkOrderFromQuote\(quoteId\);\n\s*const list = await createMaterialListFromQuote\(quoteId\);/g)).toHaveLength(2);
    expect(quotes.match(/paperworkNote\(wo, list\)/g)).toHaveLength(2);
    expect(quotes).toContain("const said = [list.said, follow.said].filter(Boolean).join(\" \");");
  });
  it("takeOffWords is null when nothing was adopted or nothing changed", () => {
    expect(takeOffWords({})).toBeNull();
    expect(takeOffWords({ follow: { added: 0, carried: 3, recounted: [], removed: [], kept: [], countsDiffer: [], failed: [] } })).toBeNull();
  });
});
