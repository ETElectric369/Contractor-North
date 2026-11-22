import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * MONEY AHEAD OF THE WORK (0414; cn-v1177), proven on the database it lives on, inside ONE transaction
 * that is always rolled back:
 *
 *   the kind          'prepayment' is a kind of bill; a word it does not know is refused;
 *   one per estimate  a second live deposit request for one estimate is refused (23505); a voided
 *                     one makes room for the next;
 *   THE BOUNDARY      every refusal of 0414's triggers: a credit line naming a bill that is not a
 *                     request, a void request, a draft request, a request on another job; a credit
 *                     line on a request; a line that adds money; two bills taking more than the request
 *                     asks; the request's own line lowered or deleted below what was taken; the request
 *                     voided or put back to draft while a bill that went out took it off (allowed while
 *                     only a draft did); the request deleted while a line names it; a carrier moved to
 *                     another job; a carrier un-voided past what is left; a carrier sent while its
 *                     request is void; the check on the column, both ways;
 *   the link          public_quote's three keys in each deposit_state (none, due, requested, paid),
 *                     and can_take_card as the company's card door says; a live request's own ask
 *                     is the amount; a voided request or a job that is over offers nothing.
 *
 * NOT PROVEN HERE: two writers at the same instant (one connection cannot race itself). The trigger
 * takes the request's row FOR UPDATE before it sums (tests/migration-0414.test.ts pins the order), so the
 * second writer waits and then reads the first one's line.
 *
 * 0414 is applied here ONLY when it is not on the database yet (by what it left: the column). The owner
 * applies it on the test database before the deploy, so on CI that branch is not taken.
 *
 * Every company here is a TEST company minted inside the transaction (throwaway-org.db-fixture.ts). No
 * person and no street here is anybody's. Never run outside CI by hand; it skips without the test
 * database's credentials.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db src/lib/payment-request.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const M0414 = fileURLToPath(new URL("../../supabase/migrations/0414_money_ahead.sql", import.meta.url));

d("0414: money ahead of the work, in the database", () => {
  let c: pg.Client;
  const tag = randomUUID().slice(0, 8);
  let seq = 0;
  let org = "";
  let cust = "";
  let job = "";
  let otherJob = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** What a statement is refused with (SQLSTATE and words), or null when it went through (then undone). */
  const refused = async (sql: string, params: unknown[] = []): Promise<{ code: string; message: string } | null> => {
    await c.query("savepoint attempt");
    try {
      await c.query(sql, params);
      return null;
    } catch (e) {
      return { code: String((e as { code?: string }).code ?? ""), message: String((e as Error).message ?? e) };
    } finally {
      await c.query("rollback to savepoint attempt");
    }
  };
  /** The same, but a statement that goes through is KEPT. */
  const kept = async (sql: string, params: unknown[] = []) => {
    await c.query("savepoint keep");
    try {
      await c.query(sql, params);
      await c.query("release savepoint keep");
    } catch (e) {
      await c.query("rollback to savepoint keep");
      throw e;
    }
  };

  const newJob = async (label: string) =>
    (
      await one(
        `insert into public.jobs (org_id, customer_id, name, job_number, status, billing_type)
         values ($1, $2, $3, $3, 'in_progress', 'tm') returning id::text as id`,
        [org, cust, `TEST-0414-${label}-${tag}`],
      )
    ).id as string;
  const bill = async (o: { job?: string | null; status?: string; kind?: string; quote?: string | null }) =>
    (
      await one(
        `insert into public.invoices (org_id, customer_id, job_id, quote_id, invoice_number, status, invoice_kind, subtotal, total)
         values ($1, $2, $3, $4, $5, $6::invoice_status, $7, 0, 0) returning id::text as id`,
        [org, cust, o.job === undefined ? job : o.job, o.quote ?? null, `TEST-0414-${tag}-${++seq}`, o.status ?? "draft", o.kind ?? "standard"],
      )
    ).id as string;
  const line = async (inv: string, price: number, o: { source?: string | null; request?: string | null; kind?: string | null } = {}) =>
    (
      await one(
        `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit, unit_price, import_source, prepaid_invoice_id, line_kind)
         values ($1, $2, 'TEST 0414 line', 1, 'ea', $3, $4, $5, $6) returning id::text as id`,
        [org, inv, price, o.source ?? null, o.request ?? null, o.kind ?? null],
      )
    ).id as string;
  /** A payment request as the app makes one: born a draft, its one line, then sent. */
  const request = async (amount: number, o: { quote?: string | null; jobId?: string } = {}) => {
    const id = await bill({ kind: "prepayment", quote: o.quote ?? null, job: o.jobId ?? job });
    await line(id, amount, { source: "prepayment" });
    await c.query("update public.invoices set status = 'sent' where id = $1", [id]);
    return id;
  };
  const creditLine = (inv: string, req: string, amount: number) =>
    `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit, unit_price, import_source, prepaid_invoice_id, line_kind)
     values ('${org}', '${inv}', 'Less deposit', 1, 'lot', ${-amount}, 'prepaid_credit', '${req}', 'credit')`;

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const there = await one(
      "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'prepaid_invoice_id') as ok",
    );
    if (there.ok !== true) {
      await c.query(readFileSync(M0414, "utf8")); // the ground check, the changes, the self-check
      console.warn("[payment-request] 0414 was applied inside this suite's transaction and is rolled back with it.");
    }
    const minted = await mintThrowawayOrg(c, { label: "0414", techs: 0 });
    org = minted.orgId;
    cust = (await one("insert into public.customers (org_id, name) values ($1, 'TEST 0414 Larkspur') returning id::text as id", [org])).id;
    job = await newJob("J");
    otherJob = await newJob("OTHER");
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the kind: 'prepayment' is a kind of bill, a word it does not know is not", async () => {
    expect(await refused("update public.invoices set invoice_kind = 'prepayment' where id = $1", [await bill({})])).toBeNull();
    expect((await refused("update public.invoices set invoice_kind = 'retainer' where id = $1", [await bill({})]))?.code).toBe("23514");
  });

  it("one live deposit request per estimate; a voided one makes room for the next", async () => {
    const q = (
      await one(
        `insert into public.quotes (org_id, customer_id, job_id, title, status, public_token) values ($1, $2, $3, 'TEST 0414 estimate', 'accepted'::quote_status, $4) returning id::text as id`,
        [org, cust, job, `test-0414-${tag}-${randomUUID()}`],
      )
    ).id;
    const first = await request(420, { quote: q });
    expect((await refused("insert into public.invoices (org_id, customer_id, job_id, quote_id, invoice_number, status, invoice_kind) values ($1, $2, $3, $4, $5, 'draft', 'prepayment')", [org, cust, job, q, `TEST-0414-${tag}-dup`]))?.code).toBe("23505");
    await c.query("update public.invoices set status = 'void' where id = $1", [first]);
    expect(await refused("insert into public.invoices (org_id, customer_id, job_id, quote_id, invoice_number, status, invoice_kind) values ($1, $2, $3, $4, $5, 'draft', 'prepayment')", [org, cust, job, q, `TEST-0414-${tag}-next`])).toBeNull();
  });

  describe("the boundary", () => {
    it("the column is set exactly on a prepaid_credit line, both ways", async () => {
      const req = await request(1000);
      const b = await bill({});
      expect((await refused(`insert into public.invoice_items (org_id, invoice_id, description, unit_price, import_source) values ($1, $2, 'x', -10, 'prepaid_credit')`, [org, b]))?.code).toBe("23514");
      expect((await refused(`insert into public.invoice_items (org_id, invoice_id, description, unit_price, prepaid_invoice_id) values ($1, $2, 'x', -10, $3)`, [org, b, req]))?.code).toBe("23514");
    });

    it("refuses a credit naming what is not a live request on this job, a credit on a request, and a credit that adds money", async () => {
      const b = await bill({});
      const notRequest = await bill({ status: "sent" });
      const voided = await request(500);
      await c.query("update public.invoices set status = 'void' where id = $1", [voided]);
      const draftReq = await bill({ kind: "prepayment" });
      await line(draftReq, 500, { source: "prepayment" });
      const elsewhere = await request(500, { jobId: otherJob });
      const live = await request(500);
      const reqAsCarrier = await request(300);
      for (const [why, sql, words] of [
        ["not a request", creditLine(b, notRequest, 10), "is not a payment request"],
        ["a void request", creditLine(b, voided, 10), "was voided"],
        ["a draft request", creditLine(b, draftReq, 10), "is a draft"],
        ["another job's request", creditLine(b, elsewhere, 10), "is on another job"],
        ["a credit on a request", creditLine(reqAsCarrier, live, 10), "can't take another payment request off"],
        ["a line that adds money", creditLine(b, live, -10), "can't add any"],
      ] as const) {
        const r = await refused(sql);
        expect(r?.code, why).toBe("P0001");
        expect(r?.message, why).toContain(words);
        expect(r?.message, why).toMatch(/Nothing was saved\.$/);
      }
    });

    it("two bills never take more than the request asks, drafts included", async () => {
      const req = await request(1000);
      const a = await bill({});
      const b = await bill({});
      await line(a, 2000);
      await line(b, 2000);
      await kept(creditLine(a, req, 800));
      const over = await refused(creditLine(b, req, 300));
      expect(over?.code).toBe("P0001");
      expect(over?.message).toMatch(/asks for \$1,000\.00, and its bills would take \$1,100\.00 off/);
      expect(await refused(creditLine(b, req, 200))).toBeNull();
      // Raised on the line itself, the same.
      const raised = await refused("update public.invoice_items set unit_price = -1200 where invoice_id = $1 and import_source = 'prepaid_credit'", [a]);
      expect(raised?.code).toBe("P0001");
      // A void bill takes nothing: voiding A frees its 800 for B.
      await c.query("update public.invoices set status = 'void' where id = $1", [a]);
      expect(await refused(creditLine(b, req, 1000))).toBeNull();
    });

    it("the request's own line can't go below what was taken, nor be deleted under it", async () => {
      const req = await request(1000);
      const a = await bill({});
      await line(a, 2000);
      await kept(creditLine(a, req, 600));
      const lowered = await refused("update public.invoice_items set unit_price = 500 where invoice_id = $1", [req]);
      expect(lowered?.code).toBe("P0001");
      expect(lowered?.message).toMatch(/can't ask for \$500\.00: bills already take \$600\.00 of it off/);
      expect((await refused("delete from public.invoice_items where invoice_id = $1", [req]))?.code).toBe("P0001");
      expect(await refused("update public.invoice_items set unit_price = 700 where invoice_id = $1", [req])).toBeNull();
    });

    it("a request a SENT bill took off is not voided or put back to draft; one only a draft took off is", async () => {
      const req = await request(1000);
      const a = await bill({});
      await line(a, 2000);
      await kept(creditLine(a, req, 1000));
      expect(await refused("update public.invoices set status = 'void' where id = $1", [req])).toBeNull();
      await c.query("update public.invoices set status = 'sent' where id = $1", [a]);
      const v = await refused("update public.invoices set status = 'void' where id = $1", [req]);
      expect(v?.code).toBe("P0001");
      expect(v?.message).toMatch(/can't be voided: .* already took it off and went out\. Void .* first, or leave .* as it is\./);
      expect((await refused("update public.invoices set status = 'draft' where id = $1", [req]))?.code).toBe("P0001");
      // …and it keeps its kind and its job while a bill names it.
      expect((await refused("update public.invoices set invoice_kind = 'standard' where id = $1", [req]))?.code).toBe("P0001");
      expect((await refused("update public.invoices set job_id = $2 where id = $1", [req, otherJob]))?.code).toBe("P0001");
    });

    it("a request a line names is not deleted (the restrict a foreign key would have held)", async () => {
      const req = await bill({ kind: "prepayment" });
      await line(req, 500, { source: "prepayment" });
      await c.query("update public.invoices set status = 'sent' where id = $1", [req]);
      const a = await bill({});
      await line(a, 900);
      await kept(creditLine(a, req, 500));
      const del = await refused("delete from public.invoices where id = $1", [req]);
      expect(del?.code).toBe("P0001");
      expect(del?.message).toMatch(/can't be deleted: .* takes it off/);
    });

    it("a bill carrying a credit can't move job, can't come back from void past what is left (except as a draft, checked when it goes out), and can't go out naming a void request", async () => {
      const req = await request(1000);
      const a = await bill({});
      await line(a, 2000);
      await kept(creditLine(a, req, 1000));
      expect((await refused("update public.invoices set job_id = $2 where id = $1", [a, otherJob]))?.code).toBe("P0001");
      expect((await refused("update public.invoices set invoice_kind = 'prepayment' where id = $1", [a]))?.code).toBe("P0001");
      // Voided, its 1,000 is free and another bill takes it; brought back, it would take it twice.
      await c.query("update public.invoices set status = 'void' where id = $1", [a]);
      const b = await bill({});
      await line(b, 2000);
      await kept(creditLine(b, req, 1000));
      // Back from void as anything but a draft: checked, and refused.
      expect((await refused("update public.invoices set status = 'sent' where id = $1", [a]))?.code).toBe("P0001");
      // Back from void AS A DRAFT (skeptic #80): not re-checked (a draft's lines are derived; the app's
      // un-void door takes off first the ones that would not hold) ...
      await kept("update public.invoices set status = 'draft' where id = $1", [a]);
      // ... and checked when it goes out, in words that name an action it has.
      const goingOut = await refused("update public.invoices set status = 'sent' where id = $1", [a]);
      expect(goingOut?.code).toBe("P0001");
      expect(goingOut?.message).toContain("put this bill back to Draft and it takes the right amount");
      expect(goingOut?.message).not.toMatch(/open this bill again/i);
      await c.query("update public.invoices set status = 'void' where id = $1", [a]);
      // A draft naming a request that was voided while it was a draft does not go out.
      const req2 = await request(300);
      const d2 = await bill({});
      await line(d2, 900);
      await kept(creditLine(d2, req2, 300));
      await c.query("update public.invoices set status = 'void' where id = $1", [req2]);
      const out = await refused("update public.invoices set status = 'sent' where id = $1", [d2]);
      expect(out?.code).toBe("P0001");
      expect(out?.message).toContain("was voided");
      expect(out?.message).toContain("back to Draft");
    });

    it("nobody outside the database can call the boundary's functions", async () => {
      for (const fn of ["prepayment_hold(uuid, text)", "prepaid_credit_line_holds(uuid, uuid, numeric)", "guard_prepaid_credit_line()", "guard_prepayment_bill()", "guard_prepayment_delete()"]) {
        const r = await one(`select has_function_privilege('anon', 'public.${fn}', 'execute') as a, has_function_privilege('authenticated', 'public.${fn}', 'execute') as b`);
        expect([r.a, r.b], fn).toEqual([false, false]);
      }
    });
  });

  describe("public_quote says the deposit", () => {
    const asAnon = async () => {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
      await c.query("set local role anon");
    };
    const asServer = async () => {
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");
    };
    const link = async (token: string) => {
      await asAnon();
      try {
        return (await one("select public.public_quote($1)::text as j", [token])).j as string;
      } finally {
        await asServer();
      }
    };
    const estimate = async (deposit: number | null) => {
      const token = `test-0414-${tag}-${randomUUID()}`;
      const id = (
        await one(
          `insert into public.quotes (org_id, customer_id, job_id, title, status, public_token, deposit_amount, total) values ($1, $2, $3, 'TEST 0414 estimate', 'accepted'::quote_status, $4, $5, 4200) returning id::text as id`,
          [org, cust, job, token, deposit],
        )
      ).id as string;
      return { id, token };
    };
    const keys = async (token: string) => {
      const q = JSON.parse(await link(token)).quote;
      return { amount: q.deposit_amount === null ? null : Number(q.deposit_amount), state: q.deposit_state, card: q.can_take_card };
    };

    it("none, due, requested and paid; and the card door is the company's", async () => {
      expect(await keys((await estimate(null)).token)).toEqual({ amount: null, state: "none", card: false });
      expect(await keys((await estimate(0)).token)).toEqual({ amount: 0, state: "none", card: false });
      const e = await estimate(420);
      expect(await keys(e.token)).toEqual({ amount: 420, state: "due", card: false });
      const req = await request(420, { quote: e.id });
      expect((await keys(e.token)).state).toBe("requested");
      await c.query("update public.invoices set status = 'paid' where id = $1", [req]);
      expect((await keys(e.token)).state).toBe("paid");
      // VOIDED BY THE OFFICE (skeptic #80, F5): the link offers nothing; a new one is the office's form.
      await c.query("update public.invoices set status = 'void' where id = $1", [req]);
      expect(await keys(e.token)).toEqual({ amount: 420, state: "none", card: false });
      await c.query("update public.organizations set stripe_charges_enabled = true where id = $1", [org]);
      expect((await keys(e.token)).card).toBe(true);
    });

    it("ONE NUMBER (F4): a live request's own ask is the amount the link says and the card charges, whatever the estimate stored", async () => {
      const e = await estimate(1000);
      const req = await request(1500, { quote: e.id });
      expect(await keys(e.token)).toMatchObject({ amount: 1500, state: "requested" });
      await c.query("update public.invoices set status = 'paid' where id = $1", [req]);
      expect(await keys(e.token)).toMatchObject({ amount: 1500, state: "paid" });
      // A live request with no stored figure is still said (it is owed).
      const bare = await estimate(null);
      await request(300, { quote: bare.id });
      expect(await keys(bare.token)).toMatchObject({ amount: 300, state: "requested" });
    });

    it("NO DEAD BUTTON (F5): a job that is over with no live request offers nothing; a live request on it is still owed", async () => {
      const overJob = await newJob("OVER");
      const token = `test-0414-${tag}-${randomUUID()}`;
      const id = (
        await one(
          `insert into public.quotes (org_id, customer_id, job_id, title, status, public_token, deposit_amount, total) values ($1, $2, $3, 'TEST 0414 estimate', 'accepted'::quote_status, $4, 420, 4200) returning id::text as id`,
          [org, cust, overJob, token],
        )
      ).id as string;
      expect((await keys(token)).state).toBe("due");
      for (const st of ["complete", "cancelled"]) {
        await c.query(`update public.jobs set status = '${st}' where id = $1`, [overJob]);
        expect((await keys(token)).state, st).toBe("none");
      }
      await c.query("update public.jobs set status = 'in_progress' where id = $1", [overJob]);
      await request(420, { quote: id, jobId: overJob });
      await c.query("update public.jobs set status = 'complete' where id = $1", [overJob]);
      expect(await keys(token)).toMatchObject({ amount: 420, state: "requested" });
    });

    it("a token no estimate has is answered with nothing", async () => {
      expect(await link(`test-0414-${tag}-nobody`)).toBeNull();
    });
  });
});
