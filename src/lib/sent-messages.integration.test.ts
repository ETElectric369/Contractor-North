import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { PG_TYPES } from "@/lib/postgrest-shim.db-fixture";

/**
 * THE WORDS THAT WENT OUT (0407; cn-v1155): sent_messages, proven on the database it lives on, inside
 * ONE transaction that is always rolled back.
 *   · row level security is on, and the table has a select policy and an insert policy and NO update,
 *     delete or all-commands policy (the words that went out are a record);
 *   · an owner (office staff) of the company reads its rows, newest first, and never another company's;
 *   · a tech can neither add a row nor read one (the record is staff's: a "sent to X" row cannot be forged through the API);
 *   · an insert that names another company is refused; org_id left out is stamped from the caller;
 *   · a row the owner tries to change or delete is untouched (no policy, so zero rows move);
 *   · doc_kind and channel refuse a word outside their lists.
 *
 * 0407 is applied here ONLY when the table is not on the database yet; a CREATE TABLE with foreign
 * keys takes a lock on organizations and profiles that would be held until the rollback. Erik applies
 * 0407 on the test database before the deploy, so on CI that branch is skipped; on a fresh rebuild it
 * runs once, and the file is written twice-safe (if not exists, drop-then-create).
 *
 * One TEST company and a stranger minted inside the transaction (throwaway-org.db-fixture.ts).
 * Never run outside CI by hand; it skips without the test database's credentials.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db src/lib/sent-messages.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("0407: sent_messages is an append-only record, read by staff of its own company", () => {
  let c: pg.Client;
  let orgId = "";
  let ownerId = "";
  let techId = "";
  let otherOrgId = "";
  let docId = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** The SQLSTATE a statement is refused with, or null when it went through (then undone). */
  const refused = async (sql: string, params: unknown[]): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      await c.query(sql, params);
      await c.query("rollback to savepoint attempt");
      return null;
    } catch (e) {
      await c.query("rollback to savepoint attempt");
      return String((e as { code?: string }).code ?? e);
    }
  };
  /** One message, written as the server (RLS off) at a stated time. */
  const put = async (org: string, at: string, body: string, extra: { channel?: string } = {}) => {
    await asServer();
    return one(
      `insert into public.sent_messages (org_id, doc_kind, doc_id, channel, to_addr, subject, body, sent_at)
       values ($1, 'invoice', $2, $3, 'dana@larkspur.example', 'TEST subject', $4, $5::timestamptz) returning id::text as id`,
      [org, docId, extra.channel ?? "email", body, at],
    );
  };

  beforeAll(async () => {
    c = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
      types: PG_TYPES,
    });
    await c.connect();
    await assertTestDatabase(c);
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const carried = (await one("select to_regclass('public.sent_messages') is not null as ok")).ok === true;
    if (!carried) {
      await c.query(readFileSync(fileURLToPath(new URL("../../supabase/migrations/0407_the_words_that_went_out.sql", import.meta.url)), "utf8"));
    }
    const m = await mintOrgAndStranger(c, "sent-messages");
    orgId = m.orgId;
    ownerId = m.staffId;
    techId = m.techId;
    otherOrgId = m.otherOrgId;
    docId = (await one("select gen_random_uuid()::text as id")).id;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("is under row level security with a read and an add, and no way to change or remove a row", async () => {
    await asServer();
    const rls = await one("select relrowsecurity as on from pg_class where oid = 'public.sent_messages'::regclass");
    expect(rls.on).toBe(true);
    const cmds = (await c.query("select cmd from pg_policies where schemaname = 'public' and tablename = 'sent_messages' order by cmd")).rows.map((r) => r.cmd);
    expect(cmds).toEqual(["INSERT", "SELECT"]);
  });

  it("an owner reads the company's rows newest first, and none of another company's", async () => {
    await put(orgId, "2026-11-01T10:00:00Z", "TEST oldest");
    await put(orgId, "2026-11-03T10:00:00Z", "TEST newest", { channel: "sms" });
    await put(orgId, "2026-11-02T10:00:00Z", "TEST middle");
    await put(otherOrgId, "2026-11-04T10:00:00Z", "TEST stranger's");
    await as(ownerId);
    const rows = (
      await c.query(
        "select body from public.sent_messages where org_id = $1 and doc_kind = 'invoice' and doc_id = $2 order by sent_at desc",
        [orgId, docId],
      )
    ).rows.map((r) => r.body);
    expect(rows).toEqual(["TEST newest", "TEST middle", "TEST oldest"]);
    const seen = (await c.query("select count(*)::int as n from public.sent_messages where org_id = $1", [otherOrgId])).rows[0].n;
    expect(seen).toBe(0);
  });

  it("a tech can neither add a row nor read one; staff add and read", async () => {
    await as(techId);
    const code = await refused(
      `insert into public.sent_messages (org_id, doc_kind, doc_id, channel, to_addr, body, sent_by)
       values ($1, 'quote', $2, 'email', 'dana@larkspur.example', 'TEST forged by a tech', $3)`,
      [orgId, docId, techId],
    );
    expect(code).toBe("42501");
    const read = await c.query("select 1 from public.sent_messages where org_id = $1", [orgId]);
    expect(read.rowCount).toBe(0);
    await as(ownerId);
    const added = await c.query(
      `insert into public.sent_messages (org_id, doc_kind, doc_id, channel, to_addr, body, sent_by)
       values ($1, 'quote', $2, 'email', 'dana@larkspur.example', 'TEST by staff', $3)`,
      [orgId, docId, ownerId],
    );
    expect(added.rowCount).toBe(1);
  });

  it("org_id left out is stamped from the caller; another company's id is refused", async () => {
    await as(ownerId);
    const stamped = await one(
      `insert into public.sent_messages (doc_kind, doc_id, channel, to_addr, body)
       values ('receipt', $1, 'sms', '+15305550133', 'TEST stamped') returning org_id::text as org_id`,
      [docId],
    );
    expect(stamped.org_id).toBe(orgId);
    const code = await refused(
      `insert into public.sent_messages (org_id, doc_kind, channel, to_addr, body) values ($1, 'invoice', 'email', 'x@larkspur.example', 'TEST wrong company')`,
      [otherOrgId],
    );
    expect(code).toBe("42501");
  });

  it("a row the owner tries to change or delete is left exactly as written", async () => {
    const { id } = await put(orgId, "2026-11-05T10:00:00Z", "TEST as sent");
    await as(ownerId);
    const upd = await c.query("update public.sent_messages set body = 'TEST rewritten' where id = $1", [id]);
    expect(upd.rowCount).toBe(0);
    const del = await c.query("delete from public.sent_messages where id = $1", [id]);
    expect(del.rowCount).toBe(0);
    const now = await one("select body from public.sent_messages where id = $1", [id]);
    expect(now.body).toBe("TEST as sent");
  });

  it("refuses a document kind or a channel outside the lists", async () => {
    await asServer();
    expect(
      await refused(`insert into public.sent_messages (org_id, doc_kind, channel, to_addr, body) values ($1, 'letter', 'email', 'x@larkspur.example', 'TEST')`, [orgId]),
    ).toBe("23514");
    expect(
      await refused(`insert into public.sent_messages (org_id, doc_kind, channel, to_addr, body) values ($1, 'invoice', 'fax', 'x@larkspur.example', 'TEST')`, [orgId]),
    ).toBe("23514");
  });
});
