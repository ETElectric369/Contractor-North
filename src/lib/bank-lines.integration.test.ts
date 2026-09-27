import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";

/**
 * Migrations 0362 + 0363 + 0365: fuel is its own kind; a bank line is matched once; bank answers are
 * asked, not assumed (2026-09-27).
 *
 * Pinned here, against the real database, inside ONE transaction that is always rolled back:
 *   · bank_lines and bank_rules are STAFF-ONLY for every verb: a company's office reads and writes
 *     its own, a tech of the same company reads nothing and writes nothing, another company's staff
 *     reads nothing and changes nothing, and anon can't even ask;
 *   · a line is counted once per company (UNIQUE org_id + line_key) and a description can't hold a
 *     run of 6+ digits (the privacy boundary lives in the database, not only the app);
 *   · the company's rules: one per merchant and answer, each for the amounts it was given for, a
 *     cost names its bucket, and money in only ever says Not Income (0365);
 *   · a money row's bank_line_id comes off by itself when its line is deleted (Undo);
 *   · bills.cost_kind takes fuel or truck only, and only rides a Gas & Truck business cost.
 *
 * Makes its own two companies and three people inside that transaction (the test database may hold
 * nobody), and speaks as each by planting request.jwt.claims under `set local role authenticated`.
 * Everything is named TEST 0363; every date is 2001. Nothing is left behind.
 *
 * Until 0363 and 0365 are applied the suite waits, loudly; WAIT_APPLY_0363=1 applies whichever of
 * 0362, 0363 and 0365 is missing INSIDE the test's own transaction, which is rolled back, so the
 * database is left exactly as it was.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [WAIT_APPLY_0363=1] npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, WAIT_APPLY_0363 } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const M0362 = fileURLToPath(new URL("../../supabase/migrations/0362_fuel_is_its_own_kind.sql", import.meta.url));
const M0363 = fileURLToPath(new URL("../../supabase/migrations/0363_a_bank_line_is_matched_once.sql", import.meta.url));
const M0365 = fileURLToPath(new URL("../../supabase/migrations/0365_bank_answers_are_asked_not_assumed.sql", import.meta.url));

const KEY = (n: number) => `line:${String(n).padStart(64, "0")}`;

d("0362 + 0363: bank lines and rules are the company's own, and a line counts once", () => {
  let c: pg.Client;
  let waiting = false;
  let orgA = "";
  let orgB = "";
  let staffA = "";
  let techA = "";
  let staffB = "";
  let importA = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
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
  const ready = () =>
    !waiting || notOnThisDatabase("[bank-lines] 0363 or 0365 is not on this database yet; set WAIT_APPLY_0363=1 to apply them inside the rolled-back transaction.");
  const line = (org: string, n: number, over: Record<string, unknown> = {}) => {
    const row = { org_id: org, import_id: importA, line_key: KEY(n), posted_on: "2001-01-02", amount: -12.5, description: "SHELL 123 ANYTOWN", merchant_key: "shell", choice: "cost", bucket: "Gas & Truck", cost_kind: "fuel", sorted_by: "person", ...over };
    const cols = Object.keys(row);
    return c.query(`insert into bank_lines (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row));
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const has = await one("select to_regclass('public.bank_lines') is not null as yes");
    // 0365 says so on bank_rules' own comment.
    const has0365 = async () => (await one("select coalesce(obj_description(to_regclass('public.bank_rules'), 'pg_class'), '') like '%0365%' as yes")).yes;
    if ((!has.yes || !(await has0365())) && WAIT_APPLY_0363 !== "1") {
      waiting = true;
      return;
    }
    if (!has.yes) {
      const kind = await one("select exists (select 1 from information_schema.columns where table_schema='public' and table_name='bills' and column_name='cost_kind') as yes");
      if (!kind.yes) await c.query(readFileSync(M0362, "utf8"));
      await c.query(readFileSync(M0363, "utf8"));
    }
    if (!(await has0365())) await c.query(readFileSync(M0365, "utf8"));
    const person = async (org: string, role: string, tag: string) => {
      const email = `test-0363-${tag}@example.test`;
      await c.query("insert into signup_allowlist (email, note) values ($1, 'TEST 0363') on conflict do nothing", [email]);
      const id = (await one("insert into auth.users (id, email, aud, role) values (gen_random_uuid(), $1, 'authenticated', 'authenticated') returning id", [email])).id;
      await c.query("update profiles set org_id = $2, role = $3, active = true where id = $1", [id, org, role]);
      return String(id);
    };
    orgA = (await one("insert into organizations (name) values ('TEST 0363 A') returning id")).id;
    orgB = (await one("insert into organizations (name) values ('TEST 0363 B') returning id")).id;
    staffA = await person(orgA, "office", "staff-a");
    techA = await person(orgA, "tech", "tech-a");
    staffB = await person(orgB, "office", "staff-b");
    importA = (await one("select gen_random_uuid() as id")).id;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the company's staff write and read their own lines and rules", async () => {
    if (!ready()) return;
    await as(staffA);
    expect((await line(orgA, 1)).rowCount).toBe(1);
    const rule = await c.query(
      "insert into bank_rules (org_id, direction, merchant_key, choice, bucket, cost_kind, learned_import_id) values ($1, 'out', 'shell', 'cost', 'Gas & Truck', 'fuel', $2) returning id",
      [orgA, importA],
    );
    expect(rule.rowCount).toBe(1);
    expect((await c.query("select id from bank_lines")).rowCount).toBe(1);
    expect((await c.query("select id from bank_rules")).rowCount).toBe(1);
    await asServer();
  });

  it("a tech of the same company reads nothing and writes nothing", async () => {
    if (!ready()) return;
    await as(techA);
    expect((await c.query("select id from bank_lines")).rowCount).toBe(0);
    expect((await c.query("select id from bank_rules")).rowCount).toBe(0);
    expect(await refused("insert into bank_lines (org_id, import_id, line_key, posted_on, amount, choice, sorted_by) values ($1, $2, $3, '2001-01-03', -1, 'personal', 'person')", [orgA, importA, KEY(2)])).toBe("42501");
    expect((await c.query("update bank_rules set uses = 9")).rowCount).toBe(0);
    expect((await c.query("delete from bank_lines")).rowCount).toBe(0);
    await asServer();
  });

  it("another company's staff read nothing and change nothing; anon can't ask", async () => {
    if (!ready()) return;
    await as(staffB);
    expect((await c.query("select id from bank_lines")).rowCount).toBe(0);
    expect((await c.query("update bank_lines set description = 'x'")).rowCount).toBe(0);
    expect((await c.query("delete from bank_rules")).rowCount).toBe(0);
    // Writing a row INTO another company is refused outright.
    expect(await refused("insert into bank_rules (org_id, direction, merchant_key, choice) values ($1, 'out', 'dental', 'personal')", [orgA])).toBe("42501");
    await asServer();
    await c.query("set local role anon");
    expect(await refused("select id from bank_lines")).toBe("42501");
    await asServer();
    expect((await one("select count(*)::int as n from bank_lines where org_id = $1", [orgA])).n).toBe(1);
  });

  it("a line counts once per company; another company may hold the same key", async () => {
    if (!ready()) return;
    expect(await refused("insert into bank_lines (org_id, import_id, line_key, posted_on, amount, choice, sorted_by) values ($1, $2, $3, '2001-01-02', -12.5, 'personal', 'person')", [orgA, importA, KEY(1)])).toBe("23505");
    expect((await line(orgB, 1)).rowCount).toBe(1);
  });

  it("the database refuses a long number in a description, a $0 line, a cost with no bucket, and a kind off Gas & Truck", async () => {
    if (!ready()) return;
    expect(await refused("insert into bank_lines (org_id, import_id, line_key, posted_on, amount, description, choice, sorted_by) values ($1, $2, $3, '2001-01-02', -1, 'ACH 123456789', 'personal', 'person')", [orgA, importA, KEY(3)])).toBe("23514");
    expect(await refused("insert into bank_lines (org_id, import_id, line_key, posted_on, amount, description, choice, sorted_by) values ($1, $2, $3, '2001-01-02', -1, 'ACH ••6789', 'personal', 'person')", [orgA, importA, KEY(3)])).toBeNull();
    expect(await refused("insert into bank_lines (org_id, import_id, line_key, posted_on, amount, choice, sorted_by) values ($1, $2, $3, '2001-01-02', 0, 'personal', 'person')", [orgA, importA, KEY(4)])).toBe("23514");
    expect(await refused("insert into bank_lines (org_id, import_id, line_key, posted_on, amount, choice, sorted_by) values ($1, $2, $3, '2001-01-02', -1, 'cost', 'person')", [orgA, importA, KEY(5)])).toBe("23514");
    expect(await refused("insert into bank_lines (org_id, import_id, line_key, posted_on, amount, choice, bucket, cost_kind, sorted_by) values ($1, $2, $3, '2001-01-02', -1, 'cost', 'Fees', 'fuel', 'person')", [orgA, importA, KEY(6)])).toBe("23514");
    expect(await refused("insert into bank_lines (org_id, import_id, line_key, posted_on, amount, choice, sorted_by) values ($1, $2, 'not-a-key', '2001-01-02', -1, 'personal', 'person')", [orgA, importA])).toBe("23514");
    // A matched line may remember the fuel/truck tag it put on its bill (0365); nothing else may.
    expect(await refused("insert into bank_lines (org_id, import_id, line_key, posted_on, amount, choice, matched_kind, sorted_by) values ($1, $2, $3, '2001-01-02', -1, 'personal', 'fuel', 'person')", [orgA, importA, KEY(8)])).toBe("23514");
    expect(await refused("insert into bank_lines (org_id, import_id, line_key, posted_on, amount, choice, matched_kind, sorted_by) values ($1, $2, $3, '2001-01-02', -1, 'matched', 'fuel', 'match')", [orgA, importA, KEY(9)])).toBeNull();
    // A rule: money in may only say Not Income (Other Income is never a rule's); one rule per merchant
    // AND answer (a second answer for the same merchant is its own rule), each with a sane band.
    expect(await refused("insert into bank_rules (org_id, direction, merchant_key, choice) values ($1, 'out', 'venmo', 'other_income')", [orgA])).toBe("23514");
    expect(await refused("insert into bank_rules (org_id, direction, merchant_key, choice) values ($1, 'in', 'regular', 'other_income')", [orgA])).toBe("23514");
    expect(await refused("insert into bank_rules (org_id, direction, merchant_key, choice) values ($1, 'in', 'savings', 'not_income')", [orgA])).toBeNull();
    expect(await refused("insert into bank_rules (org_id, direction, merchant_key, choice, bucket, cost_kind) values ($1, 'out', 'shell', 'cost', 'Gas & Truck', 'fuel')", [orgA])).toBe("23505");
    expect(await refused("insert into bank_rules (org_id, direction, merchant_key, choice, min_cents, max_cents) values ($1, 'out', 'shell', 'personal', 100, 2000)", [orgA])).toBeNull();
    expect((await one("select answer from bank_rules where org_id = $1 and merchant_key = 'shell' and choice = 'cost'", [orgA])).answer).toBe("cost:Gas & Truck:fuel");
    expect(await refused("insert into bank_rules (org_id, direction, merchant_key, choice, min_cents, max_cents) values ($1, 'out', 'dental', 'personal', 500, 100)", [orgA])).toBe("23514");
    expect(await refused("insert into bank_rules (org_id, direction, merchant_key, choice, min_cents) values ($1, 'out', 'dental', 'personal', 500)", [orgA])).toBe("23514");
  });

  it("a bank download or a supplier's list in the tray is staff-only, even on a row a tech made (0365)", async () => {
    if (!ready()) return;
    const forged = JSON.stringify({ bankImport: { download: { v: 1, name: "x", last4: null, from: "2001-01-02", to: "2001-01-02", lines: [], skipped: [], header: [] } } });
    const list = JSON.stringify({ openList: { list: null, needs: null } });
    await as(techA);
    // A tech's own snapped receipt is as before.
    expect(await refused("insert into organized_items (org_id, title, created_by, status, proposal) values ($1, 'TEST 0365 receipt', $2, 'needs_review', '{}'::jsonb)", [orgA, techA])).toBeNull();
    expect((await c.query("select id from organized_items where title = 'TEST 0365 receipt'")).rowCount).toBe(1);
    // A row of their own carrying a bank download or a supplier's list is refused.
    expect(await refused("insert into organized_items (org_id, title, created_by, status, proposal) values ($1, 'TEST 0365 forged', $2, 'needs_review', $3::jsonb)", [orgA, techA, forged])).toBe("42501");
    expect(await refused("insert into organized_items (org_id, title, created_by, status, proposal) values ($1, 'TEST 0365 forged', $2, 'needs_review', $3::jsonb)", [orgA, techA, list])).toBe("42501");
    // Nor can they turn their receipt into one.
    expect(await refused("update organized_items set proposal = $1::jsonb where title = 'TEST 0365 receipt'", [forged])).toBe("42501");
    await asServer();
    // One staff made: the tech who made nothing of it never sees it, even as its creator.
    await c.query("insert into organized_items (org_id, title, created_by, status, proposal) values ($1, 'TEST 0365 bank', $2, 'needs_review', $3::jsonb)", [orgA, techA, forged]);
    await as(techA);
    expect((await c.query("select id from organized_items where title = 'TEST 0365 bank'")).rowCount).toBe(0);
    await asServer();
    await as(staffA);
    expect((await c.query("select id from organized_items where title = 'TEST 0365 bank'")).rowCount).toBe(1);
    await asServer();
  });

  it("deleting a line takes its mark off the money row (Undo)", async () => {
    if (!ready()) return;
    const lid = (await line(orgA, 7, { description: "HOME HARDWARE" })).rows[0].id;
    const bill = (
      await one(
        "insert into bills (org_id, job_id, supplier, amount, status, bill_date, category, cost_kind, bank_line_id) values ($1, null, 'TEST 0363 SHELL', 12.5, 'paid', '2001-01-02', 'Gas & Truck', 'fuel', $2) returning id",
        [orgA, lid],
      )
    ).id;
    // One line holds one bill.
    expect(
      await refused("insert into bills (org_id, job_id, supplier, amount, status, bill_date, category, bank_line_id) values ($1, null, 'TEST 0363 TWO', 1, 'paid', '2001-01-02', 'Other', $2)", [orgA, lid]),
    ).toBe("23505");
    await c.query("delete from bank_lines where id = $1", [lid]);
    expect((await one("select bank_line_id from bills where id = $1", [bill])).bank_line_id).toBeNull();
  });

  it("fuel rides only on a Gas & Truck business cost: re-filing it clears the kind, never fails", async () => {
    if (!ready()) return;
    const id = (await one("insert into bills (org_id, job_id, supplier, amount, status, bill_date, category, cost_kind) values ($1, null, 'TEST 0363 FUEL', 40, 'paid', '2001-01-03', 'Gas & Truck', 'fuel') returning id", [orgA])).id;
    expect((await one("select cost_kind from bills where id = $1", [id])).cost_kind).toBe("fuel");
    await c.query("update bills set category = 'Other' where id = $1", [id]);
    expect((await one("select cost_kind from bills where id = $1", [id])).cost_kind).toBeNull();
    const other = (await one("insert into bills (org_id, job_id, supplier, amount, status, bill_date, category, cost_kind) values ($1, null, 'TEST 0363 TRUCK', 40, 'paid', '2001-01-03', 'Tools & Supplies', 'truck') returning cost_kind", [orgA])).cost_kind;
    expect(other).toBeNull();
    expect(await refused("insert into bills (org_id, job_id, supplier, amount, status, bill_date, category, cost_kind) values ($1, null, 'TEST 0363 X', 1, 'paid', '2001-01-03', 'Gas & Truck', 'diesel')", [orgA])).toBe("23514");
  });
});
