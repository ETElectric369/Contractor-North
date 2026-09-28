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
 * conversion." 09-28, final: "street number and name as always".
 *
 *   the SQL twin   public.job_name_from answers every case in job-name.cases.ts exactly as
 *                  src/lib/job-name.ts jobNameFrom does, so the office's accept and the customer's
 *                  accept can never name one job two ways;
 *   the door       accepting an estimate for a customer at a street makes a job named for the street
 *                  number and name (" #<unit>" with the street's unit), whatever its title; with no
 *                  street, "<the customer> · <the title's words>"; never "Job from Q-00012".
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
        await c.query("select public.job_name_from($1, $2, $3, $4, $5, $6, $7, $8::date) as name", [
          k.typed,
          k.words,
          k.customer?.name ?? null,
          k.customer?.company_name ?? null,
          k.customer?.type ?? null,
          k.street,
          k.unit,
          k.today,
        ])
      ).rows[0].name;
      expect({ why: k.why, got }).toEqual({ why: k.why, got: k.want });
      expect(
        jobNameFrom({ typed: k.typed, sourceWords: k.words, customer: k.customer, street: k.street, unit: k.unit, todayStr: k.today }),
      ).toBe(got);
    }
  });

  /** A sent estimate for a TEST customer (at a TEST street unless `custAddress` is null); the customer
   *  taps Accept. Returns the job's name and unit. */
  const acceptAndName = async (
    title: string | null,
    o: { custAddress?: string | null; custUnit?: string | null; quoteAddress?: string | null; quoteUnit?: string | null } = {},
  ) => {
    const cust = (
      await c.query(
        "insert into public.customers (org_id, name, type, status, address, unit, created_by) values ($1, 'Rita TestMoss', 'residential', 'active', $2, $3, $4) returning id::text as id",
        [orgId, o.custAddress === undefined ? "12 Test Elm St" : o.custAddress, o.custUnit ?? null, ownerId],
      )
    ).rows[0].id as string;
    const token = `test-0369-${randomUUID()}`;
    const q = (
      await c.query(
        "insert into public.quotes (org_id, customer_id, title, status, public_token, address, unit, created_by) values ($1, $2, $3, 'sent', $4, $5, $6, $7) returning id::text as id",
        [orgId, cust, title, token, o.quoteAddress ?? null, o.quoteUnit ?? null, ownerId],
      )
    ).rows[0].id as string;
    const res = (await c.query("select public.accept_public_quote($1) as r", [token])).rows[0].r;
    expect(res).toMatchObject({ ok: true });
    const job = (
      await c.query("select j.name, j.unit, j.org_id::text as org_id from public.jobs j join public.quotes q on q.job_id = j.id where q.id = $1", [q])
    ).rows[0];
    expect(job.org_id).toBe(orgId);
    return job.name as string;
  };

  it("accepting an estimate for a customer at a street makes the street, never the tag or the person", async () => {
    expect(await acceptAndName("Estimate — Rita TestMoss")).toBe("12 Test Elm St");
    expect(await acceptAndName("Quote: Hot tub circuit")).toBe("12 Test Elm St");
    expect(await acceptAndName(null)).toBe("12 Test Elm St");
  });

  it("the street's own unit rides as #<unit>: the estimate's site with its unit, else the customer's", async () => {
    expect(await acceptAndName("Panel swap", { quoteAddress: "300 Test Lake Blvd", quoteUnit: "Unit 56", custUnit: "9" })).toBe("300 Test Lake Blvd #56");
    expect(await acceptAndName("Panel swap", { custUnit: "#4B" })).toBe("12 Test Elm St #4B");
  });

  it("no street: the customer as written, then the title's words, tag off; never 'Job from Q-…'", async () => {
    expect(await acceptAndName("Estimate — Panel Upgrade", { custAddress: null })).toBe("Rita TestMoss · Panel Upgrade");
    expect(await acceptAndName("Estimate — Rita TestMoss", { custAddress: null })).toBe("Rita TestMoss");
    expect(await acceptAndName(null, { custAddress: null })).toBe("Rita TestMoss");
  });

  it("the twin is not callable from outside the database, and there is only the one", async () => {
    const sig = "public.job_name_from(text, text, text, text, text, text, text, date)";
    const grants = (
      await c.query(
        `select has_function_privilege('anon', '${sig}', 'execute') as anon, has_function_privilege('authenticated', '${sig}', 'execute') as authed`,
      )
    ).rows[0];
    expect(grants).toEqual({ anon: false, authed: false });
    const n = (await c.query("select count(*)::int as n from pg_proc where proname = 'job_name_from' and pronamespace = 'public'::regnamespace")).rows[0].n;
    expect(n).toBe(1);
  });
});
