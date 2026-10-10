import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb } from "@/test/fake-supabase";
import { workOrderFromQuote } from "./work-order-from-quote";

/**
 * ONE WORK ORDER PER ESTIMATE, from either door. The builder is idempotent by read; 0388 makes the
 * database say it too, and the builder reads the refusal as "the other door won".
 */
const quotes = [{ id: "q-1", quote_number: "Q-0041", title: "Generator", job_id: "job-1", customer_id: "c-1", notes: null }];
const lines = [
  { quote_id: "q-1", org_id: "org-1", description: "Install transfer switch", quantity: 1, unit: "ea", sort_order: 0 },
  { quote_id: "q-1", org_id: "org-1", description: "14/2 romex", quantity: 2, unit: "roll", sort_order: 1 },
];

describe("workOrderFromQuote", () => {
  it("writes the crew's instruction sheet from the lines, no prices, and names the company on the service client", async () => {
    const db = fakeDb({ quotes, work_orders: [], quote_line_items: lines });
    const res = await workOrderFromQuote(db.sb, { quoteId: "q-1", userId: "author", orgId: "org-1" });
    expect(res).toEqual({ ok: true, id: "work_orders-1", jobId: "job-1" });
    expect(db.inserted.work_orders[0]).toMatchObject({
      org_id: "org-1",
      title: "Generator",
      description: "Scope from Q-0041:\n• 1 ea — Install transfer switch\n• 2 roll — 14/2 romex",
      job_id: "job-1",
      customer_id: "c-1",
      quote_id: "q-1",
      status: "draft",
      created_by: "author",
    });
    expect(db.inserted.work_orders[0].description).not.toMatch(/\$/);
  });

  it("opens the existing one instead of minting a second", async () => {
    const db = fakeDb({ quotes, work_orders: [{ id: "wo-old", quote_id: "q-1" }], quote_line_items: lines });
    expect(await workOrderFromQuote(db.sb, { quoteId: "q-1", userId: "u", orgId: null })).toEqual({ ok: true, id: "wo-old", jobId: "job-1" });
    expect(db.inserted).toEqual({});
  });

  it("two doors in the same second: the index's refusal (0388) opens the other door's work order", async () => {
    const db = fakeDb(
      { quotes, work_orders: [], quote_line_items: lines },
      {
        onInsert: (table) => {
          if (table !== "work_orders") return undefined;
          db.tables.work_orders.push({ id: "wo-winner", quote_id: "q-1" });
          return { code: "23505", message: 'duplicate key value violates unique constraint "work_orders_one_per_quote_uq"' };
        },
      },
    );
    expect(await workOrderFromQuote(db.sb, { quoteId: "q-1", userId: "u", orgId: null })).toEqual({ ok: true, id: "wo-winner", jobId: "job-1" });
  });

  it("0388 is the rule underneath: one unique partial index per table, twice-safe", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0388_one_paper_per_quote.sql"), "utf8");
    expect(sql).toMatch(/create unique index if not exists work_orders_one_per_quote_uq\s+on public\.work_orders \(quote_id\)\s+where quote_id is not null;/);
    expect(sql).toMatch(/create unique index if not exists material_lists_one_per_quote_uq\s+on public\.material_lists \(quote_id\)\s+where quote_id is not null;/);
  });
});
