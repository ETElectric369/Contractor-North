import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { answersWithoutPrices, sheetsWithoutMoney, withoutMoney } from "@/lib/inspection/walkthrough-access";

/**
 * WALK-THROUGH PRICES STAY IN THE OFFICE (0366), proven where the boundary lives: the database, with a
 * tech's own session (the anon key plus his JWT is all PostgREST needs). Modelled on
 * timeclock/pay-column-guard (the pay spine's column guard), but with people, not only the catalog:
 *
 *   LEAK-0227   a tech selecting inspection_answers from appointments is refused (42501), the office
 *               too (the column is revoked from the one signed-in role); appointment_answers gives a
 *               tech and a crew lead their own visit's answers with code and qty and NO price, gives
 *               the office the price, and gives a tech no row for a visit he isn't on; the rest of the
 *               appointment row still reads; anon reads nothing; no function running as the signed-in
 *               person names the column.
 *   the sheets  (the lead's addition, a) a non-office reader can't read a playbook form from forms,
 *               still reads a crew checklist (no playbook), and reads a sheet through form_playbooks
 *               with no note and no dollar figure in a why; the office reads it as written, both ways.
 *   the leads   (the lead's addition, b) a tech reads no lead at all, the one on his own visit
 *               included: 0056 already made inquiries staff-only, and 0366 checks it stays so.
 *   the mirrors answers_without_prices and playbook_without_money say exactly what the app's
 *               answersWithoutPrices and sheetsWithoutMoney say, sample by sample.
 *   0356 stands a crew lead still saves the walk-through through save_walkthrough_capture, and a
 *               priced answer stays the office's.
 *
 * When the database doesn't have 0366 yet, the leak is shown first (a tech CAN read the prices), then
 * 0366 is applied inside the transaction. Everything is ONE transaction that is always rolled back,
 * on throwaway companies; people speak by planted request.jwt.claims under `set local role`.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const M0366 = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0366_"))!), "utf8");

const PRICED = { work: "Deck", scope: [{ code: "R1", qty: 2, price: 650 }, { code: "R4", qty: 1, price: 90 }], note: { price: 5, text: "x" } };
const UNPRICED = { work: "Deck", scope: [{ code: "R1", qty: 2 }, { code: "R4", qty: 1 }], note: { text: "x" } };
const PLAYBOOK = {
  needs: [
    { key: "panel", label: "Panel", ask: "Which brand?", why: "Zinsco or FPE turns a $400 circuit into a panel swap.", note: "My rule: never quote under $1,250." },
    { key: "feet", label: "Feet", ask: "How far?", slot: { type: "number", unit: "ft" }, why: "$4.50/ft past fifty feet" },
    { key: "scope", label: "Scope", ask: "Which scopes?", slot: { type: "scopes" } },
  ],
  extra: { secret: "$99" },
};

d("walk-through prices stay in the office (0366)", () => {
  let c: pg.Client;
  let ready = false;
  let had = false;
  let before: { techAnswers: unknown; techPlaybook: unknown } | null = null;
  let orgId = "";
  let ownerId = "";
  let techId = "";
  let leadId = "";
  let otherOwnerId = "";
  let visitTech = ""; // assigned to the plain tech
  let visitLead = ""; // assigned to the crew lead
  let visitNobody = ""; // assigned to nobody
  let sheetId = "";
  let checklistId = "";
  let inquiryId = "";

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (!ready) return ctx.skip();
      await fn();
    });
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Run as `uid` (or anon when null); the error code + message if refused, else the rows. */
  const tryAs = async (uid: string | null, sql: string, params: unknown[] = []): Promise<{ code: string | null; error: string | null; rows: any[] }> => {
    await c.query("savepoint tryas");
    try {
      if (uid) {
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
        await c.query("set local role authenticated");
      } else {
        await c.query("set local role anon");
      }
      const r = await c.query(sql, params);
      await c.query("release savepoint tryas");
      return { code: null, error: null, rows: r.rows };
    } catch (e: any) {
      await c.query("rollback to savepoint tryas");
      return { code: String(e.code), error: String(e.message), rows: [] };
    } finally {
      await asServer();
    }
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    await c.query("set local statement_timeout = '30s'");

    // A TEST company: the owner (the office), a plain tech, a crew lead; and a stranger company.
    const org = await mintThrowawayOrg(c, { label: "0366 price guard", techs: 2 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    [techId, leadId] = org.techs.map((t) => t.id);
    otherOwnerId = (await mintThrowawayOrg(c, { label: "0366 price guard stranger", techs: 0 })).owner.id;
    expect((await c.query("update profiles set crew_lead = true where id = $1 returning id", [leadId])).rowCount).toBe(1);

    sheetId = (
      await one("insert into forms (org_id, name, is_inspection, schema, playbook) values ($1, 'TEST 0366 sheet', true, '[]'::jsonb, $2::jsonb) returning id::text as id", [
        orgId,
        JSON.stringify(PLAYBOOK),
      ])
    ).id;
    checklistId = (await one("insert into forms (org_id, name, is_inspection, schema) values ($1, 'TEST 0366 checklist', false, '[{\"key\":\"a\"}]'::jsonb) returning id::text as id", [orgId])).id;
    inquiryId = (
      await one("insert into inquiries (org_id, name, phone, message) values ($1, 'TEST 0366 Lead', '(530) 555-0100', 'Deck, 12x16') returning id::text as id", [orgId])
    ).id;
    const visit = async (who: string | null) =>
      (
        await one(
          `insert into appointments (org_id, type, title, starts_at, status, assigned_to, inquiry_id, inspection_template_id, inspection_answers)
           values ($1, 'inspection', 'TEST 0366 visit', now() + interval '1 day', 'scheduled', $2, $3, $4, $5::jsonb) returning id::text as id`,
          [orgId, who, inquiryId, sheetId, JSON.stringify(PRICED)],
        )
      ).id;
    visitTech = await visit(techId);
    visitLead = await visit(leadId);
    visitNobody = await visit(null);

    had = (await one("select to_regclass('public.appointment_answers') is not null as ok")).ok;
    if (!had) {
      // THE LEAK, BEFORE 0366: the tech reads the office's prices and the sheet's money straight off the tables.
      before = {
        techAnswers: (await tryAs(techId, "select inspection_answers from appointments where id = $1", [visitTech])).rows[0]?.inspection_answers ?? null,
        techPlaybook: (await tryAs(techId, "select playbook from forms where id = $1", [sheetId])).rows[0]?.playbook ?? null,
      };
    }
    await c.query(M0366);
    console.warn(`[appointments-price-guard] 0366 ${had ? "was already on this database; ran it again" : "applied"} inside the test's own transaction, which is rolled back.`);
    await c.query("set local statement_timeout = '30s'");
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("before 0366 the leak was real: a tech read the prices and the sheet's money straight off the tables", async (): Promise<void> => {
    if (had) return; // the database already carries 0366: there is no before to show
    expect(before?.techAnswers).toEqual(PRICED);
    expect(JSON.stringify(before?.techPlaybook)).toContain("$400");
  });

  it("a tech selecting inspection_answers from appointments is refused (42501), and so is the office", async () => {
    for (const who of [techId, leadId, ownerId]) {
      const r = await tryAs(who, "select inspection_answers from appointments where id = $1", [who === leadId ? visitLead : visitTech]);
      expect(r.code, who).toBe("42501");
    }
    // A filter on it is a read of it too.
    expect((await tryAs(techId, "select id from appointments where inspection_answers is not null")).code).toBe("42501");
    // And every column at once is every column: the revoked one included.
    expect((await tryAs(techId, "select * from appointments where id = $1", [visitTech])).code).toBe("42501");
  });

  it("the rest of his visit still reads, and the office's write paths are untouched", async () => {
    const r = await tryAs(techId, "select id::text as id, title, capture, inspection_template_id::text as sheet, inquiry_id::text as inquiry from appointments where id = $1", [visitTech]);
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([{ id: visitTech, title: "TEST 0366 visit", capture: null, sheet: sheetId, inquiry: inquiryId }]);
    // The office still UPDATEs the answers (its write, returning only the id).
    const w = await tryAs(ownerId, "update appointments set inspection_answers = $2::jsonb where id = $1 returning id::text as id", [visitNobody, JSON.stringify(PRICED)]);
    expect(w.error).toBeNull();
    expect(w.rows).toEqual([{ id: visitNobody }]);
  });

  it("appointment_answers: the tech on his visit sees code and qty with no price", async () => {
    const r = await tryAs(techId, "select id::text as id, inspection_answers from appointment_answers where id = $1", [visitTech]);
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([{ id: visitTech, inspection_answers: UNPRICED }]);
  });

  it("a crew lead on his visit: the same, no price", async () => {
    const r = await tryAs(leadId, "select inspection_answers from appointment_answers where id = $1", [visitLead]);
    expect(r.rows).toEqual([{ inspection_answers: UNPRICED }]);
  });

  it("the office sees the price", async () => {
    const r = await tryAs(ownerId, "select id::text as id, inspection_answers from appointment_answers where id = any($1::uuid[]) order by id", [[visitTech, visitLead]]);
    expect(r.rows.map((x: any) => x.inspection_answers)).toEqual([PRICED, PRICED]);
  });

  it("a tech sees no row for a visit he isn't on; another company sees none; anon can't read the view", async () => {
    expect((await tryAs(techId, "select id from appointment_answers where id = any($1::uuid[])", [[visitLead, visitNobody]])).rows).toEqual([]);
    expect((await tryAs(otherOwnerId, "select id from appointment_answers where id = $1", [visitTech])).rows).toEqual([]);
    const anon = await tryAs(null, "select id from appointment_answers limit 1");
    expect(anon.code).toBe("42501");
    // Only his own visit, whatever he asks for.
    expect((await tryAs(techId, "select id::text as id from appointment_answers where org_id = $1", [orgId])).rows).toEqual([{ id: visitTech }]);
  });

  it("no function running as the signed-in person names inspection_answers", async () => {
    const r = await one(
      `select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') as names
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and not p.prosecdef and p.prosrc ilike '%inspection_answers%'`,
    );
    expect(r.names).toBe("");
    const p = await one(
      "select has_column_privilege('authenticated', 'public.appointments', 'inspection_answers', 'SELECT') as col, has_column_privilege('authenticated', 'public.appointments', 'id', 'SELECT') as id",
    );
    expect(p).toEqual({ col: false, id: true });
  });

  it("a crew lead still saves the walk-through through save_walkthrough_capture, and a priced answer stays the office's", async () => {
    const r = await tryAs(leadId, "select public.save_walkthrough_capture($1, null, $2, $3::jsonb)::text as id", [
      visitLead,
      sheetId,
      JSON.stringify({ work: "Remodel", scope: [{ code: "R1", qty: 9 }] }),
    ]);
    expect(r.error).toBeNull();
    expect(r.rows[0].id).toBe(visitLead);
    const stored = (await one("select inspection_answers from appointments where id = $1", [visitLead])).inspection_answers;
    expect(stored.work).toBe("Remodel");
    expect(stored.scope).toEqual(PRICED.scope);
  });

  it("the sheets: a non-office reader can't read a playbook form from forms, but still reads a crew checklist", async () => {
    for (const who of [techId, leadId]) {
      expect((await tryAs(who, "select id from forms where id = $1", [sheetId])).rows, who).toEqual([]);
      expect((await tryAs(who, "select id::text as id from forms where id = $1", [checklistId])).rows, who).toEqual([{ id: checklistId }]);
    }
    const office = await tryAs(ownerId, "select playbook from forms where id = $1", [sheetId]);
    expect(office.rows[0].playbook).toEqual(PLAYBOOK);
  });

  it("the sheets through form_playbooks: no note and no dollar figure for anyone but the office", async () => {
    const want = sheetsWithoutMoney([{ playbook: PLAYBOOK }])[0].playbook;
    for (const who of [techId, leadId]) {
      const r = await tryAs(who, "select playbook, is_inspection, name from form_playbooks where id = $1", [sheetId]);
      expect(r.rows, who).toEqual([{ playbook: want, is_inspection: true, name: "TEST 0366 sheet" }]);
      expect(JSON.stringify(r.rows[0].playbook)).not.toMatch(/\$|note|secret/);
    }
    expect((await tryAs(ownerId, "select playbook from form_playbooks where id = $1", [sheetId])).rows[0].playbook).toEqual(PLAYBOOK);
    // Another company's reader sees none of them.
    expect((await tryAs(otherOwnerId, "select id from form_playbooks where org_id = $1", [orgId])).rows).toEqual([]);
    expect((await tryAs(null, "select id from form_playbooks limit 1")).code).toBe("42501");
  });

  it("the leads: a tech reads no lead at all, the one on his own visit included; the office reads it", async () => {
    expect((await tryAs(techId, "select id from inquiries where id = $1", [inquiryId])).rows).toEqual([]);
    expect((await tryAs(leadId, "select count(*)::int as n from inquiries where org_id = $1", [orgId])).rows).toEqual([{ n: 0 }]);
    expect((await tryAs(ownerId, "select name, phone from inquiries where id = $1", [inquiryId])).rows).toEqual([{ name: "TEST 0366 Lead", phone: "(530) 555-0100" }]);
    // What his visit carries is the lead's id, nothing of the lead's.
    expect((await tryAs(techId, "select inquiry_id::text as inquiry from appointments where id = $1", [visitTech])).rows).toEqual([{ inquiry: inquiryId }]);
  });

  it("the mirrors say what the app says: answers_without_prices and playbook_without_money, sample by sample", async () => {
    const answerSamples: unknown[] = [
      PRICED,
      {},
      { a: [1, "x", null, { price: 1, code: "Z" }, [{ price: 2 }]], b: { price: 3 }, c: 4, d: null, e: "e" },
      { nested: { deep: { price: 9 } } },
    ];
    for (const s of answerSamples) {
      const sql = (await one("select public.answers_without_prices($1::jsonb) as v", [JSON.stringify(s)])).v;
      expect(sql, JSON.stringify(s)).toEqual(answersWithoutPrices(s as Record<string, unknown>));
    }
    const whys = [
      "Zinsco or FPE turns a $400 circuit into a panel swap.",
      "$4.50/ft past fifty feet",
      "Over $2k we pull a permit, per the county.",
      "$90 per hr, two hours minimum ($180).",
      "Runs $1,250.00 or more; call first.",
      "No money here at all",
      "$",
    ];
    for (const why of whys) {
      const p = { needs: [{ key: "k", label: "K", ask: "K?", why, note: "gone" }] };
      const sql = (await one("select public.playbook_without_money($1::jsonb) as v", [JSON.stringify(p)])).v;
      const js = sheetsWithoutMoney([{ playbook: p }])[0].playbook as { needs: Record<string, unknown>[] };
      expect(sql, why).toEqual(js);
      expect(withoutMoney(why)).toBe(((sql.needs[0] as { why?: string }).why ?? ""));
    }
  });
});
