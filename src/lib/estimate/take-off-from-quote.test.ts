import { describe, it, expect } from "vitest";
import { HOW_MANY, takeOffFromQuote } from "./take-off-from-quote";

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

  it("an off-book plain line still backs the markup out of the estimate price (unchanged)", async () => {
    const { sb, inserted } = world([{ id: "l9", quote_id: "q-1", org_id: ORG, description: "Mystery bracket", quantity: 1, unit: "ea", unit_price: 125, sort_order: 0, detail: null }]);
    await takeOffFromQuote(sb, { quoteId: "q-1", userId: "u-1", orgId: null });
    expect(inserted.material_list_items[0]).toMatchObject({ description: "Mystery bracket", part_number: null, est_cost: 100 });
  });
});
