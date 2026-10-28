import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HOW_MANY, isClaimableKey, takeOffFromQuote } from "./take-off-from-quote";

/**
 * THE LAW UNDER TEST: a task line never becomes a material on the crew's list; its parts do, by
 * code, at the book's unit and vendor and the cost the line was built with. A plain line and a
 * labor line are treated exactly as before. The live defect since cn-v1074 — "Install transfer
 * switch" landing on the order sheet as a $X part while its real parts never arrived — is the first
 * case here.
 *
 * The database is src/test/fake-supabase (a thenable builder over rows, recording inserts).
 */

import { fakeDb, type Row } from "@/test/fake-supabase";

const ORG = "org-1";
const BOOK = [
  { org_id: ORG, code: "R1", description: "Transfer switch, 200A", supplier: "Northline Supply", buy_price: 400, unit: "ea", archived: false, price_list_item_options: [] },
  { org_id: ORG, code: "W142", description: "14/2 romex", supplier: "Northline Supply", buy_price: 90, unit: "roll", archived: false, price_list_item_options: [] },
  { org_id: ORG, code: "BRK50", description: "50A breaker", supplier: "Northline Supply", buy_price: 25, unit: "ea", archived: false, price_list_item_options: [] },
  // another company's book, same code, another vendor — must never be read for ORG
  { org_id: "org-2", code: "R1", description: "Transfer switch, 200A", supplier: "Elsewhere Electric", buy_price: 1, unit: "box", archived: false, price_list_item_options: [] },
];

const taskLine = (id: string, description: string, sort_order: number, hours: number | null, materials: unknown[]) => ({
  id,
  quote_id: "q-1", org_id: ORG,
  description,
  quantity: 1,
  unit: "ea",
  unit_price: 999, // the task's SELL — must never be backed out onto the sheet
  sort_order,
  detail: { task_id: `t-${id}`, hours, rate: 120, units: null, kit_id: null, materials },
});

/** The world as a USER client sees it (RLS shows one company's book) unless `everyOrg` says the
 *  client is the service role, which sees every company's rows and must scope them itself. */
function world(lines: Row[], opts: { settings?: Row; everyOrg?: boolean } = {}) {
  return fakeDb({
    quotes: [{ id: "q-1", quote_number: "Q-0041", job_id: "job-1", title: "Generator", customer_id: null, org_id: ORG }],
    material_lists: [],
    quote_line_items: lines,
    price_list_items: opts.everyOrg ? BOOK : BOOK.filter((b) => b.org_id === ORG),
    organizations: [{ id: ORG, settings: opts.settings ?? { default_markup_pct: 25 } }, { id: "org-2", settings: { default_markup_pct: 90 } }],
    customers: [],
  });
}

describe("takeOffFromQuote — the job's own list is the list (cn-v1084)", () => {
  const lines = [
    { id: "l1", quote_id: "q-1", org_id: ORG, description: "14/2 romex [W142]", quantity: 2, unit: "roll", unit_price: 125, sort_order: 0, detail: null },
    taskLine("l2", "Install transfer switch", 1, 3, [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 500 }]),
  ];
  const accepted = (db: ReturnType<typeof world>) => {
    db.tables.quotes[0].status = "accepted";
    return db;
  };
  it("an ACCEPTED estimate adopts the job's canonical list when no estimate holds it (compare-and-set on quote_id null), seeds its plain lines after the crew's rows — skipping what the list already carries by code or words — and leaves the task parts to the sync", async () => {
    const db = accepted(world(lines));
    db.tables.material_lists.push({ id: "ml-visit", job_id: "job-1", quote_id: null, org_id: ORG, created_at: "2026-10-01" });
    db.tables.material_list_items = [
      { id: "v1", list_id: "ml-visit", org_id: ORG, source_key: "task:t-l2#R1", description: "Transfer switch, 200A", part_number: "R1", quantity: 1, sort_order: 0 },
      { id: "typed", list_id: "ml-visit", org_id: ORG, source_key: null, description: "14/2 romex", part_number: "W142", quantity: 2, sort_order: 1 }, // the visit's typed item, back as a plain line
    ];
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res).toMatchObject({ ok: true, id: "ml-visit", jobId: "job-1", adopted: true, follow: { added: 0, carried: 1, recounted: [], removed: [], kept: [], countsDiffer: [] } });
    expect(db.inserted.material_lists).toBeUndefined();
    expect(db.tables.material_lists[0].quote_id).toBe("q-1");
    expect(db.inserted.material_list_items ?? []).toEqual([]); // the romex is there already; the task's R1 is the sync's to add
  });
  it("a typed row under its 'capture:' key (cn-v1134, addCaptureItemsToJobList) is UNKEYED to the adoption: the plain line claims it, nothing is written twice", async () => {
    const db = accepted(world(lines));
    db.tables.material_lists.push({ id: "ml-visit", job_id: "job-1", quote_id: null, org_id: ORG, created_at: "2026-10-01" });
    db.tables.material_list_items = [
      { id: "typed", list_id: "ml-visit", org_id: ORG, source_key: "capture:c-romex", description: "14/2 romex", part_number: "W142", quantity: 2, sort_order: 0 },
    ];
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res).toMatchObject({ ok: true, id: "ml-visit", adopted: true, follow: { added: 0, carried: 1, recounted: [], removed: [], kept: [], countsDiffer: [] } });
    expect(db.inserted.material_list_items ?? []).toEqual([]);
    expect(isClaimableKey("capture:c-romex")).toBe(true);
    expect(isClaimableKey(null)).toBe(true);
    expect(isClaimableKey("line:l1#W142")).toBe(false);
    expect(isClaimableKey("task:t1#W142")).toBe(false);
  });
  it("seeds a plain line the adopted list does NOT carry, after the crew's last row", async () => {
    const db = accepted(world(lines));
    db.tables.material_lists.push({ id: "ml-visit", job_id: "job-1", quote_id: null, org_id: ORG, created_at: "2026-10-01" });
    db.tables.material_list_items = [{ id: "v1", list_id: "ml-visit", org_id: ORG, source_key: "task:t-l2#R1", description: "Transfer switch, 200A", part_number: "R1", quantity: 1, sort_order: 4 }];
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res).toMatchObject({ ok: true, adopted: true, follow: { added: 1, carried: 0 } });
    expect(db.inserted.material_list_items.map((r) => [r.description, r.sort_order, r.source_key ?? null])).toEqual([["14/2 romex", 5, null]]);
  });
  it("a REVISION (0391) adopts the list of the estimate it revises — compare-and-set on that estimate's id — and leaves the task parts to the sync", async () => {
    const db = accepted(world(lines));
    db.tables.quotes[0].revises_quote_id = "q-orig";
    db.tables.material_lists.push({ id: "ml-orig", job_id: "job-1", quote_id: "q-orig", org_id: ORG, created_at: "2026-10-01" });
    db.tables.material_list_items = [{ id: "o1", list_id: "ml-orig", org_id: ORG, source_key: "line:oldline#R1", description: "Transfer switch, 200A", part_number: "R1", quantity: 1, purchased: true, sort_order: 0 }];
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res).toMatchObject({ ok: true, id: "ml-orig", adopted: true });
    expect(db.inserted.material_lists).toBeUndefined();
    expect(db.tables.material_lists[0].quote_id).toBe("q-1");
    expect(db.inserted.material_list_items.map((r) => r.description)).toEqual(["14/2 romex"]); // the plain line; the R1 is the sync's to re-key
  });
  it("a catalog org's kit groups are not seeded again onto an adopted list (the crew's bought marks are on them)", () => {
    const takeOff = fs.readFileSync(path.join(process.cwd(), "src/lib/estimate/take-off-from-quote.ts"), "utf8");
    expect(takeOff).toContain('if (settings.estimating_mode === "catalog" && !adoptedFromOriginal) {'); // a job-own (visit) list never had them: seeded
  });
  it("a catalog org's buy list takes the material kits by RULE: a kit filed under Estimate (the scope kit the estimate was priced from) is never a buy-list group; the rest are (cn-v1135)", async () => {
    const db = world([{ id: "l1", quote_id: "q-1", org_id: ORG, description: "14/2 romex [W142]", quantity: 2, unit: "roll", unit_price: 125, sort_order: 0, detail: null }], {
      settings: { default_markup_pct: 25, estimating_mode: "catalog" },
    });
    db.tables.kits = [
      // Filed under Estimate in either spelling: the whole-job scope kits, never seeded.
      { id: "k-scope", org_id: ORG, name: "Decks", category: "Estimate", labor_minutes: null, kit_items: [{ id: "i1", description: "Whole deck, per sq ft", quantity: 1, unit: "sqft", unit_price: 40, sort_order: 0 }] },
      { id: "k-scope-2", org_id: ORG, name: "Remodels", category: "estimates", labor_minutes: null, kit_items: [{ id: "i2", description: "Remodel allowance", quantity: 1, unit: "ea", unit_price: 500, sort_order: 0 }] },
      // A material kit under its own scope word: the crew's buy-list group.
      { id: "k-frame", org_id: ORG, name: "Framing", category: "Deck", labor_minutes: null, kit_items: [{ id: "i3", description: "Joist hanger", quantity: 10, unit: "ea", unit_price: 2, sort_order: 0 }] },
      // A TASK kit (hours per unit) prices a task line and is never a buy-list group (partsKitsOnly), as before.
      { id: "k-task", org_id: ORG, name: "Set a post", category: "Deck", labor_minutes: 60, kit_items: [{ id: "i4", description: "Post base", quantity: 1, unit: "ea", unit_price: 15, sort_order: 0 }] },
    ];
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res.ok).toBe(true);
    expect(db.inserted.material_list_items.map((r) => r.description)).toEqual(["14/2 romex", "Framing — Joist hanger"]);
    const takeOff = fs.readFileSync(path.join(process.cwd(), "src/lib/estimate/take-off-from-quote.ts"), "utf8");
    expect(takeOff).not.toContain("Decks"); // no company's kit NAMES in the rule
    expect(takeOff).toContain('!sameScope(k.category, "Estimate")');
    expect(takeOff).toContain('taskKitSelectRungs("category")');
  });
  it("the catalog picker on /quotes/new offers the Estimate-scope kits through partsKitsOnly first, so a task kit filed under Estimate never drops in and loses its hours (S6)", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/quotes/new/page.tsx"), "utf8");
    expect(page).toContain('partsKitsOnly(kits ?? []).filter((k: any) => sameScope(k.category, "Estimate"))');
    // Never the bare read at the ternary's branch: that was the picker that let a task kit in.
    expect(page).not.toMatch(/\?\s*\(kits \?\? \[\]\)\.filter/);
  });
  it("a DRAFT or sent estimate never adopts (nothing would add its parts): a fresh list, as before", async () => {
    const db = world(lines); // status undefined: not accepted
    db.tables.material_lists.push({ id: "ml-visit", job_id: "job-1", quote_id: null, org_id: ORG, created_at: "2026-10-01" });
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res.ok).toBe(true);
    expect(res.adopted).toBeUndefined();
    expect(db.inserted.material_lists).toHaveLength(1);
    expect(db.tables.material_lists.find((l) => l.id === "ml-visit")?.quote_id).toBe(null);
  });
  it("a job whose canonical list is another estimate's gets a fresh list, as before (one list per estimate, 0388)", async () => {
    const db = accepted(world(lines));
    db.tables.material_lists.push({ id: "ml-other", job_id: "job-1", quote_id: "q-other", org_id: ORG, created_at: "2026-10-01" });
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res.ok).toBe(true);
    expect(res.adopted).toBeUndefined();
    expect(db.inserted.material_lists).toHaveLength(1);
    expect(db.inserted.material_list_items.map((r) => r.description)).toEqual(["14/2 romex", "Transfer switch, 200A"]);
  });
});

describe("takeOffFromQuote — a task line puts its PARTS on the sheet, never itself", () => {
  const lines = [
    { id: "l1", quote_id: "q-1", org_id: ORG, description: "14/2 romex [W142]", quantity: 2, unit: "roll", unit_price: 125, sort_order: 0, detail: null },
    taskLine("l2", "Install transfer switch", 1, 3, [
      { code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 500 },
      { code: null, name: "Bayberry clips", qty: null, cost: null, sell: null },
      { code: "BRK50", name: "50A breaker", qty: 2, cost: null, sell: null }, // the line didn't price it: the book does
    ]),
    { id: "l3", quote_id: "q-1", org_id: ORG, description: "Labor — rough-in", quantity: 4, unit: "hr", unit_price: 120, sort_order: 2, detail: null },
    taskLine("l4", "Pull the permit", 3, 1, []), // labor only: nothing to buy
  ];

  it("the task line itself is NOT a row; each named part is, by code, at the book's unit and vendor", async () => {
    const { sb, inserted } = world(lines);
    const res = await takeOffFromQuote(sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res.ok).toBe(true);
    const rows = inserted.material_list_items;
    expect(rows.map((r) => r.description)).toEqual(["14/2 romex", "Transfer switch, 200A", `Bayberry clips${HOW_MANY}`, "50A breaker"]);
    expect(rows.some((r) => /Install transfer switch|Pull the permit|Labor/.test(r.description))).toBe(false);
    // never the task's sell backed out of the markup (999 ÷ 1.25) anywhere on the sheet
    expect(rows.some((r) => r.est_cost === 799.2)).toBe(false);
    const sw = rows[1];
    expect(sw).toMatchObject({ part_number: "R1", quantity: 1, unit: "ea", vendor: "Northline Supply", est_cost: 400 });
    const clips = rows[2];
    expect(clips).toMatchObject({ part_number: null, quantity: 1, unit: "ea", vendor: null, est_cost: null });
    const brk = rows[3];
    expect(brk).toMatchObject({ part_number: "BRK50", quantity: 2, unit: "ea", vendor: "Northline Supply", est_cost: 25 });
    // 0390: a task line's part remembers its line and part; a plain line's row does not (it is not the estimate's to follow).
    expect(sw.source_key).toBe("line:l2#R1");
    expect(clips.source_key).toBe("line:l2#bayberry-clips");
    expect(brk.source_key).toBe("line:l2#BRK50");
    expect(rows[0].source_key).toBeUndefined();
  });

  it("THIS MANY OF THE TASK (cn-v1133): a task line at qty 2 puts twice each counted part on the sheet; an uncounted part stays the 'how many?' placeholder at 1", async () => {
    const { sb, inserted } = world([{ ...lines[1], quantity: 2 }]);
    const res = await takeOffFromQuote(sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res.ok).toBe(true);
    const rows = inserted.material_list_items;
    expect(rows.map((r) => [r.description, r.quantity, r.source_key])).toEqual([
      ["Transfer switch, 200A", 2, "line:l2#R1"],
      [`Bayberry clips${HOW_MANY}`, 1, "line:l2#bayberry-clips"],
      ["50A breaker", 4, "line:l2#BRK50"],
    ]);
    // The cost is the part's unit buy, never multiplied: the sheet counts, the price is each.
    expect(rows[0].est_cost).toBe(400);
  });

  it("plain lines are treated exactly as before: the [CODE] matched to the book, labor dropped", async () => {
    const { sb, inserted } = world(lines);
    await takeOffFromQuote(sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(inserted.material_list_items[0]).toMatchObject({ description: "14/2 romex", part_number: "W142", quantity: 2, unit: "roll", vendor: "Northline Supply", est_cost: 90 });
  });

  it("rows are numbered in sheet order, and the list carries the quote, the job and who made it", async () => {
    const { sb, inserted } = world(lines);
    await takeOffFromQuote(sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(inserted.material_list_items.map((r) => r.sort_order)).toEqual([0, 1, 2, 3]);
    expect(inserted.material_lists[0]).toMatchObject({ name: "Materials — Q-0041", job_id: "job-1", quote_id: "q-1", created_by: "u-1" });
    expect("org_id" in inserted.material_lists[0]).toBe(false); // a user client: the trigger stamps it
  });

  it("on the service client the company is named on every write and scopes the book and the settings", async () => {
    const { sb, inserted } = world(lines, { everyOrg: true });
    const res = await takeOffFromQuote(sb, { quoteId: "q-1", userId: "author-1", orgId: ORG });
    expect(res.ok).toBe(true);
    expect(inserted.material_lists[0]).toMatchObject({ org_id: ORG, created_by: "author-1" });
    for (const r of inserted.material_list_items) expect(r.org_id).toBe(ORG);
    // the other company's R1 ("Elsewhere Electric", by the box) was never read
    expect(inserted.material_list_items[1]).toMatchObject({ vendor: "Northline Supply", unit: "ea", est_cost: 400 });
  });

  it("one list per quote: a second run opens the existing one and writes nothing", async () => {
    const db = fakeDb({
      quotes: [{ id: "q-1", quote_number: "Q-0041", job_id: "job-1", title: "", customer_id: null }],
      material_lists: [{ id: "ml-existing", quote_id: "q-1" }],
      quote_line_items: lines,
      price_list_items: BOOK,
      organizations: [{ id: ORG, settings: {} }],
      customers: [],
    });
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res).toEqual({ ok: true, id: "ml-existing", jobId: "job-1" });
    expect(db.inserted).toEqual({});
  });

  it("a task named like labor, or sold by the hour, is still a task: its parts land, it does not", async () => {
    const { sb, inserted } = world([
      { ...taskLine("l5", "Labor to relocate the meter", 0, 2, [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 500 }]), unit: "hr" },
    ]);
    const res = await takeOffFromQuote(sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res.ok).toBe(true);
    expect(inserted.material_list_items.map((r) => r.description)).toEqual(["Transfer switch, 200A"]);
  });

  it("two doors in the same second: the index's refusal (0388) opens the other door's list", async () => {
    const db = fakeDb(
      {
        quotes: [{ id: "q-1", quote_number: "Q-0041", job_id: "job-1", title: "", customer_id: null }],
        material_lists: [],
        quote_line_items: lines,
        price_list_items: BOOK.filter((b) => b.org_id === ORG),
        organizations: [{ id: ORG, settings: {} }],
        customers: [],
      },
      {
        onInsert: (table) => {
          if (table !== "material_lists") return undefined;
          db.tables.material_lists.push({ id: "ml-winner", quote_id: "q-1" });
          return { code: "23505", message: 'duplicate key value violates unique constraint "material_lists_one_per_quote_uq"' };
        },
      },
    );
    const res = await takeOffFromQuote(db.sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(res).toEqual({ ok: true, id: "ml-winner", jobId: "job-1" });
    expect(db.inserted.material_list_items).toBeUndefined(); // nothing written onto the other door's list
  });

  it("an off-book plain line still backs the markup out of the estimate price (unchanged)", async () => {
    const { sb, inserted } = world([{ id: "l9", quote_id: "q-1", org_id: ORG, description: "Mystery bracket", quantity: 1, unit: "ea", unit_price: 125, sort_order: 0, detail: null }]);
    await takeOffFromQuote(sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(inserted.material_list_items[0]).toMatchObject({ description: "Mystery bracket", part_number: null, est_cost: 100 });
  });
});
