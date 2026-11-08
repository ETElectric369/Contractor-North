import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { PG_TYPES } from "@/lib/postgrest-shim.db-fixture";
import { customerHoldsOlderCopy } from "@/lib/invoice-revision";

/**
 * A SENT BILL REMEMBERS ITS FIGURE (0405; Erik, 2026-11-07): the trigger invoices_sent_total_follows_send,
 * proven on the database it runs on, inside ONE transaction that is always rolled back.
 *   · a draft that never went out carries no figure (null, not zero);
 *   · the first write that sets sent_at copies total into sent_total, in the same statement;
 *   · a change to total after the send leaves the recorded figure where it was (that gap is the
 *     whole point: it is what the notice's rule compares);
 *   · a re-send (sent_at moved to a new instant) records the new figure;
 *   · the same instant written again records nothing; a payment (amount_paid) touches nothing;
 *   · a row born with a send on it records its figure on insert;
 *   · the rule reads what the trigger wrote: a deposit then a money change says "send it again", a
 *     deposit then a wording change says nothing.
 *
 * 0405 is applied here ONLY when the database does not carry it yet. ADD COLUMN takes invoices'
 * ACCESS EXCLUSIVE lock, and inside this transaction it would be held until the rollback, across
 * every other suite's read of invoices. Erik applies 0405 on the test database before the deploy,
 * so on CI that branch is skipped; on a fresh rebuild it runs once, twice-safe.
 *
 * Every stamp this suite writes after the first send is now() plus an offset: inside one transaction
 * now() never moves, and the rule compares instants.
 *
 * One TEST company minted inside the transaction (throwaway-org.db-fixture.ts), every row named
 * TEST. Never run outside CI by hand; it skips without the test database's credentials.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("0405: every write that moves sent_at records the total it carried", () => {
  let c: pg.Client;
  let orgId = "";
  let invId = "";
  let firstSentAt = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** The row's three facts, numerics as numbers (PG_TYPES), the stamp as its ISO string. */
  const facts = async (id = invId) =>
    one("select total, amount_paid, sent_at, sent_total from public.invoices where id = $1", [id]) as Promise<{
      total: number;
      amount_paid: number;
      sent_at: string | null;
      sent_total: number | null;
    }>;

  beforeAll(async () => {
    c = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
      types: PG_TYPES,
    });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: the migration (if it runs) and every fixture live only inside this transaction.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const carried = (
      await one(
        `select to_regprocedure('public.invoices_sent_total_follows_send()') is not null
            and exists (select 1 from information_schema.columns
                         where table_schema = 'public' and table_name = 'invoices' and column_name = 'sent_total')
            and exists (select 1 from pg_trigger
                         where tgrelid = 'public.invoices'::regclass and tgname = 'invoices_sent_total_follows_send' and not tgisinternal) as ok`,
      )
    ).ok === true;
    if (!carried) {
      await c.query(readFileSync(fileURLToPath(new URL("../../supabase/migrations/0405_a_sent_bill_remembers_its_figure.sql", import.meta.url)), "utf8"));
    }
    const org = await mintThrowawayOrg(c, { label: "sent-total", techs: 0 });
    orgId = org.orgId;
    invId = (
      await one(
        `insert into public.invoices (org_id, invoice_number, status, invoice_kind, title, total, amount_paid)
         values ($1, 'TEST-ST-INV-1', 'draft', 'standard', 'TEST sent total', 100, 0) returning id::text as id`,
        [orgId],
      )
    ).id;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("a draft that never went out carries no figure: null, not zero", async () => {
    const r = await facts();
    expect(r.sent_at).toBeNull();
    expect(r.sent_total).toBeNull();
  });

  it("the first write that sets sent_at records the total, in the same statement", async () => {
    // markInvoiceSent's shape: status and sent_at together, nothing about sent_total.
    await c.query("update public.invoices set status = 'sent', sent_at = now() where id = $1", [invId]);
    const r = await facts();
    expect(r.sent_at).not.toBeNull();
    expect(r.sent_total).toBe(100);
    firstSentAt = r.sent_at!;
  });

  it("a change to total after the send leaves the recorded figure where it was", async () => {
    // INSIDE ONE TRANSACTION now() IS ONE INSTANT, the transaction's start, so a change stamped now()
    // would share the send's instant and the rule's "changed strictly after it went out" could never
    // hold (CI run 42462123874 proved it). Half a second later: after the send, before the re-send's +1s.
    await c.query("update public.invoices set total = 150, revised_at = now() + interval '500 milliseconds' where id = $1", [invId]);
    const r = await facts();
    expect(r.total).toBe(150);
    expect(r.sent_total).toBe(100);
  });

  it("a payment touches nothing: amount_paid is not a send", async () => {
    await c.query("update public.invoices set amount_paid = 40, status = 'partial' where id = $1", [invId]);
    const r = await facts();
    expect(r.amount_paid).toBe(40);
    expect(r.sent_total).toBe(100);
  });

  // This suite sets amount_paid by hand and writes no payments row, so the rule is handed no payment
  // dates (paidAt: []). Money paid with no dates to read counts as paid BEFORE the change - unknown
  // resolves towards saying so (skeptic #56's order rule, lib/invoice-revision paidBefore) - which is
  // what keeps these three reading the TRIGGER's figure, the thing under test here.
  it("the rule reads what the trigger wrote: paid against $100, $150 stands now, send it again", async () => {
    const r = await one("select total, amount_paid, sent_at, revised_at, sent_total from public.invoices where id = $1", [invId]);
    expect(customerHoldsOlderCopy(r.sent_at, r.revised_at, { total: r.total, amountPaid: r.amount_paid, sentTotal: r.sent_total, paidAt: [] })).toBe(true);
  });

  it("a re-send (sent_at moved to a new instant) records the new figure, and the notice clears", async () => {
    // markInvoiceResent's shape: sent_at alone. A later instant than the first send and the change.
    await c.query("update public.invoices set sent_at = now() + interval '1 second' where id = $1", [invId]);
    const r = await one("select total, amount_paid, sent_at, revised_at, sent_total from public.invoices where id = $1", [invId]);
    expect(r.sent_at).not.toBe(firstSentAt);
    expect(r.sent_total).toBe(150);
    expect(customerHoldsOlderCopy(r.sent_at, r.revised_at, { total: r.total, amountPaid: r.amount_paid, sentTotal: r.sent_total, paidAt: [] })).toBe(false);
  });

  it("the same instant written again records nothing", async () => {
    await c.query("update public.invoices set total = 175 where id = $1", [invId]);
    // A write that lists sent_at without moving it (the trigger fires on the column, the guard holds).
    await c.query("update public.invoices set sent_at = sent_at where id = $1", [invId]);
    const r = await facts();
    expect(r.total).toBe(175);
    expect(r.sent_total).toBe(150);
  });

  it("a wording change on a paid bill says nothing: the figure they paid against still stands", async () => {
    // Put the figures back in step with a re-send, then change only the title after it.
    await c.query("update public.invoices set sent_at = now() + interval '2 seconds' where id = $1", [invId]);
    await c.query("update public.invoices set title = 'TEST sent total, renamed', revised_at = now() + interval '3 seconds' where id = $1", [invId]);
    const r = await one("select total, amount_paid, sent_at, revised_at, sent_total from public.invoices where id = $1", [invId]);
    expect(r.sent_total).toBe(175);
    expect(Date.parse(r.revised_at)).toBeGreaterThan(Date.parse(r.sent_at));
    expect(customerHoldsOlderCopy(r.sent_at, r.revised_at, { total: r.total, amountPaid: r.amount_paid, sentTotal: r.sent_total, paidAt: [] })).toBe(false);
  });

  it("a row born with a send on it records its figure on insert", async () => {
    const born = (
      await one(
        `insert into public.invoices (org_id, invoice_number, status, invoice_kind, title, total, amount_paid, sent_at)
         values ($1, 'TEST-ST-INV-2', 'sent', 'standard', 'TEST born sent', 60, 0, now()) returning id::text as id`,
        [orgId],
      )
    ).id as string;
    const r = await facts(born);
    expect(r.sent_total).toBe(60);
  });

  it("a row born without a send carries none, whatever its total", async () => {
    const born = (
      await one(
        `insert into public.invoices (org_id, invoice_number, status, invoice_kind, title, total, amount_paid)
         values ($1, 'TEST-ST-INV-3', 'draft', 'standard', 'TEST born draft', 60, 0) returning id::text as id`,
        [orgId],
      )
    ).id as string;
    expect((await facts(born)).sent_total).toBeNull();
  });
});
