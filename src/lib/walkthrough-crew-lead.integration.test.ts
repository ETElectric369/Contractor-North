import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * A CREW LEAD FILLS IN THE WALK-THROUGH (0356), where the boundary lives: the database.
 *
 * Erik (2026-09-26): "crew leader yes tech no". The page and the server actions decide who gets the
 * editable Inspector; this proves the database says the same thing when somebody skips both and
 * calls PostgREST with the anon key and their own session:
 *
 *   · a crew lead ON the visit saves the capture (notes, a photo of this visit) and the answers
 *     through save_walkthrough_capture; quote_id stays the office's;
 *   · he cannot take a photo off, add one from another folder or one he didn't upload himself (so a
 *     photo the office took off stays off, though its file is still in the folder), touch a priced answer (add, change or
 *     clear), take a file off a file question (he adds only his own uploads), switch or clear a
 *     saved sheet, or name a form that isn't a walk-through sheet;
 *   · a crew lead NOT on the visit, a plain tech (who can READ his visit under 0227), another
 *     company's crew lead and a deactivated crew lead are all refused, and nothing moves;
 *   · the function writes only the capture columns, and a crew lead has no UPDATE on appointments;
 *   · crew_lead itself is the office's: a tech can't hand it to himself (it was self-service before
 *     0356) and a crew lead can't drop it; the owner can; other self-edits still work;
 *   · with nothing to save it writes nothing and only answers may / may not (the page's probe);
 *   · anon can't call it.
 *
 * Everything happens inside ONE transaction that is always rolled back, on throwaway companies
 * (lib/throwaway-org.db-fixture). People speak by planted request.jwt.claims under
 * `set local role authenticated`; refusals run inside savepoints so the transaction lives on, and
 * every check reads back what landed (a policy-hidden UPDATE is a clean 0 rows: the silent-write law).
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [CREWLEAD_APPLY_0356=1] npx vitest run <this file>
 * (CREWLEAD_APPLY_0356=1 applies 0356 inside the rolled-back transaction when the database doesn't
 * have it yet. Its CREATE TRIGGER holds a lock on profiles until the rollback, so it is opt-in;
 * without it such a run waits, loudly, and CI fails it.)
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, CREWLEAD_APPLY_0356 } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const M0356 = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0356_"))!), "utf8");
const FN = "public.save_walkthrough_capture(uuid, jsonb, uuid, jsonb)";

d("a crew lead fills in the walk-through (0356)", () => {
  let c: pg.Client;
  let waiting = false;
  let orgId = "";
  let ownerId = "";
  let leadId = ""; // the crew lead on visit A and E
  let lead2Id = ""; // a crew lead on visit B only
  let techId = ""; // a plain tech on visit C
  let goneId = ""; // a deactivated crew lead on visit D
  let otherLeadId = ""; // another company's crew lead, on visit O
  let sheetId = "";
  let sheet2Id = "";
  let notSheetId = "";
  let customerId = "";
  let apptA = "";
  let apptB = "";
  let apptC = "";
  let apptD = "";
  let apptE = "";
  let apptO = "";
  let prefixA = "";
  let officePhotoA = "";

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (waiting) return ctx.skip();
      await fn();
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
  /** Run as `uid`; the error (code + message) if refused, else the rows. Always back to the server after. */
  const tryAs = async (uid: string, sql: string, params: unknown[] = []): Promise<{ error: string | null; code: string | null; rows: any[] }> => {
    await c.query("savepoint tryas");
    try {
      await as(uid);
      const r = await c.query(sql, params);
      await c.query("release savepoint tryas");
      return { error: null, code: null, rows: r.rows };
    } catch (e: any) {
      await c.query("rollback to savepoint tryas");
      return { error: String(e.message), code: String(e.code), rows: [] };
    } finally {
      await asServer();
    }
  };
  const save = (uid: string, appt: string, capture: unknown, templateId?: string | null, answers?: unknown) =>
    tryAs(uid, "select public.save_walkthrough_capture($1, $2::jsonb, $3, $4::jsonb) as id", [
      appt,
      capture === null ? null : JSON.stringify(capture),
      templateId ?? null,
      answers === undefined || answers === null ? null : JSON.stringify(answers),
    ]);
  /** A file in the documents bucket, uploaded by `owner` (what the storage API records on upload). */
  const plant = async (name: string, owner: string) => {
    const r = await c.query(
      "insert into storage.objects (bucket_id, name, owner, owner_id) values ('documents', $1, $2::uuid, $3) returning name",
      [name, owner, owner],
    );
    expect(r.rowCount).toBe(1);
    return name;
  };
  const row = (id: string) =>
    one(
      `select capture, inspection_template_id::text as sheet, inspection_answers as answers, status, title, location, notes,
              assigned_to::text as assigned_to, customer_id::text as customer_id, starts_at, updated_at
         from appointments where id = $1`,
      [id],
    );

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '30s'");
    const have = await one(`select to_regprocedure('${FN}') is not null as ok`);
    if (!have.ok && CREWLEAD_APPLY_0356 === "1") {
      await c.query(M0356);
      console.warn("[walkthrough-crew-lead] 0356 is not on this database yet; applied inside the test's own transaction, which is rolled back.");
    } else if (!have.ok) {
      waiting = !notOnThisDatabase("[walkthrough-crew-lead] 0356 is not on this database yet: run node scripts/test-db/rebuild.cjs.");
      if (waiting) return;
    }

    // A TEST company: the owner (office), a crew lead, a second crew lead, a plain tech, and a crew
    // lead whose seat is cut. And a stranger company with its own crew lead.
    const org = await mintThrowawayOrg(c, { label: "0356 walk-through", techs: 4 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    [leadId, lead2Id, techId, goneId] = org.techs.map((t) => t.id);
    const other = await mintThrowawayOrg(c, { label: "0356 stranger", techs: 1 });
    otherLeadId = other.techs[0].id;
    // As the server (a privileged writer), the office's /team switch and an offboarding.
    const set = await c.query("update profiles set crew_lead = true where id = any($1::uuid[]) returning id", [[leadId, lead2Id, goneId, otherLeadId]]);
    expect(set.rowCount).toBe(4);
    const cut = await c.query("update profiles set active = false where id = $1 returning active", [goneId]);
    expect(cut.rows[0].active).toBe(false);

    customerId = (await one("insert into customers (org_id, name) values ($1, 'TEST 0356 customer') returning id::text as id", [orgId])).id;
    sheetId = (
      await one(
        `insert into forms (org_id, name, is_inspection, schema, playbook) values ($1, 'TEST 0356 sheet', true, '[]'::jsonb, $2::jsonb) returning id::text as id`,
        [
          orgId,
          JSON.stringify({
            needs: [
              { key: "work", label: "Work", ask: "What work?", slot: { type: "select", options: ["Deck", "Remodel"] } },
              { key: "scope", label: "Scope", ask: "Which scopes?", slot: { type: "scopes" } },
              { key: "plans", label: "Plans", ask: "Upload the plans", slot: { type: "file", multi: true } },
            ],
          }),
        ],
      )
    ).id;
    sheet2Id = (await one(`insert into forms (org_id, name, is_inspection, schema) values ($1, 'TEST 0356 sheet 2', true, '[]'::jsonb) returning id::text as id`, [orgId])).id;
    notSheetId = (await one(`insert into forms (org_id, name, is_inspection, schema) values ($1, 'TEST 0356 not a sheet', false, '[]'::jsonb) returning id::text as id`, [orgId])).id;

    const visit = async (org: string, who: string, extra: Record<string, unknown> = {}) =>
      (
        await one(
          `insert into appointments (org_id, type, title, starts_at, status, assigned_to, customer_id, location, notes, capture, inspection_template_id, inspection_answers)
           values ($1, 'inspection', $2, now() + interval '1 day', 'scheduled', $3, $4, $5, $6, $7::jsonb, $8, coalesce($9::jsonb, '{}'::jsonb))
           returning id::text as id`,
          [
            org,
            extra.title ?? "TEST 0356 visit",
            who,
            extra.customer_id ?? null,
            extra.location ?? null,
            extra.notes ?? null,
            extra.capture === undefined ? null : JSON.stringify(extra.capture),
            extra.sheet ?? null,
            extra.answers === undefined ? null : JSON.stringify(extra.answers),
          ],
        )
      ).id;
    apptA = await visit(orgId, leadId, { title: "TEST 0356 A", customer_id: customerId, location: "1 Test St", notes: "the office's own note" });
    prefixA = `${orgId}/appointments/${apptA}/`;
    officePhotoA = `${prefixA}0-office.jpg`;
    await c.query(
      `update appointments set capture = $2::jsonb, inspection_template_id = $3, inspection_answers = $4::jsonb where id = $1`,
      [
        apptA,
        JSON.stringify({ notes: "office capture", measurements: "", materials: "", photos: [officePhotoA], quote_id: "q-0356" }),
        sheetId,
        JSON.stringify({ work: "Deck", scope: [{ code: "R1", qty: 1, price: 500 }] }),
      ],
    );
    apptB = await visit(orgId, lead2Id);
    apptC = await visit(orgId, techId);
    apptD = await visit(orgId, goneId);
    apptE = await visit(orgId, leadId);
    apptO = await visit(other.orgId, otherLeadId);
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the crew lead on the visit saves notes and a photo of this visit; quote_id stays the office's", async () => {
    await plant(`${prefixA}1-lead.jpg`, leadId); // he uploaded it (the Inspector's Take / Add)
    const r = await save(leadId, apptA, { notes: "crew lead notes", photos: [officePhotoA, `${prefixA}1-lead.jpg`], quote_id: "not-his" });
    expect(r.error).toBeNull();
    expect(r.rows[0].id).toBe(apptA);
    const a = await row(apptA);
    expect(a.capture.notes).toBe("crew lead notes");
    expect(a.capture.photos).toEqual([officePhotoA, `${prefixA}1-lead.jpg`]);
    expect(a.capture.quote_id).toBe("q-0356");
  });

  it("he can't take a photo off, or put one on from another folder", async () => {
    const before = await row(apptA);
    const off = await save(leadId, apptA, { notes: "x", photos: [] });
    expect(off.code).toBe("42501");
    expect(off.error).toBe("Only the office can take a photo off the walk-through.");
    for (const bad of [`${orgId}/employees/pay.pdf`, `${prefixA}../../employees/pay.pdf`, `${orgId}/appointments/${apptB}/x.jpg`]) {
      const r = await save(leadId, apptA, { photos: [...before.capture.photos, bad] });
      expect(r.error, bad).toBe("A photo you put on the walk-through has to be one you took for this visit.");
    }
    expect((await row(apptA)).capture).toEqual(before.capture);
  });

  it("a photo the office took off stays off: its file is still in the visit's folder, and it isn't his to put back", async () => {
    // The office uploads a photo and then takes it off the list (the file stays in the folder).
    const officeTook = await plant(`${prefixA}2-office-removed.jpg`, ownerId);
    const on = await row(apptA);
    expect((await save(ownerId, apptA, { photos: [...on.capture.photos, officeTook] })).error).toBeNull();
    expect((await save(ownerId, apptA, { photos: on.capture.photos })).error).toBeNull();
    const before = await row(apptA);
    expect(before.capture.photos).not.toContain(officeTook);
    // His page still holds the old list; his next save (or a direct call) sends it back with his new one.
    const his = await plant(`${prefixA}3-lead-new.jpg`, leadId);
    const stale = await save(leadId, apptA, { photos: [...before.capture.photos, officeTook, his] });
    expect(stale.code).toBe("42501");
    expect(stale.error).toBe("A photo you put on the walk-through has to be one you took for this visit.");
    // A path in the folder that no one uploaded is no better.
    const ghost = await save(leadId, apptA, { photos: [...before.capture.photos, `${prefixA}9-never-uploaded.jpg`] });
    expect(ghost.error).toBe("A photo you put on the walk-through has to be one you took for this visit.");
    expect((await row(apptA)).capture).toEqual(before.capture);
    // Only what he just took travels (addInspectionPhotos), and that lands.
    expect((await save(leadId, apptA, { photos: [...before.capture.photos, his] })).error).toBeNull();
    expect((await row(apptA)).capture.photos).toEqual([...before.capture.photos, his]);
  });

  it("his answers land; a priced answer stays exactly as the office left it, whatever he sends", async () => {
    const r = await save(leadId, apptA, null, sheetId, {
      work: "Remodel",
      scope: [{ code: "R1", qty: 9, price: 1 }],
      sneak: [{ code: "X", qty: 1, price: 99 }],
      obj: { price: 5 },
    });
    expect(r.error).toBeNull();
    let a = await row(apptA);
    expect(a.answers).toEqual({ work: "Remodel", scope: [{ code: "R1", qty: 1, price: 500 }] });
    // Clearing it is no different: the office's pick stays.
    expect((await save(leadId, apptA, null, sheetId, { work: "Deck" })).error).toBeNull();
    a = await row(apptA);
    expect(a.answers).toEqual({ work: "Deck", scope: [{ code: "R1", qty: 1, price: 500 }] });
  });

  it("a file question's files: the office's stay whatever he sends, and he adds only his own uploads", async () => {
    const plan = await plant(`${prefixA}10-office-plans.pdf`, ownerId);
    const gone = await plant(`${prefixA}11-office-removed.pdf`, ownerId);
    expect((await save(ownerId, apptA, null, sheetId, { work: "Deck", plans: [plan, gone] })).error).toBeNull();
    expect((await save(ownerId, apptA, null, sheetId, { work: "Deck", plans: [plan] })).error).toBeNull();
    // His Remove (an empty list) or leaving the question out saves the rest, and the office's plan stays.
    expect((await save(leadId, apptA, null, sheetId, { work: "Remodel", plans: [] })).error).toBeNull();
    expect((await row(apptA)).answers).toMatchObject({ work: "Remodel", plans: [plan] });
    expect((await save(leadId, apptA, null, sheetId, { work: "Remodel" })).error).toBeNull();
    expect((await row(apptA)).answers.plans).toEqual([plan]);
    // A stale page's list (with the file the office took off), a path nobody uploaded and another
    // folder's file are left out; his own upload is added after the office's.
    const his = await plant(`${prefixA}12-lead-plans.pdf`, leadId);
    const r = await save(leadId, apptA, null, sheetId, {
      work: "Remodel",
      plans: [gone, plan, his, `${prefixA}13-never-uploaded.pdf`, `${orgId}/employees/pay.pdf`],
    });
    expect(r.error).toBeNull();
    expect((await row(apptA)).answers.plans).toEqual([plan, his]);
  });

  it("the sheet: he sets the first one; switching or clearing a saved one, or naming a non-sheet, is refused", async () => {
    expect((await save(leadId, apptA, null, sheet2Id, {})).error).toBe("Only the office can switch the walk-through to a different sheet.");
    expect((await save(leadId, apptA, null, null, {})).error).toBe("Only the office can switch the walk-through to a different sheet.");
    expect((await row(apptA)).sheet).toBe(sheetId);
    expect((await save(leadId, apptE, null, notSheetId, {})).error).toBe("That sheet isn't one of this company's walk-through sheets.");
    expect((await save(leadId, apptE, null, sheet2Id, { a: "b" })).error).toBeNull();
    const e = await row(apptE);
    expect(e.sheet).toBe(sheet2Id);
    expect(e.answers).toEqual({ a: "b" });
  });

  it("everyone else is refused and nothing moves: a crew lead not on it, a plain tech on his own, another company's, a cut seat", async () => {
    const snap = async () => Promise.all([apptA, apptB, apptC, apptD, apptO].map(row));
    const before = await snap();
    const cases: [string, string, string][] = [
      [leadId, apptB, "Only the office, or the crew lead on this visit, can fill in the walk-through."],
      [techId, apptC, "Only the office, or the crew lead on this visit, can fill in the walk-through."],
      [otherLeadId, apptA, "That walk-through isn't one of this company's."],
      [leadId, apptO, "That walk-through isn't one of this company's."],
      [goneId, apptD, "Sign in with an active seat to fill in the walk-through."],
    ];
    for (const [who, appt, words] of cases) {
      for (const r of [
        await save(who, appt, { notes: "x", photos: [] }),
        await save(who, appt, null, null, { work: "Remodel" }),
        await tryAs(who, "select public.save_walkthrough_capture($1) as id", [appt]), // the probe
      ]) {
        expect(r.code, `${who} on ${appt}`).toBe("42501");
        expect(r.error, `${who} on ${appt}`).toBe(words);
      }
    }
    expect(await snap()).toEqual(before);
    // The plain tech CAN read his visit (0227): the refusal is about writing, not about finding it.
    const read = await tryAs(techId, "select id::text as id from appointments where id = $1", [apptC]);
    expect(read.rows).toEqual([{ id: apptC }]);
  });

  it("the function writes the capture columns and nothing else", async () => {
    const before = await row(apptA);
    expect((await save(leadId, apptA, { notes: "again", photos: before.capture.photos }, sheetId, { work: "Remodel" })).error).toBeNull();
    const after = await row(apptA);
    for (const k of ["status", "title", "location", "notes", "assigned_to", "customer_id"] as const) expect(after[k], k).toEqual(before[k]);
    expect(after.starts_at.getTime()).toBe(before.starts_at.getTime());
    expect(after.capture.notes).toBe("again");
    expect(after.answers.work).toBe("Remodel");
  });

  it("a crew lead holds no UPDATE on appointments: a direct write changes nothing", async () => {
    const before = await row(apptA);
    const r = await tryAs(
      leadId,
      "update appointments set status = 'cancelled', title = 'hacked', capture = '{}'::jsonb, inspection_answers = '{}'::jsonb where id = $1 returning id",
      [apptA],
    );
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([]);
    expect(await row(apptA)).toEqual(before);
  });

  it("crew_lead is the office's: a tech can't take it, a crew lead can't drop it, the owner can; other self-edits still work", async () => {
    const self = (uid: string, patch: string) =>
      tryAs(uid, `update profiles set ${patch} where id = $1 returning id`, [uid]);
    const take = await self(techId, "crew_lead = true");
    expect(take.code).toBe("42501");
    expect(take.error).toBe("Only the owner or an admin can make someone a crew lead.");
    expect((await self(leadId, "crew_lead = false")).error).toBe("Only the owner or an admin can make someone a crew lead.");
    // Naming it unchanged (updateMember sends the whole patch) and editing anything else is fine.
    expect((await self(techId, "full_name = 'TEST renamed', crew_lead = false")).rows).toHaveLength(1);
    expect((await one("select crew_lead from profiles where id = $1", [techId])).crew_lead).toBe(false);
    // The owner makes the tech a crew lead, and then (and only then) the door opens on his visit.
    const give = await tryAs(ownerId, "update profiles set crew_lead = true where id = $1 returning id", [techId]);
    expect(give.rows).toHaveLength(1);
    expect((await tryAs(techId, "select public.save_walkthrough_capture($1)::text as id", [apptC])).rows[0].id).toBe(apptC);
    const back = await tryAs(ownerId, "update profiles set crew_lead = false where id = $1 returning id", [techId]);
    expect(back.rows).toHaveLength(1);
    expect((await tryAs(techId, "select public.save_walkthrough_capture($1)", [apptC])).code).toBe("42501");
  });

  it("the probe: nothing to save writes nothing and answers may / may not", async () => {
    // now() is the transaction's clock, so updated_at can't show a write here; the row version can.
    const version = async () => (await one("select ctid::text as v from appointments where id = $1", [apptA])).v;
    const before = { row: await row(apptA), v: await version() };
    const r = await tryAs(leadId, "select public.save_walkthrough_capture($1)::text as id", [apptA]);
    expect(r.rows[0].id).toBe(apptA);
    expect(await row(apptA)).toEqual(before.row);
    expect(await version()).toBe(before.v);
  });

  it("the office through the function is not held to the crew lead's rules, and quote_id is still carried", async () => {
    const r = await save(ownerId, apptA, { notes: "office", photos: [] }, sheetId, { scope: [{ code: "R1", qty: 2, price: 650 }] });
    expect(r.error).toBeNull();
    const a = await row(apptA);
    expect(a.capture.photos).toEqual([]);
    expect(a.capture.quote_id).toBe("q-0356");
    expect(a.answers).toEqual({ scope: [{ code: "R1", qty: 2, price: 650 }] });
  });

  it("anon can't call it; a signed-in member can", async () => {
    const p = await one(
      `select has_function_privilege('anon', '${FN}', 'execute') as anon, has_function_privilege('authenticated', '${FN}', 'execute') as authed`,
    );
    expect(p).toEqual({ anon: false, authed: true });
  });
});
