import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { laborLinePerson } from "@/lib/labor-claim-owner";

/**
 * HOURS STAY WITH THEIR PERSON (0361), where the boundary lives: the database.
 *
 * On ten of ET's paid invoices one man's labor line claimed the other man's shifts (0256's backfill,
 * once). The doors that could do it again are held here:
 *   · a line keyed labor:<person> (or a legacy labor:<person>:<n>) takes only that person's shifts,
 *     through a plain write, the importer's own RPC, or a legacy key; what it already holds is never
 *     re-judged by an unrelated edit;
 *   · an importer's line with no person key is not judged (its words are free text);
 *   · a shift a live invoice bills can't be handed to someone else; an unbilled one, or one only a
 *     void invoice names, can; an edit that keeps the person passes;
 *   · a split of a billed shift still carries the claim onto the same person's line (0288);
 *   · VOID, HAND ON, UN-VOID: a void invoice comes back only with each person's hours on their own
 *     line (keyed, or named by the line's words), in words; handed back, it comes back; a crew line
 *     comes back whatever it holds; a split of a shift only a void invoice holds is never refused;
 *   · ALREADY BILLED onto a line typed by hand: a line whose words name one person takes only that
 *     person's shifts (mark_already_billed, and any other write of a hand claim); a crew line (nobody
 *     named, or two people, even when one of them is named in full) takes anyone's;
 *   · labor_line_person reads every line exactly as the app's laborLinePerson does.
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
  /** First names, distinct (the fixture names everyone "TEST ..."), as a line's words use them. */
  let ownerFirst = "";
  let techFirst = "";
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
  /** A line typed by hand (import_source null: 0357 holds everything on it by hand), billed in hours. */
  const handLine = async (invoiceId: string, description: string, ids: string[] = []): Promise<string> =>
    (
      await one(
        `insert into public.invoice_items (org_id, invoice_id, import_source, import_key, description, quantity, unit, unit_price, source_ids)
         values ($1, $2, null, null, $3, 6, 'hr', 100, $4::uuid[]) returning id`,
        [orgId, invoiceId, description, ids],
      )
    ).id;
  const setStatus = (invoiceId: string, status: string) => c.query("update public.invoices set status = $2 where id = $1", [invoiceId, status]);
  const handOn = (entryId: string, to: string) => c.query("update public.time_entries set profile_id = $2 where id = $1", [entryId, to]);
  const unvoid = (invoiceId: string) => refusal("update public.invoices set status = 'sent' where id = $1", [invoiceId]);
  const mark = async (lineId: string, ids: string[]): Promise<string[]> =>
    (await one("select public.mark_already_billed($1, $2::uuid[]) as r", [lineId, ids])).r.added;
  const tryMark = (lineId: string, ids: string[]) => refusal("select public.mark_already_billed($1, $2::uuid[])", [lineId, ids]);

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
    techId = org.techs[0].id;
    // Names a line's words can tell apart (the fixture's are "TEST Owner <tag>" and "TEST Tech 1 <tag>":
    // one first name for both, which reads as a crew).
    ownerFirst = "Olive";
    techFirst = "Tobias";
    ownerName = `${ownerFirst} Q${run}`;
    techName = `${techFirst} Q${run}`;
    await c.query("update public.profiles set full_name = $2 where id = $1", [ownerId, ownerName]);
    await c.query("update public.profiles set full_name = $2 where id = $1", [techId, techName]);
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

  it("an importer's line with no person key is not judged: a crew line holds everyone's hours", async () => {
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

  it("void, hand the shift on, un-void: refused in words; handed back, it comes back", async () => {
    const o1 = await shift(ownerId, 10);
    const inv = await invoice("sent");
    const lineId = (await one(line(inv.id, `labor:${ownerId}`, `Labor - ${ownerName}`, [o1]))).id;

    await as(ownerId);
    await setStatus(inv.id, "void");
    // Only a void invoice holds it, so the office may hand it on (a void bill never pins a timecard).
    expect(await refusal("update public.time_entries set profile_id = $2 where id = $1", [o1, techId])).toBeNull();
    const back = await unvoid(inv.id);
    await asServer();
    expect(back?.message).toBe(
      `${inv.number}'s line for ${ownerName} now holds ${techName}'s 2/10 shift, so ${inv.number} can't come back from void. Hand the shift back to ${ownerName} in Timecards, or leave ${inv.number} void and bill the work on a fresh invoice. Nothing was changed.`,
    );
    expect((await one("select status from public.invoices where id = $1", [inv.id])).status).toBe("void");
    // The server is held too: this is a boundary, not a door.
    expect((await unvoid(inv.id))?.message).toMatch(/can't come back from void/);

    // Handed back, it comes back, holding what it held.
    await as(ownerId);
    await handOn(o1, ownerId);
    const again = await unvoid(inv.id);
    await asServer();
    expect(again).toBeNull();
    expect((await one("select status from public.invoices where id = $1", [inv.id])).status).toBe("sent");
    expect(await held(lineId)).toEqual([o1]);
  });

  it("a line typed by hand that names one person is held the same way at un-void; a crew line comes back whatever it holds", async () => {
    const t1 = await shift(techId, 11);
    const named = await invoice("sent");
    await handLine(named.id, `Labor - ${techFirst}`, [t1]);
    const o2 = await shift(ownerId, 12);
    const crew = await invoice("sent");
    await handLine(crew.id, "Labor - ET Electric hourly with 2 guys", [o2]);

    await setStatus(named.id, "void");
    await setStatus(crew.id, "void");
    await handOn(t1, ownerId);
    await handOn(o2, techId);
    expect((await unvoid(named.id))?.message).toBe(
      `${named.number}'s line for ${techName} now holds ${ownerName}'s 2/11 shift, so ${named.number} can't come back from void. Hand the shift back to ${techName} in Timecards, or leave ${named.number} void and bill the work on a fresh invoice. Nothing was changed.`,
    );
    expect(await unvoid(crew.id)).toBeNull();
    // A status change that is not a return from void is never judged here.
    expect(await refusal("update public.invoices set status = 'paid' where id = $1", [crew.id])).toBeNull();
  });

  it("a split of a shift only a void invoice holds is never refused, and the un-void still is", async () => {
    const o1 = await shift(ownerId, 13);
    const inv = await invoice("sent");
    const lineId = (await one(line(inv.id, `labor:${ownerId}`, `Labor - ${ownerName}`, [o1]))).id;
    await setStatus(inv.id, "void");
    await handOn(o1, techId);
    // 0313 appends the new piece to every void line that held the parent: a void claim is inert.
    await as(ownerId);
    const r = (await one("select public.split_time_entry($1, $2, $3, null, null, null) as r", [o1, "2001-02-13T19:00:00Z", jobId])).r;
    await asServer();
    expect(await held(lineId)).toEqual([o1, r.right_id]);
    expect((await unvoid(inv.id))?.message).toMatch(new RegExp(`^${inv.number}'s line for ${ownerName} now holds ${techName}'s 2/13 shift, so`));
  });

  it("Already Billed onto a line typed by hand: a line naming one person takes only that person's shifts; a crew line takes anyone's", async () => {
    const t1 = await shift(techId, 14);
    const o1 = await shift(ownerId, 14);
    const o2 = await shift(ownerId, 15);
    const t2 = await shift(techId, 15);
    const inv = await invoice("sent");
    const byFirst = await handLine(inv.id, `Labor - ${techFirst}`);
    const byFull = await handLine(inv.id, `Labor — ${ownerName}`);
    const crew = await handLine(inv.id, "Labor - ET Electric hourly with 2 guys");
    const both = await handLine(inv.id, `Labor - ${techFirst} and ${ownerFirst}`);

    await as(ownerId);
    // The owner's shift on the tech's line: refused in words, nothing changed.
    expect((await tryMark(byFirst, [t1, o1]))?.message).toBe(
      `"Labor - ${techFirst}" on ${inv.number} names ${techName}, so it holds only ${techName}'s hours, not ${ownerName}'s 2/14 shift. Nothing was changed.`,
    );
    expect(await held(byFirst)).toEqual([]);
    // His own: marked. A full name is read the same way.
    expect(await mark(byFirst, [t1])).toEqual([t1]);
    expect((await tryMark(byFull, [t2]))?.message).toBe(
      `"Labor — ${ownerName}" on ${inv.number} names ${ownerName}, so it holds only ${ownerName}'s hours, not ${techName}'s 2/15 shift. Nothing was changed.`,
    );
    expect(await mark(byFull, [o2])).toEqual([o2]);
    // A crew line (nobody named, or two people) takes anyone's.
    expect(await mark(crew, [o1])).toEqual([o1]);
    expect(await mark(both, [t2])).toEqual([t2]);

    // Any other writer of a hand claim is held the same way (a line typed by hand holds everything by hand).
    const t3 = await shift(techId, 16);
    const o3 = await shift(ownerId, 16);
    expect((await refusal("update public.invoice_items set source_ids = source_ids || $2::uuid where id = $1", [byFirst, o3]))?.message).toBe(
      `"Labor - ${techFirst}" on ${inv.number} names ${techName}, so it holds only ${techName}'s hours, not ${ownerName}'s 2/16 shift. Nothing was changed.`,
    );
    expect(await refusal("update public.invoice_items set source_ids = source_ids || $2::uuid where id = $1", [byFirst, t3])).toBeNull();
    await asServer();
    // The server too, on a new line.
    expect(
      (
        await refusal("insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price, source_ids) values ($1, $2, $3, 1, 50, $4::uuid[])", [
          orgId,
          inv.id,
          `Labor ${techFirst}`,
          [o3],
        ])
      )?.message,
    ).toMatch(new RegExp(`^"Labor ${techFirst}" on ${inv.number} names ${techName}, so`));
  });

  it("a line naming two people, one of them in full, is a crew line: either one's shift is marked, and it comes back from void", async () => {
    const o1 = await shift(ownerId, 17);
    const t1 = await shift(techId, 17);
    const inv = await invoice("sent");
    const firstAndFull = await handLine(inv.id, `Labor - ${ownerFirst} & ${techName}`);
    const fullAndFirst = await handLine(inv.id, `Labor - ${ownerName} with ${techFirst}`);

    await as(ownerId);
    // The owner's shift on a line that names the tech in full and the owner by first name: marked.
    expect(await mark(firstAndFull, [o1])).toEqual([o1]);
    // And the tech's shift on the mirror of it.
    expect(await mark(fullAndFirst, [t1])).toEqual([t1]);
    await asServer();

    // A void invoice's such line, one shift of each person on it, comes back: nobody's hours to hand back.
    const o2 = await shift(ownerId, 18);
    const t2 = await shift(techId, 18);
    const dead = await invoice("void");
    const deadLine = await handLine(dead.id, `Labor - ${ownerFirst} & ${techName}`, [o2, t2]);
    await as(ownerId);
    const back = await unvoid(dead.id);
    await asServer();
    expect(back).toBeNull();
    expect(await held(deadLine)).toEqual([o2, t2]);
  });

  it("labor_line_person reads every line exactly as the app's laborLinePerson does", async () => {
    const people = (await c.query("select id::text as id, full_name as name from public.profiles where org_id = $1", [orgId])).rows as { id: string; name: string }[];
    const lines: { import_key: string | null; description: string }[] = [
      { import_key: null, description: `Labor - ${techFirst}` },
      { import_key: null, description: `Labor — ${techName}` },
      { import_key: null, description: `LABOR: ${techFirst.toUpperCase()}` },
      { import_key: null, description: `Labor - ${techFirst}sen` },
      { import_key: null, description: `Labor - ${techFirst}_2` },
      { import_key: null, description: `Labor - ${techFirst} and ${ownerFirst}` },
      { import_key: null, description: `Labor - ${ownerName} with ${techFirst}` },
      { import_key: null, description: `Labor - ${ownerFirst} & ${techName}` },
      { import_key: null, description: `Labor - ${ownerName} (${ownerFirst}'s hours)` },
      { import_key: null, description: `Labor - ${techName}, ${techName}` },
      { import_key: null, description: `Labor - ${ownerFirst}  Q${run}` },
      { import_key: null, description: "Labor - ET Electric hourly with 2 guys" },
      { import_key: null, description: "" },
      { import_key: `labor:${techId}`, description: `Labor - ${ownerFirst}` },
      { import_key: `labor:${techId}:3`, description: "Labor" },
      { import_key: "labor:unknown", description: `Labor - ${ownerFirst}` },
      { import_key: `bill:${techId}`, description: `Materials - ${techFirst} pickup` },
      { import_key: `labor:${techId.toUpperCase()}`, description: "Crew" },
    ];
    for (const l of lines) {
      const db = (await one("select public.labor_line_person($1, $2, $3)::text as p", [l.import_key, l.description, orgId])).p;
      expect({ line: l, person: db }).toEqual({ line: l, person: laborLinePerson(l, people) });
    }
    // Not only the same answer, the right one: two people, one of them in full, is a crew line on both
    // sides; one person named twice over is that person.
    const person = async (description: string) => {
      const db = (await one("select public.labor_line_person(null, $1, $2)::text as p", [description, orgId])).p;
      return { app: laborLinePerson({ import_key: null, description }, people), db };
    };
    expect(await person(`Labor - ${ownerFirst} & ${techName}`)).toEqual({ app: null, db: null });
    expect(await person(`Labor - ${ownerName} with ${techFirst}`)).toEqual({ app: null, db: null });
    expect(await person(`Labor - ${ownerName} (${ownerFirst}'s hours)`)).toEqual({ app: ownerId, db: ownerId });
  });
});
