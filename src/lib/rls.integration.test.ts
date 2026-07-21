import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

// Read-only integration test of the multi-tenant security invariant: every
// org-scoped table must have RLS on with a policy, and the org-scoping helpers
// must exist. Catches the "new table shipped without RLS" class — the exact gap
// that leaked reads before migration 0056.
//
// Gated on DB creds in env (no infra details committed). Runs locally and in CI
// once TEST_DBPW / TEST_DB_HOST / TEST_DB_USER are set; skips cleanly otherwise:
//   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("RLS multi-tenant isolation invariant", () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  // Every public table carrying an org_id is a tenant-owned table.
  const orgTablesSql = `
    select c.relname as tbl,
      c.relrowsecurity as rls_on,
      (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r'
      and exists (select 1 from information_schema.columns col
                  where col.table_schema='public' and col.table_name=c.relname and col.column_name='org_id')`;

  it("every org-scoped table has RLS ENABLED (no unprotected tenant table)", async () => {
    const { rows } = await client.query(orgTablesSql);
    expect(rows.length).toBeGreaterThan(30); // sanity: we actually inspected the tables
    const unprotected = rows.filter((r: any) => !r.rls_on).map((r: any) => r.tbl);
    expect(unprotected).toEqual([]);
  });

  it("every org-scoped table has at least one RLS policy", async () => {
    const { rows } = await client.query(orgTablesSql);
    const noPolicy = rows.filter((r: any) => Number(r.policies) === 0).map((r: any) => r.tbl);
    expect(noPolicy).toEqual([]);
  });

  it("the org-scoping security-definer helpers exist", async () => {
    const { rows } = await client.query(
      `select proname from pg_proc where proname in ('auth_org_id','is_org_staff','set_org_id')`,
    );
    const names = rows.map((r: any) => r.proname);
    expect(names).toContain("auth_org_id");
    expect(names).toContain("is_org_staff");
    expect(names).toContain("set_org_id");
  });

  it("the public share RPCs are SECURITY DEFINER (so the safe projection can't be bypassed)", async () => {
    const { rows } = await client.query(
      `select proname, prosecdef from pg_proc where proname in ('public_quote','public_invoice')`,
    );
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.prosecdef).toBe(true);
  });

  // The org_id-scoped checks above are blind to user-scoped tables (no org_id column,
  // e.g. conversations/messages keyed by auth.uid()). These two checks cover them.
  it("no RLS-enabled table is left policy-less (RLS on + 0 policies = locked-out or misconfigured)", async () => {
    // INTENTIONALLY server-only tables: RLS on + NO policy = deny-all to every authenticated
    // user, so ONLY the service role (which bypasses RLS) can touch them. That's the CORRECT,
    // secure config for these — written by the server, never read by a client:
    //   rate_limits      — the Postgres rate-limit counters (rate_limit_hit/gc RPCs only)
    //   error_events     — the ops error sink (reportError → record_app_error RPC only; Claude queries it)
    //   signup_allowlist — the invite-only gate (migration 0125): read ONLY by the SECURITY
    //                      DEFINER signup trigger + signup_allowed(); written only by the
    //                      service role (Erik's approvals, createEmployee/importCrew pre-approve).
    //                      Client-invisible BY DESIGN — this was the "CI: All jobs have failed"
    //                      email flood from cn-v493 onward.
    // The invariant catches a table ACCIDENTALLY left policy-less; these are deliberate.
    const SERVER_ONLY = new Set(["rate_limits", "error_events", "signup_allowlist"]);
    const { rows } = await client.query(`
      select c.relname as tbl
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and c.relrowsecurity
        and (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname)=0`);
    expect(rows.map((r: any) => r.tbl).filter((t: string) => !SERVER_ONLY.has(t))).toEqual([]);
  });

  it("user-scoped tables (conversations, messages) are RLS-protected even without org_id", async () => {
    const { rows } = await client.query(`
      select c.relname as tbl, c.relrowsecurity as rls_on,
        (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and c.relname in ('conversations','messages')`);
    for (const t of ["conversations", "messages"]) {
      const r = rows.find((x: any) => x.tbl === t);
      expect(r, `${t} table should exist`).toBeTruthy();
      expect(r.rls_on).toBe(true);
      expect(Number(r.policies)).toBeGreaterThan(0);
    }
  });
});
