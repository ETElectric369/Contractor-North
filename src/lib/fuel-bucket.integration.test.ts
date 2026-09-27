import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";

/**
 * Migration 0362: fuel is its own bucket, and Gas & Truck is Auto (2026-09-27), for every company.
 *
 * Run against the real database, inside ONE transaction that is always rolled back, on two
 * throwaway companies made here (named TEST 0362, every date 2001):
 *   · every stored "Gas & Truck" becomes "Auto", whatever its letter case, in every company: a
 *     business cost's bucket, a job bill's category, Add Business Cost's placeholder supplier, a
 *     recurring expense, a no-job petty cash row, a filed paper's category, and the tray's words in a
 *     paper's proposal (its bucket guess, its company-use word's bucket, its own pick, its kept
 *     category);
 *   · nothing else moves: amounts, dates, jobs, a real supplier whose name merely starts that way, a
 *     Fuel row, a job bill's supplier;
 *   · a second run finds nothing and writes nothing (not even updated_at).
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const M0362 = readFileSync(fileURLToPath(new URL("../../supabase/migrations/0362_fuel_is_its_own_bucket.sql", import.meta.url)), "utf8");

d("0362: fuel is its own bucket, and every company's Gas & Truck is Auto", () => {
  let c: pg.Client;
  const notices: string[] = [];
  let orgA = "";
  let orgB = "";
  const ids: Record<string, string> = {};

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const billOf = async (id: string) => one("select category, supplier, amount::text, bill_date::text, job_id from bills where id = $1", [id]);

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    c.on("notice", (n) => notices.push(String(n.message)));
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    orgA = (await one("insert into organizations (name) values ('TEST 0362 A') returning id")).id;
    orgB = (await one("insert into organizations (name) values ('TEST 0362 B') returning id")).id;
    const job = (await one("insert into jobs (org_id, job_number, name) values ($1, 'J-0362', 'TEST 0362 JOB') returning id", [orgA])).id;
    const bill = async (key: string, org: string, over: Record<string, unknown>) => {
      const row = { org_id: org, job_id: null, supplier: "TEST 0362 SUPPLIER", amount: 10, status: "paid", bill_date: "2001-01-02", category: "Gas & Truck", ...over };
      const cols = Object.keys(row);
      ids[key] = (await one(`insert into bills (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row))).id;
    };
    await bill("repair", orgA, { supplier: "TEST 0362 AUTO PARTS", amount: 88.2 });
    await bill("placeholder", orgA, { supplier: "Gas & Truck", amount: 64.1 });
    await bill("lower", orgB, { category: " gas & truck ", amount: 12.34 });
    await bill("onJob", orgA, { job_id: job, supplier: "Gas & Truck", amount: 7 });
    await bill("fuel", orgA, { category: "Fuel", amount: 50 });
    await bill("namesake", orgA, { supplier: "Gas & Trucking Co", category: "Other", amount: 3 });
    ids.template = (await one("insert into recurring_templates (org_id, kind, title, next_date, amount, category) values ($1, 'expense', 'TEST 0362 TRUCK PAYMENT', '2001-02-01', 500, 'Gas & Truck') returning id", [orgA])).id;
    ids.petty = (await one("insert into petty_cash (org_id, kind, amount, category, tx_date) values ($1, 'expense', 20, 'Gas & Truck', '2001-01-03') returning id", [orgB])).id;
    const proposal = {
      bucket: "Gas & Truck",
      companyUse: { bucket: "Gas & Truck", from: "po", words: "TRUCK" },
      filed: { how: "bill", paperPick: "cost:Gas & Truck", category: "Gas & Truck", picked: "paper" },
      why: "TEST 0362: other words stay",
    };
    ids.paper = (
      await one("insert into organized_items (org_id, title, status, category, proposal) values ($1, 'TEST 0362 paper', 'filed', 'Gas & Truck', $2::jsonb) returning id", [orgA, JSON.stringify(proposal)])
    ).id;
    ids.plainPaper = (
      await one("insert into organized_items (org_id, title, status, category, proposal) values ($1, 'TEST 0362 plain', 'filed', 'Receipt', $2::jsonb) returning id", [orgB, JSON.stringify({ bucket: "Fuel" })])
    ).id;
    notices.length = 0;
    await c.query(M0362);
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("renames every stored Gas & Truck to Auto, in every company", async () => {
    expect((await billOf(ids.repair)).category).toBe("Auto");
    expect((await billOf(ids.lower)).category).toBe("Auto"); // another company, lower case and spaces
    expect((await billOf(ids.onJob)).category).toBe("Auto");
    expect((await one("select category from recurring_templates where id = $1", [ids.template])).category).toBe("Auto");
    expect((await one("select category from petty_cash where id = $1", [ids.petty])).category).toBe("Auto");
    const paper = await one("select category, proposal from organized_items where id = $1", [ids.paper]);
    expect(paper.category).toBe("Auto");
    expect(paper.proposal).toEqual({
      bucket: "Auto",
      companyUse: { bucket: "Auto", from: "po", words: "TRUCK" },
      filed: { how: "bill", paperPick: "cost:Auto", category: "Auto", picked: "paper" },
      why: "TEST 0362: other words stay",
    });
    expect(notices.some((n) => /^0362: fuel is its own bucket/.test(n))).toBe(true);
  });

  it("renames Add Business Cost's placeholder supplier on a business cost, never a job bill's supplier", async () => {
    expect((await billOf(ids.placeholder)).supplier).toBe("Auto");
    expect((await billOf(ids.onJob)).supplier).toBe("Gas & Truck");
    expect((await billOf(ids.namesake)).supplier).toBe("Gas & Trucking Co");
  });

  it("moves no money: amounts, dates and jobs as they were; Fuel and every other word untouched", async () => {
    expect(await billOf(ids.repair)).toMatchObject({ amount: "88.20", bill_date: "2001-01-02", job_id: null });
    expect(await billOf(ids.placeholder)).toMatchObject({ amount: "64.10" });
    expect(await billOf(ids.lower)).toMatchObject({ amount: "12.34" });
    expect((await billOf(ids.onJob)).job_id).not.toBeNull();
    expect((await billOf(ids.fuel)).category).toBe("Fuel");
    expect((await billOf(ids.namesake)).category).toBe("Other");
    expect((await one("select category, proposal from organized_items where id = $1", [ids.plainPaper]))).toEqual({ category: "Receipt", proposal: { bucket: "Fuel" } });
    const sums = await one(
      "select coalesce(sum(amount), 0)::text as total, count(*)::int as n from bills where org_id = any($1::uuid[])",
      [[orgA, orgB]],
    );
    expect(sums).toEqual({ total: "224.64", n: 6 });
  });

  it("a second run finds nothing and writes nothing", async () => {
    // A row an UPDATE touches gets a new tuple (a new ctid), even inside this one transaction.
    const where = async () => (await c.query("select ctid::text from bills where org_id = any($1::uuid[]) order by id", [[orgA, orgB]])).rows.map((r) => r.ctid);
    const before = await where();
    notices.length = 0;
    await c.query(M0362);
    expect(notices.find((n) => n.startsWith("0362: Gas & Truck is Auto now"))).toBe(
      "0362: Gas & Truck is Auto now: 0 bills (0 with the bucket as their supplier), 0 recurring expenses, 0 petty cash rows, 0 papers and 0 words in paper proposals renamed.",
    );
    expect(await where()).toEqual(before);
  });
});
