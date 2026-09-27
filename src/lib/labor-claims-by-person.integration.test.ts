import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * HOURS STAY WITH THEIR PERSON (0361), where the boundary lives: the database.
 *
 * On ten of ET's paid invoices one man's labor line claimed the other man's shifts (0256's backfill,
 * once). The doors that could do it again are held here:
 *   · a line keyed labor:<person> (or a legacy labor:<person>:<n>) takes only that person's shifts,
 *     through a plain write, the importer's own RPC, or a legacy key; what it already holds is never
 *     re-judged by an unrelated edit;
 *   · a hand-typed line is not judged (its words are free text: a crew line holds everyone's hours);
 *   · a shift a live invoice bills can't be handed to someone else; an unbilled one, or one only a
 *     void invoice names, can; an edit that keeps the person passes;
 *   · a split of a billed shift still carries the claim onto the same person's line (0288).
 *
 * Everything happens inside ONE transaction that is always rolled back, on a throwaway company
 * (lib/throwaway-org.db-fixture); every case in its own savepoint. Fixture shifts sit in 2001.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [LABOR_CLAIMS_APPLY_0361=1] npx vitest run <this file>
 * (LABOR_CLAIMS_APPLY_0361=1 applies 0361 inside the rolled-back transaction when the database doesn't
 * have it yet. Its CREATE TRIGGERs hold locks on time_entries and invoice_items until the rollback, so
 * it is opt-in; without it such a run waits, loudly, and CI fails it.)
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, LABOR_CLAIMS_APPLY_0361 } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const M0361 = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0361_"))!), "utf8");

d("hours stay with their person (0361)", () => {
  let c: pg.Client;
  let waiting = false;
  let orgId = "";
  let ownerId = "";
  let ownerName = "";
  let techId = "";
  let techName = "";
  let jobId = "";
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (waiting) return ctx.skip();
      await c.query("savepoint step");
      try {
        await fn();
      } finally {
        await c.query("rollback to savepoint step");
        await asServer();
      }
    });
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** The refusal (message, hint) of a statement that should fail, or null when it went through. */
  const refusal = async (sql: string, params: unknown[] = []): Promise<{ message: string; hint?: string } | null> => {
    await c.query("savepoint attempt");
    try {
      await c.query(sql, params);
      await c.query("release savepoint attempt");
      return null;
    } catch (e: any) {
      await c.query("rollback to savepoint attempt");
      return { message: String(e?.message ?? e), hint: e?.hint };
    }
  };

  const shift = async (who: string, day: number): Promise<string> =>
    (
      await one(
        `insert into public.time_entries (org_id, profile_id, job_id, clock_in, clock_out, lunch_minutes, status, source)
         values ($1, $2, $3, $4, $5, 0, 'closed', 'manual') returning id`,
        [orgId, who, jobId, `2001-02-${String(day).padStart(2, "0")}T16:00:00Z`, `2001-02-${String(day).padStart(2, "0")}T22:00:00Z`],
      )
    ).id;
  const invoice = async (status: "draft" | "sent" | "void" = "sent"): Promise<{ id: string; number: string }> => {
    const number = `TEST-0361-${run}-${++seq}`;
    const r = await one(
      `insert into public.invoices (org_id, job_id, invoice_number, status, total, amount_paid) values ($1, $2, $3, $4, 100, 0) returning id`,
      [orgId, jobId, number, status],
    );
    return { id: r.id, number };
  };
  const line = (invoiceId: string, key: string | null, description: string, ids: string[]) =>
    `insert into public.invoice_items (org_id, invoice_id, import_source, import_key, description, quantity, unit, unit_price, source_ids)
     values ('${orgId}', '${invoiceId}', 'labor', ${key ? `'${key}'` : "null"}, '${description.replace(/'/g, "''")}', 6, 'hr', 100, '{${ids.join(",")}}'::uuid[])
     returning id`;
  const held = async (lineId: string): Promise<string[]> => (await one("select source_ids from public.invoice_items where id = $1", [lineId])).source_ids;

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '30s'");
    const have = await one(
      `select to_regprocedure('public.guard_billed_time_entry_person()') is not null
          and to_regprocedure('public.guard_labor_claim_person()') is not null as ok`,
    );
    if (!have.ok && LABOR_CLAIMS_APPLY_0361 === "1") {
      await c.query(M0361);
      console.warn("[labor-claims-by-person] 0361 is not on this database yet; applied inside the test's own transaction, which is rolled back.");
    } else if (!have.ok) {
      waiting = !notOnThisDatabase("[labor-claims-by-person] 0361 is not on this database yet: run node scripts/test-db/rebuild.cjs.");
      if (waiting) return;
    }

    const org = await mintThrowawayOrg(c, { label: "0361 hours by person", techs: 1 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    ownerName = org.owner.name;
    techId = org.techs[0].id;
    techName = org.techs[0].name;
    jobId = (
      await one(`insert into public.jobs (org_id, name, job_number, status, billing_type) values ($1, 'TEST 0361 job', $2, 'scheduled', 'tm') returning id`, [
        orgId,
        `TEST-0361-${run}`,
      ])
    ).id;
  });

  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("a line keyed to a person takes that person's shifts, and only theirs", async () => {
    const t1 = await shift(techId, 1);
    const t2 = await shift(techId, 2);
    const o1 = await shift(ownerId, 1);
    const inv = await invoice("draft");

    // The tech's own shift: in. The owner's, on the tech's line: refused, both men named in words.
    const lineId = (await one(line(inv.id, `labor:${techId}`, `Labor - ${techName}`, [t1]))).id;
    expect(await held(lineId)).toEqual([t1]);
    const wrongInsert = await refusal(line(inv.id, `labor:${techId}`, `Labor - ${techName} again`, [t2, o1]));
    expect(wrongInsert?.message).toBe(`Those hours are ${ownerName}'s, so they can't go on Labor - ${techName} again`);
    expect(wrongInsert?.hint).toBe("A labor line holds only its own person's hours. Put them on that person's line. Nothing was changed.");

    // Adding: his own second shift joins; the owner's never does, and the line is as it was.
    expect(await refusal("update public.invoice_items set source_ids = source_ids || $2::uuid where id = $1", [lineId, o1])).toMatchObject({
      message: `Those hours are ${ownerName}'s, so they can't go on Labor - ${techName}`,
    });
    expect(await held(lineId)).toEqual([t1]);
    expect(await refusal("update public.invoice_items set source_ids = source_ids || $2::uuid where id = $1", [lineId, t2])).toBeNull();
    expect(await held(lineId)).toEqual([t1, t2]);

    // The office's own session is held the same way (RLS lets staff write lines; the trigger still judges).
    await as(ownerId);
    const asOffice = await refusal("update public.invoice_items set source_ids = source_ids || $2::uuid where id = $1", [lineId, o1]);
    await asServer();
    expect(asOffice?.message).toMatch(/^Those hours are .+'s, so they can't go on/);

    // Re-keying a line onto another person is judged whole: the tech's shifts don't become the owner's line.
    expect((await refusal("update public.invoice_items set import_key = $2 where id = $1", [lineId, `labor:${ownerId}`]))?.message).toBe(
      `Those hours are ${techName}'s, so they can't go on Labor - ${techName}`,
    );
  });

  it("the importer's own door and a legacy overflow key are held the same way", async () => {
    const t1 = await shift(techId, 3);
    const o1 = await shift(ownerId, 3);
    const inv = await invoice("draft");
    const rows = (ids: string[]) =>
      JSON.stringify([{ import_key: `labor:${techId}`, description: `Labor - ${techName}`, quantity: 6, unit: "hr", unit_price: 100, source_ids: ids }]);
    const crossed = await refusal("select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb)", [inv.id, rows([t1, o1])]);
    expect(crossed?.message).toBe(`Those hours are ${ownerName}'s, so they can't go on Labor - ${techName}`);
    expect(await refusal("select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb)", [inv.id, rows([t1])])).toBeNull();
    // An importer refresh re-sending what the line holds adds nothing, so it is never re-judged.
    expect(await refusal("select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb)", [inv.id, rows([t1])])).toBeNull();

    const legacy = await refusal(line(inv.id, `labor:${techId}:2`, `Labor - ${techName}`, [o1]));
    expect(legacy?.message).toBe(`Those hours are ${ownerName}'s, so they can't go on Labor - ${techName}`);
  });

  it("a hand-typed line is not judged: a crew line holds everyone's hours", async () => {
    const t1 = await shift(techId, 4);
    const o1 = await shift(ownerId, 4);
    const inv = await invoice("sent");
    expect(await refusal(line(inv.id, null, "Labor - hourly with 2 guys", [t1, o1]))).toBeNull();
    // A key that is not a person's (labor:unknown, a name) is not judged either.
    const inv2 = await invoice("sent");
    const t2 = await shift(techId, 5);
    const o2 = await shift(ownerId, 5);
    expect(await refusal(line(inv2.id, "labor:unknown", "Labor - Crew", [t2, o2]))).toBeNull();
  });

  it("a shift a live invoice bills keeps its person; unbilled or void-billed shifts, and edits that keep the person, pass", async () => {
    const billed = await shift(ownerId, 6);
    const free = await shift(ownerId, 7);
    const onVoid = await shift(ownerId, 8);
    const live = await invoice("sent");
    await one(line(live.id, `labor:${ownerId}`, `Labor - ${ownerName}`, [billed]));
    const dead = await invoice("void");
    await one(line(dead.id, `labor:${ownerId}`, `Labor - ${ownerName}`, [onVoid]));

    // The office hands the owner's billed shift to the tech (the Timecards Team Member picker): refused.
    await as(ownerId);
    const moved = await refusal("update public.time_entries set profile_id = $2 where id = $1", [billed, techId]);
    const notes = await refusal("update public.time_entries set notes = 'panel swap' where id = $1", [billed]);
    const freeMove = await refusal("update public.time_entries set profile_id = $2 where id = $1", [free, techId]);
    const voidMove = await refusal("update public.time_entries set profile_id = $2 where id = $1", [onVoid, techId]);
    await asServer();
    expect(moved?.message).toBe(`${live.number} already bills this shift as ${ownerName}'s hours`);
    expect(moved?.hint).toBe(`Void or adjust ${live.number} before handing the shift to someone else. Nothing was changed.`);
    expect((await one("select profile_id from public.time_entries where id = $1", [billed])).profile_id).toBe(ownerId);
    expect(notes).toBeNull();
    expect(freeMove).toBeNull();
    expect(voidMove).toBeNull();
    expect((await one("select profile_id from public.time_entries where id = $1", [free])).profile_id).toBe(techId);

    // The server is held too: this is a boundary, not a door.
    expect((await refusal("update public.time_entries set profile_id = $2 where id = $1", [billed, techId]))?.message).toBe(
      `${live.number} already bills this shift as ${ownerName}'s hours`,
    );
  });

  it("a split of a billed shift carries its claim onto the same person's keyed line (0288 still works)", async () => {
    const t1 = await shift(techId, 9);
    const inv = await invoice("sent");
    const lineId = (await one(line(inv.id, `labor:${techId}`, `Labor - ${techName}`, [t1]))).id;
    await as(ownerId);
    const r = (await one("select public.split_time_entry($1, $2, $3, null, null, null) as r", [t1, "2001-02-09T19:00:00Z", jobId])).r;
    await asServer();
    expect(r.left_id).toBe(t1);
    expect(await held(lineId)).toEqual([t1, r.right_id]);
  });
});
