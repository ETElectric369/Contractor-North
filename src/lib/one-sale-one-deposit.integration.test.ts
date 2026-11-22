import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { billingKindOfDocType } from "@/lib/appointments/won-sheet";

/**
 * ONE SALE, ONE DEPOSIT (0416; cn-v1178), proven on the database it lives on, inside ONE transaction
 * that is always rolled back:
 *
 *   the family    quote_family_ids: a chain of three is one sale from any of its estimates; two
 *                 siblings and their first are one sale; a cleared pointer (Keep Both) is another
 *                 sale; another company's estimate pointing in is never in it; an estimate nobody has
 *                 is its own sale; a signed-out caller may not ask;
 *   the boundary  a second live deposit request in one sale is refused in one sentence that names the
 *                 standing one; so is a request coming back from void beside a sibling's, one moved
 *                 onto another estimate of the sale, and a bill turned into one; the same estimate is
 *                 still 0414's unique index (23505); A PAYMENT IS NEVER REFUSED: a request moving to
 *                 partial and to paid passes, even in a sale that already holds two live requests;
 *   the link      public_quote on a sent revision of an estimate whose request is paid says paid and
 *                 that request's ask, and asks nothing; partly paid, deposit_due is what is left;
 *                 card_fee_percent is the company's;
 *   the accept    a Quote makes a fixed-price job and an Estimate a time and material one, whatever
 *                 the company's usual kind, as the app's billingKindOfDocType says.
 *
 * TWO LIVE REQUESTS IN ONE SALE, AS BEFORE THE GUARD: each request is made on an estimate of its own
 * sale, and only then is the second estimate made a revision of the first (a write to quotes, which
 * the boundary does not watch). The contract asked for the trigger to be disabled inside the
 * transaction instead; ALTER TABLE ... DISABLE TRIGGER takes ACCESS EXCLUSIVE on invoices and would
 * hold it for the whole suite, so every other suite reading invoices would wait on it.
 *
 * 0414 and 0416 are applied here ONLY when they are not on the database yet (by what they left). The
 * owner applies them on the test database before the deploy, so on CI those branches are not taken;
 * on a database without 0416 the file runs TWICE (it is twice-safe, and that is proven too).
 *
 * Every company here is a TEST company minted inside the transaction (throwaway-org.db-fixture.ts).
 * No person and no street here is anybody's. Never run outside CI by hand; it skips without the test
 * database's credentials.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db src/lib/one-sale-one-deposit.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const M0414 = fileURLToPath(new URL("../../supabase/migrations/0414_money_ahead.sql", import.meta.url));
const M0416 = fileURLToPath(new URL("../../supabase/migrations/0416_one_sale_one_deposit.sql", import.meta.url));

const REFUSAL = /^This sale already has a deposit request: (.+)\. Use that one\. Nothing was made\.$/;

d("0416: one sale, one deposit, in the database", () => {
  let c: pg.Client;
  const tag = randomUUID().slice(0, 8);
  let seq = 0;
  let org = "";
  let ownerId = "";
  let cust = "";
  let job = "";
  let otherOrg = "";

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

  /** An estimate of the Larkspur job, as the office leaves one. */
  const estimate = async (o: { revises?: string | null; status?: string; orgId?: string; customerId?: string | null; jobId?: string | null; deposit?: number | null; docType?: string } = {}) => {
    const id = randomUUID();
    const token = `test-0416-${tag}-${randomUUID()}`;
    const res = await c.query(
      `insert into public.quotes (id, org_id, customer_id, job_id, title, status, public_token, revises_quote_id, deposit_amount, doc_type, total, created_by)
       values ($1, $2, $3, $4, 'TEST 0416 Larkspur estimate', $5::quote_status, $6, $7, $8, $9, 4800, $10)`,
      [
        id,
        o.orgId ?? org,
        o.customerId === undefined ? cust : o.customerId,
        o.jobId === undefined ? job : o.jobId,
        o.status ?? "accepted",
        token,
        o.revises ?? null,
        o.deposit ?? null,
        o.docType ?? "estimate",
        o.orgId && o.orgId !== org ? null : ownerId,
      ],
    );
    expect(res.rowCount).toBe(1);
    return { id, token };
  };
  const family = async (quoteId: string) =>
    ((await one("select coalesce(array_agg(f.id::text order by f.id::text), '{}') as ids from public.quote_family_ids($1::uuid) as f(id)", [quoteId])).ids as string[]);
  const sorted = (xs: string[]) => [...xs].sort();

  /** The SQL that makes a payment request as the app does: born a draft, one line, total its ask. */
  const requestSql = (quoteId: string, amount: number, number: string, jobId: string = job) =>
    [
      `insert into public.invoices (org_id, customer_id, job_id, quote_id, invoice_number, status, invoice_kind, subtotal, tax, total)
       values ($1, $2, $3, $4, $5, 'draft', 'prepayment', $6, 0, $6) returning id::text as id`,
      [org, cust, jobId, quoteId, number, amount],
    ] as const;
  /** A live deposit request on an estimate: made, its line, then sent. Returns its id and number. */
  const request = async (quoteId: string, amount: number, jobId: string = job) => {
    const number = `TEST-0416-${tag}-${++seq}`;
    const [sql, params] = requestSql(quoteId, amount, number, jobId);
    const id = (await one(sql, [...params])).id as string;
    await c.query(
      `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit, unit_price, import_source)
       values ($1, $2, 'TEST 0416 deposit', 1, 'ea', $3, 'prepayment')`,
      [org, id, amount],
    );
    await c.query("update public.invoices set status = 'sent' where id = $1", [id]);
    return { id, number };
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const has0414 = await one(
      "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'prepaid_invoice_id') as ok",
    );
    if (has0414.ok !== true) {
      await c.query(readFileSync(M0414, "utf8"));
      console.warn("[one-sale-one-deposit] 0414 was applied inside this suite's transaction and is rolled back with it.");
    }
    const has0416 = await one(
      `select to_regprocedure('public.quote_family_ids(uuid)') is not null
              and exists (select 1 from pg_trigger t where t.tgrelid = 'public.invoices'::regclass and t.tgname = 'invoices_one_deposit_per_sale' and not t.tgisinternal) as ok`,
    );
    if (has0416.ok !== true) {
      const sql = readFileSync(M0416, "utf8");
      await c.query(sql); // the ground check, the functions and the trigger, the self-check
      await c.query(sql); // and the second run the file says is safe
      console.warn("[one-sale-one-deposit] 0416 was applied inside this suite's transaction (twice: it is twice-safe) and is rolled back with it.");
    }
    const minted = await mintThrowawayOrg(c, { label: "0416", techs: 0 });
    org = minted.orgId;
    ownerId = minted.owner.id;
    otherOrg = (await mintThrowawayOrg(c, { label: "0416 other", techs: 0 })).orgId;
    cust = (await one("insert into public.customers (org_id, name) values ($1, 'TEST 0416 Sam Tillery') returning id::text as id", [org])).id;
    job = (
      await one(
        `insert into public.jobs (org_id, customer_id, name, job_number, status, billing_type)
         values ($1, $2, $3, $3, 'in_progress', 'tm') returning id::text as id`,
        [org, cust, `TEST-0416-Larkspur-${tag}`],
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

  describe("the family", () => {
    it("a chain of three is one sale, from any of its estimates", async () => {
      const first = await estimate();
      const second = await estimate({ revises: first.id, status: "sent" });
      const third = await estimate({ revises: second.id, status: "draft" });
      const want = sorted([first.id, second.id, third.id]);
      for (const q of [first, second, third]) expect(await family(q.id)).toEqual(want);
    });

    it("two siblings and their first are one sale", async () => {
      const first = await estimate();
      const a = await estimate({ revises: first.id, status: "sent" });
      const b = await estimate({ revises: first.id, status: "sent" });
      const want = sorted([first.id, a.id, b.id]);
      for (const q of [first, a, b]) expect(await family(q.id)).toEqual(want);
    });

    it("a cleared pointer (Keep Both) is another sale, and another company's estimate pointing in is never in it", async () => {
      const first = await estimate();
      const kept = await estimate({ revises: first.id, status: "sent" });
      await c.query("update public.quotes set revises_quote_id = null where id = $1", [kept.id]);
      const theirs = await estimate({ orgId: otherOrg, customerId: null, jobId: null, revises: first.id, status: "sent" });
      expect(await family(first.id)).toEqual([first.id]);
      expect(await family(kept.id)).toEqual([kept.id]);
      expect(await family(theirs.id)).toEqual([theirs.id]);
    });

    it("an estimate nobody has is its own sale, and a cycle does not loop", async () => {
      const nobody = randomUUID();
      expect(await family(nobody)).toEqual([nobody]);
      const a = await estimate();
      const b = await estimate({ revises: a.id, status: "sent" });
      await c.query("savepoint cycle");
      try {
        await c.query("update public.quotes set revises_quote_id = $2 where id = $1", [a.id, b.id]);
        expect(await family(a.id)).toEqual(sorted([a.id, b.id]));
      } finally {
        await c.query("rollback to savepoint cycle");
      }
    });

    it("the signed-in role and the server may ask it; a signed-out caller may not", async () => {
      const g = await one(
        `select has_function_privilege('anon', 'public.quote_family_ids(uuid)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.quote_family_ids(uuid)', 'execute') as authed,
                has_function_privilege('service_role', 'public.quote_family_ids(uuid)', 'execute') as server,
                (select p.prosecdef from pg_proc p where p.oid = 'public.quote_family_ids(uuid)'::regprocedure) as definer`,
      );
      expect(g).toEqual({ anon: false, authed: true, server: true, definer: false });
    });
  });

  describe("the boundary", () => {
    it("a second live request in one sale is refused, naming the one that stands; the same estimate is still 0414's 23505", async () => {
      const first = await estimate();
      const revision = await estimate({ revises: first.id, status: "sent" });
      const standing = await request(first.id, 480);
      const [sql, params] = requestSql(revision.id, 480, `TEST-0416-${tag}-second`);
      const r = await refused(sql, [...params]);
      expect(r?.code).toBe("P0001");
      expect(r?.message).toMatch(REFUSAL);
      expect(r?.message.match(REFUSAL)?.[1]).toBe(standing.number);
      const [same, sameParams] = requestSql(first.id, 480, `TEST-0416-${tag}-same`);
      expect((await refused(same, [...sameParams]))?.code).toBe("23505");
    });

    it("a request coming back from void beside a sibling's live one is refused; with none live it comes back", async () => {
      // A job of its own: back from void, the request meets no other live bill on its job, so no older
      // un-void guard (0260, 0415) has anything to say and the answer is this boundary's alone.
      const own = (
        await one(
          `insert into public.jobs (org_id, customer_id, name, job_number, status, billing_type)
           values ($1, $2, $3, $3, 'in_progress', 'tm') returning id::text as id`,
          [org, cust, `TEST-0416-Snowbell-${tag}`],
        )
      ).id as string;
      const first = await estimate({ jobId: own });
      const sibling = await estimate({ revises: first.id, status: "sent", jobId: own });
      const old = await request(first.id, 300, own);
      await c.query("update public.invoices set status = 'void' where id = $1", [old.id]);
      const live = await request(sibling.id, 300, own);
      const r = await refused("update public.invoices set status = 'sent' where id = $1", [old.id]);
      expect(r?.code).toBe("P0001");
      expect(r?.message.match(REFUSAL)?.[1]).toBe(live.number);
      await c.query("update public.invoices set status = 'void' where id = $1", [live.id]);
      expect(await refused("update public.invoices set status = 'sent' where id = $1", [old.id])).toBeNull();
    });

    it("a request moved onto another estimate of a sale that has one, and a bill turned into a request there, are refused", async () => {
      const first = await estimate();
      const revision = await estimate({ revises: first.id, status: "sent" });
      const standing = await request(first.id, 250);
      const elsewhere = await estimate();
      const loose = await request(elsewhere.id, 250);
      const moved = await refused("update public.invoices set quote_id = $2 where id = $1", [loose.id, revision.id]);
      expect(moved?.message.match(REFUSAL)?.[1]).toBe(standing.number);
      const bill = (
        await one(
          `insert into public.invoices (org_id, customer_id, job_id, quote_id, invoice_number, status, invoice_kind, total)
           values ($1, $2, $3, $4, $5, 'draft', 'standard', 0) returning id::text as id`,
          [org, cust, job, revision.id, `TEST-0416-${tag}-bill`],
        )
      ).id;
      const turned = await refused("update public.invoices set invoice_kind = 'prepayment' where id = $1", [bill]);
      expect(turned?.message.match(REFUSAL)?.[1]).toBe(standing.number);
    });

    it("A PAYMENT IS NEVER REFUSED: partial and paid pass, even in a sale that already holds two live requests", async () => {
      // Two sales, each with its live request; THEN the second estimate becomes a revision of the first.
      const first = await estimate();
      const later = await estimate({ status: "sent" });
      const a = await request(first.id, 400);
      const b = await request(later.id, 400);
      await c.query("update public.quotes set revises_quote_id = $2 where id = $1", [later.id, first.id]);
      expect(await family(first.id)).toEqual(sorted([first.id, later.id]));
      const live = await one(
        "select count(*)::int as n from public.invoices where quote_id = any ($1::uuid[]) and invoice_kind = 'prepayment' and status <> 'void'",
        [[first.id, later.id]],
      );
      expect(live.n).toBe(2);
      for (const r of [a, b]) {
        expect(await refused("update public.invoices set status = 'partial', amount_paid = 150 where id = $1", [r.id]), `${r.number} partial`).toBeNull();
        await c.query("update public.invoices set status = 'partial', amount_paid = 150 where id = $1", [r.id]);
        expect(await refused("update public.invoices set status = 'paid', amount_paid = 400 where id = $1", [r.id]), `${r.number} paid`).toBeNull();
        await c.query("update public.invoices set status = 'paid', amount_paid = 400 where id = $1", [r.id]);
      }
      // A write that names the watched columns and changes none of them (as a client that sends every
      // column does) passes too.
      expect(await refused("update public.invoices set quote_id = quote_id, invoice_kind = invoice_kind, status = status where id = $1", [b.id])).toBeNull();
      expect((await one("select status::text as s from public.invoices where id = $1", [b.id])).s).toBe("paid");
    });
  });

  describe("the link", () => {
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
        return JSON.parse((await one("select public.public_quote($1)::text as j", [token])).j as string).quote;
      } finally {
        await asServer();
      }
    };
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

    it("a sent revision of an estimate whose request is paid says paid and that request's ask, and asks nothing", async () => {
      const first = await estimate({ deposit: 480 });
      const req = await request(first.id, 480);
      await c.query("update public.invoices set status = 'paid', amount_paid = 480 where id = $1", [req.id]);
      const revision = await estimate({ revises: first.id, status: "sent", deposit: 520 });
      const q = await link(revision.token);
      expect({ state: q.deposit_state, amount: n(q.deposit_amount), due: n(q.deposit_due) }).toEqual({ state: "paid", amount: 480, due: null });
    });

    it("partly paid: deposit_due is what is left, on the estimate and on its revision", async () => {
      const first = await estimate({ deposit: 1000 });
      const req = await request(first.id, 1000);
      await c.query("update public.invoices set status = 'partial', amount_paid = 400 where id = $1", [req.id]);
      const revision = await estimate({ revises: first.id, status: "sent", deposit: 1000 });
      for (const e of [first, revision]) {
        const q = await link(e.token);
        expect({ state: q.deposit_state, amount: n(q.deposit_amount), due: n(q.deposit_due) }).toEqual({ state: "requested", amount: 1000, due: 600 });
      }
      // No request: nothing is due on the link (the stored figure is still the amount).
      const bare = await estimate({ deposit: 300 });
      expect(n((await link(bare.token)).deposit_due)).toBeNull();
    });

    it("card_fee_percent is the company's, 0 when it charges none", async () => {
      const e = await estimate({ deposit: 200 });
      expect(n((await link(e.token)).card_fee_percent)).toBe(0);
      await c.query(`update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"card_fee_percent": 3}'::jsonb where id = $1`, [org]);
      expect(n((await link(e.token)).card_fee_percent)).toBe(3);
    });
  });

  describe("the accept", () => {
    const tap = async (token: string) => {
      await c.query("savepoint the_link");
      try {
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
        await c.query("set local role anon");
        const row = await one("select public.accept_public_quote($1)::text as answer", [token]);
        await c.query("reset role");
        await c.query("select set_config('request.jwt.claims', '', true)");
        await c.query("release savepoint the_link");
        return JSON.parse(String(row.answer));
      } catch (e) {
        await c.query("rollback to savepoint the_link");
        await c.query("reset role");
        await c.query("select set_config('request.jwt.claims', '', true)");
        throw e;
      }
    };

    it("a Quote makes a fixed-price job and an Estimate a time and material one, whatever the company's usual kind", async () => {
      for (const usual of [
        { label: "mostly fixed", tm: 1, fixed: 2 },
        { label: "mostly time and material", tm: 2, fixed: 1 },
      ]) {
        const co = await mintThrowawayOrg(c, { label: `0416 ${usual.label}`, techs: 0 });
        for (const [kind, count] of [["tm", usual.tm], ["fixed", usual.fixed]] as const) {
          for (let i = 0; i < count; i++) {
            const res = await c.query("insert into public.jobs (org_id, name, status, billing_type) values ($1, $2, 'to_be_scheduled'::job_status, $3)", [co.orgId, `TEST 0416 ${kind} ${i}`, kind]);
            expect(res.rowCount).toBe(1);
          }
        }
        const dana = (await one("insert into public.customers (org_id, name) values ($1, 'TEST 0416 Dana Rook') returning id::text as id", [co.orgId])).id;
        for (const docType of ["quote", "estimate"]) {
          const id = randomUUID();
          const token = `test-0416-${tag}-${randomUUID()}`;
          await c.query(
            `insert into public.quotes (id, org_id, customer_id, title, status, public_token, doc_type, created_by)
             values ($1, $2, $3, 'TEST 0416 Snowbell paper', 'sent'::quote_status, $4, $5, $6)`,
            [id, co.orgId, dana, token, docType, co.owner.id],
          );
          expect(await tap(token)).toEqual({ ok: true });
          const made = await one("select j.billing_type from public.quotes q join public.jobs j on j.id = q.job_id where q.id = $1", [id]);
          expect({ company: usual.label, paper: docType, kind: made?.billing_type }).toEqual({ company: usual.label, paper: docType, kind: billingKindOfDocType(docType) });
        }
      }
    });
  });
});
