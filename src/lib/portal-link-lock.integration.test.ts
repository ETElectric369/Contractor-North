import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

/**
 * Migration 0298: a customer's portal link belongs to the office.
 *
 * customers.portal_token was readable by every member of the org (techs included) and the link it
 * built opens every invoice, contract and quote that customer has. 0298 moves the token, value for
 * value, into customer_portal_access (office-staff RLS, no direct writes), empties the old column,
 * takes customer_portal away from anon and authenticated, and adds the office's switches: New Link
 * (portal_link_rotate), Turn Off / Turn On (portal_link_set_enabled) and Last Opened
 * (portal_record_open, at most once a minute).
 *
 * Speaks to the database AS a tech and AS office staff the way PostgREST does (request.jwt.claims +
 * `set local role authenticated`), inside ONE transaction that is always rolled back. It borrows an
 * existing active tech and staff member of one org and makes its own customer; nothing is minted in
 * auth.users. Read-back is the assertion, never the absence of an error (the silent-write law).
 *
 * Before 0298 is applied, each case says so on the console and returns: loud, not a green lie.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

const OFF_ORG_NAME = (j: any) => j?.org?.name;

d("the portal link belongs to the office (0298)", { timeout: 30_000 }, () => {
  let c: pg.Client;
  let has0298 = false;
  let orgId = "";
  let orgName = "";
  let techId = "";
  let staffId = "";
  let otherStaffId = ""; // office staff of a DIFFERENT org, if there is one
  let customerId = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];

  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asAnon = async () => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await c.query("set local role anon");
  };
  /** Back to the direct connection: the page's service-role side of the door. */
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Run fn inside a savepoint as whoever it sets; returns the SQLSTATE it was refused with, or
   *  null when it went through (then undone). Always ends back on the server connection. */
  const refused = async (fn: () => Promise<unknown>): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      await fn();
      await c.query("rollback to savepoint attempt");
      return null;
    } catch (e) {
      await c.query("rollback to savepoint attempt");
      return String((e as { code?: string }).code ?? (e as Error).message);
    } finally {
      await asServer();
    }
  };
  const needs = () => {
    if (!has0298) console.warn("[portal-link-lock] migration 0298 is not on this database yet; apply it to exercise this case.");
    return has0298;
  };
  const portal = async (token: string) => (await one("select public.customer_portal($1) as j", [token])).j;
  const tokenOf = async (id: string) => (await one("select token from public.customer_portal_access where customer_id = $1", [id])).token as string;

  beforeAll(async () => {
    c = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    await c.query("begin");
    has0298 = (await one("select to_regclass('public.customer_portal_access') is not null as ok")).ok;
    if (!has0298) return;

    const fx = await one(
      `select t.org_id, t.id as tech_id, s.id as staff_id, o.name as org_name
         from public.profiles t
         join public.profiles s on s.org_id = t.org_id and s.role in ('owner','admin','office') and coalesce(s.active, true)
         join public.organizations o on o.id = t.org_id
        where t.role = 'tech' and coalesce(t.active, true)
        limit 1`,
    );
    if (!fx) throw new Error("0298 test fixture: no org has both an active tech and active office staff.");
    orgId = fx.org_id;
    techId = fx.tech_id;
    staffId = fx.staff_id;
    orgName = fx.org_name;
    otherStaffId =
      (
        await one(
          "select id from public.profiles where org_id <> $1 and role in ('owner','admin','office') and coalesce(active, true) limit 1",
          [orgId],
        )
      )?.id ?? "";

    customerId = (
      await one("insert into public.customers (org_id, name) values ($1, 'TEST 0298 portal') returning id", [orgId])
    ).id;
  });
  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("a new customer gets a link the moment it exists", async () => {
    if (!needs()) return;
    const row = await one("select org_id, token, enabled from public.customer_portal_access where customer_id = $1", [customerId]);
    expect(row?.org_id).toBe(orgId);
    expect(row?.token).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.enabled).toBe(true);
  });

  it("every customer's link moved and still opens their page; the old column is empty everywhere", async () => {
    if (!needs()) return;
    const missing = await one(
      `select count(*)::int as n from public.customers c
        where c.org_id is not null and not exists (select 1 from public.customer_portal_access a where a.customer_id = c.id)`,
    );
    expect(missing.n).toBe(0);
    const readable = await one("select count(*)::int as n from public.customers where portal_token is not null");
    expect(readable.n).toBe(0);
    // A link that existed before 0298 (the oldest live one in this org) opens that customer's page.
    const old = await one(
      `select a.token, c.name from public.customer_portal_access a join public.customers c on c.id = a.customer_id
        where a.org_id = $1 and a.enabled and a.rotated_at is null and c.id <> $2 order by c.created_at limit 1`,
      [orgId, customerId],
    );
    if (old) {
      const j = await portal(old.token);
      expect(j?.customer?.name).toBe(old.name);
    }
    // And the column can't be filled again.
    expect(
      await refused(() => c.query("update public.customers set portal_token = repeat('a', 32) where id = $1", [customerId])),
    ).toBe("23514");
  });

  it("a tech reads no link: no row from the table, nothing on the customer", async () => {
    if (!needs()) return;
    await c.query("savepoint look");
    await as(techId);
    const { rows } = await c.query("select token from public.customer_portal_access where org_id = $1", [orgId]);
    const cust = await one("select portal_token from public.customers where id = $1", [customerId]);
    await c.query("rollback to savepoint look");
    await asServer();
    expect(rows).toHaveLength(0);
    expect(cust?.portal_token ?? null).toBeNull();
  });

  it("office staff read their own org's link, and another org's office reads none of it", async () => {
    if (!needs()) return;
    const expected = await tokenOf(customerId);
    await c.query("savepoint look");
    await as(staffId);
    const mine = await one("select token from public.customer_portal_access where customer_id = $1", [customerId]);
    await c.query("rollback to savepoint look");
    await asServer();
    expect(mine?.token).toBe(expected);

    if (!otherStaffId) return; // a one-org database has no neighbour to test against
    await c.query("savepoint look");
    await as(otherStaffId);
    const { rows } = await c.query("select token from public.customer_portal_access where org_id = $1", [orgId]);
    await c.query("rollback to savepoint look");
    await asServer();
    expect(rows).toHaveLength(0);
  });

  it("nobody signed in, and nobody anonymous, can run the door or write the table directly", async () => {
    if (!needs()) return;
    const token = await tokenOf(customerId);
    for (const who of [() => as(techId), () => as(staffId), () => asAnon()]) {
      expect(await refused(async () => { await who(); await c.query("select public.customer_portal($1)", [token]); })).toBe("42501");
      expect(await refused(async () => { await who(); await c.query("select public.portal_record_open($1)", [token]); })).toBe("42501");
    }
    // Staff too: every write goes through a function, never a PATCH that could set a guessable token.
    expect(
      await refused(async () => {
        await as(staffId);
        await c.query("update public.customer_portal_access set token = repeat('0', 32) where customer_id = $1", [customerId]);
      }),
    ).toBe("42501");
    expect(
      await refused(async () => {
        await as(techId);
        await c.query("insert into public.customer_portal_access (customer_id, org_id, token) values ($1, $2, repeat('0', 32))", [customerId, orgId]);
      }),
    ).toBe("42501");
  });

  it("a tech can't make a new link or switch it off", async () => {
    if (!needs()) return;
    const before = await tokenOf(customerId);
    expect(await refused(async () => { await as(techId); await c.query("select public.portal_link_rotate($1)", [customerId]); })).toBe("42501");
    expect(await refused(async () => { await as(techId); await c.query("select public.portal_link_set_enabled($1, false)", [customerId]); })).toBe("42501");
    const after = await one("select token, enabled from public.customer_portal_access where customer_id = $1", [customerId]);
    expect(after.token).toBe(before);
    expect(after.enabled).toBe(true);
  });

  it("another org's office can't touch this org's link", async () => {
    if (!needs() || !otherStaffId) return;
    const msg = await refused(async () => { await as(otherStaffId); await c.query("select public.portal_link_rotate($1)", [customerId]); });
    expect(msg).toBe("P0002");
  });

  it("New Link: the old link stops at once and says so; the new one opens their page", async () => {
    if (!needs()) return;
    const old = await tokenOf(customerId);
    await c.query("savepoint rotate");
    await as(staffId);
    const fresh = (await one("select public.portal_link_rotate($1) as t", [customerId])).t as string;
    await asServer();
    expect(fresh).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh).not.toBe(old);
    expect(await tokenOf(customerId)).toBe(fresh);

    const was = await portal(old);
    expect(was?.disabled).toBe(true);
    expect(OFF_ORG_NAME(was)).toBe(orgName);
    expect(was?.customer).toBeUndefined();
    expect(was?.invoices).toBeUndefined();

    const now = await portal(fresh);
    expect(now?.customer?.name).toBe("TEST 0298 portal");
    const stamp = await one("select rotated_by from public.customer_portal_access where customer_id = $1", [customerId]);
    expect(stamp.rotated_by).toBe(staffId);
    await c.query("rollback to savepoint rotate");
  });

  it("Turn Off answers only 'turned off' with the business name; Turn On brings the same link back", async () => {
    if (!needs()) return;
    const token = await tokenOf(customerId);
    await c.query("savepoint toggle");
    await as(staffId);
    await c.query("select public.portal_link_set_enabled($1, false)", [customerId]);
    await asServer();
    const off = await portal(token);
    expect(off?.disabled).toBe(true);
    expect(OFF_ORG_NAME(off)).toBe(orgName);
    expect(Object.keys(off ?? {}).sort()).toEqual(["disabled", "org"]);
    expect(Object.keys(off?.org ?? {})).toEqual(["name"]);

    await as(staffId);
    await c.query("select public.portal_link_set_enabled($1, true)", [customerId]);
    await asServer();
    const on = await portal(token);
    expect(on?.disabled).toBeUndefined();
    expect(on?.customer?.name).toBe("TEST 0298 portal");
    await c.query("rollback to savepoint toggle");
  });

  it("an unknown token gets nothing at all", async () => {
    if (!needs()) return;
    expect(await portal("0".repeat(32))).toBeNull();
    expect(await portal("short")).toBeNull();
  });

  it("Last Opened stamps, at most once a minute, and never on a turned-off link", async () => {
    if (!needs()) return;
    const token = await tokenOf(customerId);
    const opened = async () =>
      (await one("select last_opened_at from public.customer_portal_access where customer_id = $1", [customerId])).last_opened_at as Date | null;
    await c.query("savepoint opens");
    expect(await opened()).toBeNull();
    await c.query("select public.portal_record_open($1)", [token]);
    expect(await opened()).not.toBeNull();

    // Opened 30 seconds ago: another open inside the minute writes nothing.
    await c.query("update public.customer_portal_access set last_opened_at = now() - interval '30 seconds' where customer_id = $1", [customerId]);
    const within = await opened();
    await c.query("select public.portal_record_open($1)", [token]);
    expect((await opened())?.getTime()).toBe(within?.getTime());

    // Two minutes ago: this one counts.
    await c.query("update public.customer_portal_access set last_opened_at = now() - interval '2 minutes' where customer_id = $1", [customerId]);
    const stale = await opened();
    await c.query("select public.portal_record_open($1)", [token]);
    expect((await opened())!.getTime()).toBeGreaterThan(stale!.getTime());

    // Turned off: an open of the dead link stamps nothing.
    await c.query("update public.customer_portal_access set enabled = false, last_opened_at = null where customer_id = $1", [customerId]);
    await c.query("select public.portal_record_open($1)", [token]);
    expect(await opened()).toBeNull();
    await c.query("rollback to savepoint opens");
  });
});
