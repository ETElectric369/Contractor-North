import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg, type ThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { storedChoice, storedChoiceName } from "@/lib/bank-download";
import { computeCollected } from "@/lib/analytics/money-metrics";

/**
 * BILLS AND MONEY LISTS (Wave 1, lane 7): the reads and the one stored word this lane leans on, where
 * their boundaries live: the database. No migration of its own; everything runs as the person, under
 * RLS, inside ONE transaction that is always rolled back, on throwaway companies.
 *
 *   · THE SALES DOT counts only the leads due now (the layout: status new, not converted, and no
 *     follow-up day or one that has come), so a lead snoozed from Needs You waits for its day.
 *   · PETTY CASH'S DOOR in Search Or Ask: the layout's existence check (this company's rows, one at
 *     most) sees its own company's entry and never another's.
 *   · CASH TAKEN OUT (NOT A COST) is kept under the word 0363's CHECK allows ('petty_cash'): a line
 *     and a rule under it are accepted, the app's own word is refused, and it reads back as itself.
 *   · PAYMENTS IN THIS MONTH on /billing reads payments with no org filter of its own: RLS keeps it to
 *     the company's own, and the month sum is computeCollected over exactly those rows.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run src/lib/money-lists-reads.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

/** The SQL PostgREST makes of the layout's lead-badge read (eq status new, is converted_at null,
 *  or next_follow_up_at.is.null,next_follow_up_at.lte.<today>). */
const LEADS_DUE_SQL =
  "select count(*)::int as n from public.inquiries where status = 'new' and converted_at is null and (next_follow_up_at is null or next_follow_up_at <= $1::date)";

d("lane 7's reads: the Sales dot, the Petty Cash door, Cash Taken Out's stored word, Payments In", () => {
  let c: pg.Client;
  let a: ThrowawayOrg;
  let b: ThrowawayOrg;
  let hasBank = false;

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** Run as `uid` (a real sign-in under RLS), always back to the server after. */
  const asPerson = async <T>(uid: string, fn: () => Promise<T>): Promise<T> => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
    try {
      return await fn();
    } finally {
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");
    }
  };
  /** A statement expected to FAIL, inside a savepoint so the transaction lives on. Returns the code. */
  const refused = async (sql: string, params: unknown[] = []) => {
    await c.query("savepoint s");
    try {
      await c.query(sql, params);
      await c.query("release savepoint s");
      return null;
    } catch (e) {
      await c.query("rollback to savepoint s");
      return String((e as { code?: string }).code ?? "error");
    }
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '30s'");
    a = await mintThrowawayOrg(c, { label: "lane 7 reads", techs: 1 });
    b = await mintThrowawayOrg(c, { label: "lane 7 reads other", techs: 0 });
    hasBank = !!(await one("select to_regclass('public.bank_lines') is not null and to_regclass('public.bank_rules') is not null as ok")).ok;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the Sales dot: new, unconverted leads with no day or a day that has come; a snoozed or contacted one waits", async () => {
    const today = "2001-06-15";
    const lead = (org: string, name: string, over: { status?: string; day?: string | null; converted?: boolean } = {}) =>
      c.query(
        "insert into public.inquiries (org_id, name, status, next_follow_up_at, converted_at) values ($1, $2, $3, $4::date, $5)",
        [org, `TEST lane 7 ${name}`, over.status ?? "new", over.day ?? null, over.converted ? "2001-06-01T00:00:00Z" : null],
      );
    const before = await asPerson(a.owner.id, async () => Number((await one(LEADS_DUE_SQL, [today])).n));
    await lead(a.orgId, "no day");
    await lead(a.orgId, "due today", { day: today });
    await lead(a.orgId, "late", { day: "2001-06-10" });
    await lead(a.orgId, "snoozed", { day: "2001-06-22" });
    await lead(a.orgId, "called", { status: "contacted" });
    await lead(a.orgId, "won", { converted: true });
    await lead(b.orgId, "another company's");
    const after = await asPerson(a.owner.id, async () => Number((await one(LEADS_DUE_SQL, [today])).n));
    expect(after - before).toBe(3);
    // The snoozed one comes back on its day.
    const onItsDay = await asPerson(a.owner.id, async () => Number((await one(LEADS_DUE_SQL, ["2001-06-22"])).n));
    expect(onItsDay - before).toBe(4);
  });

  it("the Petty Cash door: the layout's check sees this company's entry, one row at most, never another company's", async () => {
    const check = (uid: string, org: string) =>
      asPerson(uid, async () => (await c.query("select id from public.petty_cash where org_id = $1 limit 1", [org])).rowCount ?? 0);
    expect(await check(a.owner.id, a.orgId)).toBe(0);
    await c.query("insert into public.petty_cash (org_id, tx_date, kind, amount, description) values ($1, '2001-06-15', 'replenish', 90, 'TEST lane 7, rolled back')", [a.orgId]);
    await c.query("insert into public.petty_cash (org_id, tx_date, kind, amount, description) values ($1, '2001-06-16', 'expense', 20, 'TEST lane 7, rolled back')", [a.orgId]);
    expect(await check(a.owner.id, a.orgId)).toBe(1);
    // Another company's owner: nothing of theirs, and nothing of A's even when asked for it.
    expect(await check(b.owner.id, b.orgId)).toBe(0);
    expect(await check(b.owner.id, a.orgId)).toBe(0);
  });

  it("Cash Taken Out is kept under 'petty_cash' (0363's CHECK), the app's own word is refused, and it reads back as itself", async () => {
    if (!hasBank) return void notOnThisDatabase("[money-lists-reads] bank_lines / bank_rules (0363) are not on this database yet.");
    const word = storedChoice({ choice: "cash_out" });
    expect(word).toBe("petty_cash");
    const importId = String((await one("select gen_random_uuid()::text as id")).id);
    const lineAs = (choice: string, key: string) =>
      refused(
        "insert into public.bank_lines (org_id, import_id, line_key, posted_on, amount, description, merchant_key, choice, sorted_by) values ($1, $2, $3, '2001-06-15', -200, 'ATM WITHDRAWAL MAIN ST', 'atm withdrawal main st', $4, 'person')",
        [a.orgId, importId, key, choice],
      );
    await asPerson(a.owner.id, async () => {
      expect(await lineAs(word, `line:${"7".repeat(64)}`)).toBeNull();
      expect(await lineAs("cash_out", `line:${"8".repeat(64)}`)).toBe("23514");
      expect(
        await refused(
          "insert into public.bank_rules (org_id, direction, merchant_key, choice, min_cents, max_cents, learned_import_id) values ($1, 'out', 'atm withdrawal', $2, 20000, 20000, $3)",
          [a.orgId, word, importId],
        ),
      ).toBeNull();
    });
    const stored = await one("select choice from public.bank_lines where org_id = $1 and import_id = $2", [a.orgId, importId]);
    expect(storedChoiceName(String(stored.choice))).toBe("cash_out");
    const rule = await one("select answer from public.bank_rules where org_id = $1 and learned_import_id = $2", [a.orgId, importId]);
    expect(storedChoiceName(String(rule.answer))).toBe("cash_out");
    // A line kept that way writes no money row: nothing in petty cash names it.
    expect(Number((await one("select count(*)::int as n from public.petty_cash where org_id = $1 and bank_line_id is not null", [a.orgId])).n)).toBe(0);
  });

  it("Payments In's month: payments read with no org filter are the company's own (RLS), summed by computeCollected", async () => {
    const monthStart = new Date("2001-06-01T07:00:00Z");
    const invoice = async (org: string, n: string) =>
      String(
        (
          await one(
            "insert into public.invoices (org_id, invoice_number, status, invoice_kind, total) values ($1, $2, 'sent', 'standard', 1000) returning id::text as id",
            [org, `TEST-L7-${n}`],
          )
        ).id,
      );
    const invA = await invoice(a.orgId, "A");
    const invB = await invoice(b.orgId, "B");
    const pay = (org: string, inv: string, amount: number, at: string) =>
      c.query("insert into public.payments (org_id, invoice_id, amount, paid_at, method) values ($1, $2, $3, $4, 'check')", [org, inv, amount, at]);
    await pay(a.orgId, invA, 300, "2001-06-20T18:00:00Z");
    await pay(a.orgId, invA, 125.5, "2001-06-02T18:00:00Z");
    await pay(a.orgId, invA, 900, "2001-05-20T18:00:00Z");
    await pay(b.orgId, invB, 4000, "2001-06-21T18:00:00Z");
    const rows = await asPerson(a.owner.id, async () =>
      (
        await c.query(
          "select p.amount, p.paid_at, json_build_object('status', i.status) as invoices from public.payments p left join public.invoices i on i.id = p.invoice_id where p.paid_at >= $1 and p.paid_at < '2001-07-01T07:00:00Z'",
          [monthStart.toISOString()],
        )
      ).rows,
    );
    expect(rows).toHaveLength(2);
    expect(computeCollected(rows as any[], [], monthStart)).toBe(425.5);
  });
});
