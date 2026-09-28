import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { jobNameFrom } from "@/lib/job-name";
import { JOB_NAME_CASES } from "@/lib/job-name.cases";

/**
 * A JOB'S NAME IS NEVER WHERE IT CAME FROM (0369), where the database makes a job: a customer taps
 * Accept on the emailed estimate (accept_public_quote). Erik 2026-09-27: "site inspections are
 * labeled with the tag they shouldnt carry site inspection in the job title same goes for any
 * conversion."
 *
 *   the SQL twin   public.job_name_from answers every case in job-name.cases.ts exactly as
 *                  src/lib/job-name.ts jobNameFrom does, so the office's accept and the customer's
 *                  accept can never name one job two ways;
 *   the door       accepting "Estimate — <the customer>" makes a job named "<last name> · <street>";
 *                  an estimate with real words keeps them; one with no title is no longer
 *                  "Job from Q-00012".
 *
 * Everything happens inside ONE transaction that is always rolled back, on a throwaway company. 0369
 * is applied inside that transaction (the file on this branch, so what is asserted is what ships).
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const M0369 = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0369_"))!), "utf8");

d("a job's name is never where it came from (0369)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let ownerId = "";

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (!ready) return ctx.skip();
      await fn();
    });

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    await c.query("set local statement_timeout = '30s'");
    const org = await mintThrowawayOrg(c, { label: "0369 job names", techs: 0 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    await c.query(M0369);
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the SQL twin names every case exactly as jobNameFrom does", async () => {
    for (const k of JOB_NAME_CASES) {
      const got = (
        await c.query("select public.job_name_from($1, $2, $3, $4, $5, $6::date) as name", [
          k.title,
          k.customer?.name ?? null,
          k.customer?.company_name ?? null,
          k.customer?.type ?? null,
          k.street,
          k.today,
        ])
      ).rows[0].name;
      expect({ why: k.why, got }).toEqual({ why: k.why, got: k.want });
      expect(jobNameFrom({ title: k.title, customer: k.customer, street: k.street, todayStr: k.today })).toBe(got);
    }
  });

  /** A sent estimate for a TEST customer at a TEST street; the customer taps Accept. Returns the job's name. */
  const acceptAndName = async (title: string | null) => {
    const cust = (
      await c.query(
        "insert into public.customers (org_id, name, type, status, address, created_by) values ($1, 'Rita TestMoss', 'residential', 'active', '12 Test Elm St', $2) returning id::text as id",
        [orgId, ownerId],
      )
    ).rows[0].id as string;
    const token = `test-0369-${randomUUID()}`;
    const q = (
      await c.query(
        "insert into public.quotes (org_id, customer_id, title, status, public_token, created_by) values ($1, $2, $3, 'sent', $4, $5) returning id::text as id",
        [orgId, cust, title, token, ownerId],
      )
    ).rows[0].id as string;
    const res = (await c.query("select public.accept_public_quote($1) as r", [token])).rows[0].r;
    expect(res).toMatchObject({ ok: true });
    const job = (
      await c.query("select j.name, j.org_id::text as org_id from public.jobs j join public.quotes q on q.job_id = j.id where q.id = $1", [q])
    ).rows[0];
    expect(job.org_id).toBe(orgId);
    return job.name as string;
  };

  it("accepting 'Estimate — <the customer>' makes '<last name> · <street>', never the tag", async () => {
    expect(await acceptAndName("Estimate — Rita TestMoss")).toBe("TestMoss · 12 Test Elm St");
  });

  it("an estimate with real words keeps them, tag off; one with no title is never 'Job from Q-…'", async () => {
    expect(await acceptAndName("Quote: Hot tub circuit")).toBe("Hot tub circuit");
    expect(await acceptAndName("Panel swap")).toBe("Panel swap");
    expect(await acceptAndName(null)).toBe("TestMoss · 12 Test Elm St");
  });

  it("the twin is not callable from outside the database", async () => {
    const grants = (
      await c.query(
        "select has_function_privilege('anon', 'public.job_name_from(text, text, text, text, text, date)', 'execute') as anon, has_function_privilege('authenticated', 'public.job_name_from(text, text, text, text, text, date)', 'execute') as authed",
      )
    ).rows[0];
    expect(grants).toEqual({ anon: false, authed: false });
  });
});
