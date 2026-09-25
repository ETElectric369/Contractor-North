import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeBreaker } from "./breaker-catalog";

/**
 * Migration 0334 — THE CREW SEES WHAT BREAKERS CAME, exercised where the boundary lives.
 *
 * The Breakers card needs the job's tickets for the crew too, and bills are staff-only (0056). The
 * door is breakers_bought_for_job: descriptions and quantities, never a price, supplier or bill
 * number; an active member of the job's own org only; only this job's live goods (not a replaced
 * counter receipt, not a statement, not a line that went on the shelf). This speaks to the database
 * AS a tech and AS staff (the 0254 suite's pattern: `set local role authenticated` + planted claims,
 * borrowing an existing active tech and staff member of one org), builds its own customer / jobs /
 * tickets / other org around them, and rolls the whole transaction back.
 *
 * Until 0334 is applied it is applied HERE, inside the test's own transaction, which is rolled back.
 * Creating a function takes no lock a user's query waits on (it reads jobs, bills and
 * bill_line_items to check the body, an ACCESS SHARE lock), so unlike 0333 it needs no opt-in.
 * lock_timeout 3s, statement_timeout 15s: it never waits on anyone for long.
 *
 * Same creds gate as the other DB suites; skips cleanly without them.
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

/** Every line the reader's tests read (breaker-catalog.test.ts), as they would sit on a ticket. */
const EVERY_LINE = [
  "SIEM Q2100 2P 100A 120/240V CB",
  "1P 20A CKT BRKR GFCI (SIEM QF120AN)",
  "SP 15A 120/240V CB (Q115)",
  "SP 20A 120/240V CB (Q120)",
  "SP 20A 120/240V CB (SIEM Q120)",
  "SP 20A 120/240V CB",
  "2P 30A 120/240V CB (Q230)",
  "2P 50A 120/240V CB (Q250)",
  "2P 20A 120/240 plug-in CB",
  "2P 30A 120/240V CB",
  "2P 50A 120/240V CB",
  "SQD HOM120 Miniature Circuit",
  "SQD HOMT1515 Miniature Circuit",
  "SQD HOMT2020 Miniature Circuit",
  "SQD HOMT230250 Miniature Ckt Brkr",
  "20a twin breaker",
  "Quad 2p - 30a - 1p-15s breaker",
  "SIEM Q22020CT2",
  "SIEM Q22030CT",
  "20A breaker",
  "Eaton BR230",
  "GE THQL1120",
  "QSA2020SPD",
  "12/24CT 125A N3R Load Center",
  "ITE PN1632L1125C 125A Plug On Neutral Load Center",
  "1P 120V SEN SWITCH",
  "PS TM870W WHT 1P15A125V SW",
  "PS 3864 30A 125/250 Recpt",
  "Heat Shrink Tube 3/8 in 3P",
  "Tax @ 9.00000%",
  "NMB 12/2 w/gnd 250 ft coil",
];

d("breakers_bought_for_job: what the crew may read from a job's tickets (0334)", () => {
  let client: pg.Client;
  let orgId = "";
  let techId = "";
  let staffId = "";
  let jobId = "";
  let gateJobId = "";
  let otherJobId = "";

  const as = async (uid: string) => {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await client.query("set local role authenticated");
  };
  const asServer = async () => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', '', true)");
  };
  const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0];
  const bill = async (job: string, org: string, extra: Record<string, unknown>, lines: [string, number, number][]) => {
    const cols = ["org_id", "job_id", "supplier", "amount", "status", "bill_date", ...Object.keys(extra)];
    const vals = [org, job, "TEST 0334 SUPPLIER", 0, "unpaid", "2001-01-02", ...Object.values(extra)];
    const b = await one(`insert into public.bills (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, vals);
    for (const [i, [description, quantity, amount]] of lines.entries()) {
      await client.query(
        "insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, sort_order) values ($1, $2, $3, $4, $5, $6, $7)",
        [org, b.id, description, quantity, quantity ? amount / quantity : 0, amount, i],
      );
    }
    return b.id as string;
  };
  const bought = async (job: string) =>
    (await client.query("select description, qty::float as qty from public.breakers_bought_for_job($1) order by description", [job])).rows as { description: string; qty: number }[];

  beforeAll(async () => {
    client = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    await client.query("set local lock_timeout = '3s'");
    await client.query("set local statement_timeout = '15s'");
    const { rows: [has] } = await client.query("select to_regprocedure('public.breakers_bought_for_job(uuid)') is not null as yes");
    if (!has.yes) {
      await client.query(readFileSync(fileURLToPath(new URL("../../../supabase/migrations/0334_the_crew_sees_what_breakers_came.sql", import.meta.url)), "utf8"));
      console.warn("[breakers] 0334 is not on this database yet; applied inside the test's own transaction, which is rolled back.");
    }

    const { rows: fx } = await client.query(
      `select t.org_id, t.id as tech_id, s.id as staff_id
         from profiles t
         join profiles s on s.org_id = t.org_id and s.role in ('owner','admin','office') and s.active
        where t.role = 'tech' and t.active
        limit 1`,
    );
    if (!fx.length) throw new Error("0334 test fixture: no org has both an active tech and an active staff member.");
    ({ org_id: orgId, tech_id: techId, staff_id: staffId } = fx[0]);

    const cust = await one("insert into customers (org_id, name) values ($1, 'TEST 0334 cust') returning id", [orgId]);
    const job = (n: string) =>
      one(`insert into jobs (org_id, name, job_number, status, billing_type, customer_id) values ($1, $2, $3, 'scheduled', 'tm', $4) returning id`, [
        orgId,
        `TEST 0334 ${n}`,
        `TEST-0334-${n}`,
        cust.id,
      ]);
    jobId = (await job("J1")).id;
    gateJobId = (await job("J2")).id;

    // J-011's ticket, as CED wrote it.
    await bill(jobId, orgId, { bill_number: "TEST-8802-SO" }, [
      ["LUT MSOPS5MWH 1P Sensor Switch", 1, 32.46],
      ["SIEM Q2020 SP 20/20A 120/240V CB", 8, 184.88],
      ["SIEM Q21530CT", 1, 58.79],
      ["PS 3864 30A 125/250 Recpt", 1, 12.0],
      ["Tax @ 9.00000%", 1, 25.0],
    ]);
    // Not this job's goods: a counter receipt the invoice replaced, and a statement. (A line that
    // went on the shelf, is_stock, can only be marked by the shelf's own door with a lot on the
    // shelf, 0303, so it isn't built here; the function's filter on it is read in the migration.)
    const invoice = await bill(jobId, orgId, {}, []);
    await bill(jobId, orgId, { superseded_by_bill_id: invoice }, [["2P 20A 120/240V CB (Q220)", 1, 18.76]]);
    await bill(jobId, orgId, { is_statement: true }, [["SP 20A 120/240V CB (Q120)", 4, 38.24]]);
    // A return nets off what it returns.
    await bill(jobId, orgId, {}, [
      ["SQD HOM120 Miniature Circuit", 3, 23.13],
      ["SQD HOM120 Miniature Circuit", -3, -23.13],
    ]);
    // The gate job: every line the reader knows.
    await bill(gateJobId, orgId, {}, EVERY_LINE.map((l) => [l, 1, 1] as [string, number, number]));

    const other = await one("insert into organizations (name) values ('TEST 0334 other org') returning id");
    const ocust = await one("insert into customers (org_id, name) values ($1, 'TEST 0334 other cust') returning id", [other.id]);
    otherJobId = (
      await one(`insert into jobs (org_id, name, job_number, status, billing_type, customer_id) values ($1, 'TEST 0334 other', 'TEST-0334-O', 'scheduled', 'tm', $2) returning id`, [
        other.id,
        ocust.id,
      ])
    ).id;
    await bill(otherJobId, other.id, {}, [["SIEM Q2020 SP 20/20A 120/240V CB", 5, 115.55]]);
  }, 60000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("a tech gets the ticket's breakers, by description and count, and nothing else", async () => {
    await as(techId);
    expect(await bought(jobId)).toEqual([
      { description: "SIEM Q2020 SP 20/20A 120/240V CB", qty: 8 },
      { description: "SIEM Q21530CT", qty: 1 },
    ]);
    const { fields } = await client.query("select * from public.breakers_bought_for_job($1)", [jobId]);
    expect(fields.map((f) => f.name)).toEqual(["description", "qty"]);
    // The door is the only way in: the bills themselves stay the office's.
    const direct = await client.query("select count(*)::int as n from public.bills where job_id = $1", [jobId]);
    expect(direct.rows[0].n).toBe(0);
  });

  it("the office counts the same breakers from the same door", async () => {
    await as(staffId);
    expect(await bought(jobId)).toEqual([
      { description: "SIEM Q2020 SP 20/20A 120/240V CB", qty: 8 },
      { description: "SIEM Q21530CT", qty: 1 },
    ]);
  });

  it("another org's job answers nothing, to anyone; anon can't run it at all", async () => {
    await as(techId);
    expect(await bought(otherJobId)).toEqual([]);
    await as(staffId);
    expect(await bought(otherJobId)).toEqual([]);
    await asServer();
    const acl = await one("select has_function_privilege('anon', 'public.breakers_bought_for_job(uuid)', 'execute') as anon_can_run");
    expect(acl.anon_can_run).toBe(false);
  });

  it("the gate lets through every line the reader calls a breaker (or can't read), and no switch, tax or wire", async () => {
    await as(techId);
    const got = new Set((await bought(gateJobId)).map((r) => r.description));
    for (const line of EVERY_LINE) {
      const kind = decodeBreaker(line).kind;
      if (kind !== "not_breaker") expect(got.has(line), `${line} (${kind}) was dropped by the gate`).toBe(true);
    }
    for (const line of ["1P 120V SEN SWITCH", "PS 3864 30A 125/250 Recpt", "Tax @ 9.00000%", "NMB 12/2 w/gnd 250 ft coil", "Heat Shrink Tube 3/8 in 3P"]) {
      // The gate may be wider than the reader, but these five words never read as a breaker.
      if (got.has(line)) expect(decodeBreaker(line).kind, line).toBe("not_breaker");
    }
    expect(got.has("Tax @ 9.00000%")).toBe(false);
    expect(got.has("NMB 12/2 w/gnd 250 ft coil")).toBe(false);
  });

  it("a deactivated tech gets nothing", async () => {
    await asServer();
    await client.query("savepoint deactivate");
    try {
      await client.query("update public.profiles set active = false where id = $1", [techId]);
      await as(techId);
      expect(await bought(jobId)).toEqual([]);
    } finally {
      await asServer();
      await client.query("rollback to savepoint deactivate");
    }
  });
});
