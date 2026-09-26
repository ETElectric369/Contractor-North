import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase } from "@/lib/db-guard";

/**
 * Migration 0349: a job that changes retires its bills' stored PDFs (audit v1018 links-docs-1).
 *
 * The customer's Download PDF (share-pdf) serves a stored copy only while its doc_status stamp
 * equals the invoice's status. Pinned against the real database, inside ONE transaction that is
 * always rolled back, on a TEST company minted inside it:
 *   · an hour clocked, edited or removed on the job un-stamps its DRAW invoices' copies (the ones
 *     whose Progress Summary counts those hours), never a standard invoice's;
 *   · an edit that changes nothing the bill reads (a note) leaves the stamp alone;
 *   · a piece taken from stock, and its undo, un-stamp the draws;
 *   · a job's site or billing model un-stamps EVERY invoice on the job; its notes do not;
 *   · another job's copies are never touched;
 *   · the rest of what the Progress Summary reads un-stamps the draws too: a line or a payment on a
 *     sibling bill (never the bill's own copy on its own payment), a quote, a receipt line, and the
 *     rates (a pricing level or a person's bill rate: every draw in the org; a customer's level:
 *     that customer's jobs);
 *   · a failing un-stamp never costs the write (0207): the hour still lands, with a warning.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file> --no-file-parallelism
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("0349: a changed job retires its bills' stored PDFs", () => {
  let c: pg.Client;
  let waiting = false;
  let org = "";
  let tech = "";
  let job = "";
  let otherJob = "";
  let draw = "";
  let standard = "";
  let otherDraw = "";
  let cust = "";
  const warnings: string[] = [];

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const ready = () => {
    if (waiting) console.warn("[job-pdf-unstamp] 0349 is not on this database yet; apply it with scripts/test-db/rebuild.cjs.");
    return !waiting;
  };
  /** Every stored copy, stamped as a sent bill's is. */
  const stampAll = async () => {
    for (const id of [draw, standard, otherDraw]) {
      await c.query(
        `insert into public.doc_pdf_cache (doc, doc_id, margin, fingerprint, path, doc_status, org_id)
         values ('invoice', $1, 0.75, 'fp', $2, 'sent', $3)
         on conflict (doc, doc_id, margin) do update set doc_status = 'sent'`,
        [id, `${org}/invoice/${id}/m0.75.pdf`, org],
      );
    }
  };
  /** Which of the three copies the customer door would still serve. */
  const served = async () => {
    const rows = (
      await c.query("select doc_id::text as id from public.doc_pdf_cache where doc = 'invoice' and doc_id = any($1::uuid[]) and doc_status = 'sent'", [
        [draw, standard, otherDraw],
      ])
    ).rows as { id: string }[];
    const ids = new Set(rows.map((r) => r.id));
    return { draw: ids.has(draw), standard: ids.has(standard), otherDraw: ids.has(otherDraw) };
  };
  const ALL = { draw: true, standard: true, otherDraw: true };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    c.on("notice", (n) => warnings.push(String(n.message)));
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const has = await one("select to_regprocedure('public.unstamp_job_invoice_pdfs()') is not null as yes");
    if (!has.yes) {
      waiting = true;
      return;
    }
    const minted = await mintThrowawayOrg(c, { label: "0349", techs: 1 });
    org = minted.orgId;
    tech = minted.techs[0].id;
    cust = (await one("insert into public.customers (org_id, name) values ($1, 'TEST 0349 cust') returning id", [org])).id;
    const newJob = async (n: string) =>
      (
        await one(
          `insert into public.jobs (org_id, name, job_number, status, billing_type, customer_id, address, city, state, zip)
           values ($1, $2, $2, 'in_progress', 'tm', $3, '235 Timbercreek Ct', 'Reno', 'NV', '89511') returning id`,
          [org, `TEST-0349-${n}`, cust],
        )
      ).id as string;
    job = await newJob("A");
    otherJob = await newJob("B");
    const invoice = async (j: string, number: string, kind: string) =>
      (
        await one(
          `insert into public.invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, subtotal, total)
           values ($1, $2, $3, $4, 'sent', $5, 0, 0) returning id`,
          [org, cust, j, number, kind],
        )
      ).id as string;
    draw = await invoice(job, "TEST-0349-1", "progress");
    standard = await invoice(job, "TEST-0349-2", "standard");
    otherDraw = await invoice(otherJob, "TEST-0349-3", "final");
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("an hour clocked on the job un-stamps its draw's copy, never the standard bill's or another job's", async () => {
    if (!ready()) return;
    await stampAll();
    expect(await served()).toEqual(ALL);
    await c.query(
      `insert into public.time_entries (org_id, profile_id, job_id, clock_in, clock_out, status)
       values ($1, $2, $3, '2001-08-20T15:00:00Z', '2001-08-20T19:00:00Z', 'closed')`,
      [org, tech, job],
    );
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: true });
  });

  it("an edit to the hours un-stamps; a note on the shift does not", async () => {
    if (!ready()) return;
    const entry = (await one("select id from public.time_entries where job_id = $1 and org_id = $2 limit 1", [job, org])).id;
    await stampAll();
    await c.query("update public.time_entries set notes = 'TEST pulled wire' where id = $1", [entry]);
    expect(await served()).toEqual(ALL);
    await c.query("update public.time_entries set clock_out = '2001-08-20T20:00:00Z' where id = $1", [entry]);
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: true });
  });

  it("an hour moved to another job un-stamps both jobs' draws", async () => {
    if (!ready()) return;
    const entry = (await one("select id from public.time_entries where job_id = $1 and org_id = $2 limit 1", [job, org])).id;
    await stampAll();
    await c.query("update public.time_entries set job_id = $2 where id = $1", [entry, otherJob]);
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: false });
  });

  it("an hour removed un-stamps its job's draw", async () => {
    if (!ready()) return;
    const entry = (await one("select id from public.time_entries where job_id = $1 and org_id = $2 limit 1", [otherJob, org])).id;
    await stampAll();
    await c.query("delete from public.time_entries where id = $1", [entry]);
    expect(await served()).toEqual({ draw: true, standard: true, otherDraw: false });
  });

  it("a piece taken from stock, and its undo, un-stamp the job's draw", async () => {
    if (!ready()) return;
    const item = (await one("insert into public.inventory_items (org_id, name, unit) values ($1, 'TEST 0349 12/2 NM-B', 'ft') returning id", [org])).id;
    await stampAll();
    // Taken past the shelf (a short: no roll behind it yet), as the server.
    const move = (
      await one(
        "insert into public.stock_moves (org_id, item_id, job_id, kind, qty, source, draw_group) values ($1, $2, $3, 'short', 20, 'office', gen_random_uuid()) returning id",
        [org, item, job],
      )
    ).id;
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: true });
    await stampAll();
    await c.query("update public.stock_moves set undone_at = now() where id = $1", [move]);
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: true });
  });

  it("the job's site or billing model un-stamps every bill on the job; its notes do not", async () => {
    if (!ready()) return;
    await stampAll();
    await c.query("update public.jobs set notes = 'TEST gate code 1234' where id = $1", [job]);
    expect(await served()).toEqual(ALL);
    await c.query("update public.jobs set address = '237 Timbercreek Ct' where id = $1", [job]);
    expect(await served()).toEqual({ draw: false, standard: false, otherDraw: true });
    await stampAll();
    await c.query("update public.jobs set billing_type = 'fixed' where id = $1", [job]);
    expect(await served()).toEqual({ draw: false, standard: false, otherDraw: true });
  });

  it("a line on a sibling bill un-stamps the job's draw; a payment on it too, never the bill's own copy", async () => {
    if (!ready()) return;
    await stampAll();
    const line = (
      await one(
        "insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price) values ($1, $2, 'TEST 0349 labor', 2, 125) returning id",
        [org, standard],
      )
    ).id;
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: true });
    await stampAll();
    await c.query("update public.invoice_items set unit_price = 150 where id = $1", [line]);
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: true });
    await stampAll();
    await c.query("update public.invoices set amount_paid = 100 where id = $1", [standard]);
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: true });
    // The draw's own payment is recalcInvoice's to bust (its own lines and payments), not this rule's.
    await stampAll();
    await c.query("update public.invoices set amount_paid = 50 where id = $1", [draw]);
    expect(await served()).toEqual(ALL);
  });

  it("a quote and a receipt line on the job un-stamp its draw", async () => {
    if (!ready()) return;
    await stampAll();
    await c.query(
      "insert into public.quotes (org_id, customer_id, job_id, quote_number, status, total) values ($1, $2, $3, 'TEST-0349-Q', 'accepted', 5000)",
      [org, cust, job],
    );
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: true });
    const bill = (await one("insert into public.bills (org_id, job_id, supplier, amount) values ($1, $2, 'TEST supply', 40) returning id", [org, job])).id;
    const bl = (await one("insert into public.bill_line_items (org_id, bill_id, description, quantity, amount) values ($1, $2, 'TEST wire', 1, 40) returning id", [org, bill])).id;
    await stampAll();
    await c.query("update public.bill_line_items set billable = false where id = $1", [bl]);
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: true });
  });

  it("a rate un-stamps the draws it prices: a level or a bill rate every draw in the org, a customer's level its jobs'", async () => {
    if (!ready()) return;
    const level = (await one("insert into public.pricing_levels (org_id, name, labor_rate, markup_pct) values ($1, 'TEST 0349 level', 110, 20) returning id", [org])).id;
    await stampAll();
    await c.query("update public.customers set pricing_level_id = $2 where id = $1", [cust, level]);
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: false });
    await stampAll();
    await c.query("update public.pricing_levels set labor_rate = 125 where id = $1", [level]);
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: false });
    await stampAll();
    await c.query("update public.pricing_levels set name = 'TEST 0349 level renamed' where id = $1", [level]);
    expect(await served()).toEqual(ALL);
    await c.query("update public.profiles set bill_rate = 95 where id = $1", [tech]);
    expect(await served()).toEqual({ draw: false, standard: true, otherDraw: false });
  });

  it("a failing un-stamp never costs the write: the hour lands, with a warning", async () => {
    if (!ready()) return;
    await stampAll();
    await c.query("savepoint broken_cache");
    try {
      // Make the un-stamp itself fail: a copy may not be un-stamped at all. The constraint waits for
      // any other suite's open transaction that wrote a bill, a quote or an hour (each one touches
      // doc_pdf_cache through these triggers), so it gets longer than 3s; the savepoint's rollback
      // puts the 3s back.
      await c.query("set local lock_timeout = '20s'");
      await c.query("alter table public.doc_pdf_cache add constraint test_0349_never_unstamped check (doc_status <> '') not valid");
      warnings.length = 0;
      const e = await one(
        `insert into public.time_entries (org_id, profile_id, job_id, clock_in, clock_out, status)
         values ($1, $2, $3, '2001-08-21T15:00:00Z', '2001-08-21T19:00:00Z', 'closed') returning id`,
        [org, tech, job],
      );
      expect(e.id).toBeTruthy();
      expect(warnings.some((w) => w.includes("0349 unstamp_job_invoice_pdfs"))).toBe(true);
      expect((await served()).draw).toBe(true);
    } finally {
      await c.query("rollback to savepoint broken_cache");
    }
  });
});
