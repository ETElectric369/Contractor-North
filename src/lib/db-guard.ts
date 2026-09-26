/**
 * THE ONE DB GUARD. Every database integration suite calls assertTestDatabase(client) right after
 * client.connect(), before it runs a single statement of its own.
 *
 * The suites write (inside rolled-back transactions, but they write, and they hold locks while they
 * do). For months TEST_DB_* pointed at production, so they wrote there. This makes that impossible:
 * it THROWS, it never skips, unless BOTH hold:
 *   (a) the connection's user is the test project's pooler user (postgres.olmehzbhtzegjxgswgyk).
 *       The Supabase pooler routes on the tenant suffix of that user, so this names the project.
 *   (b) public.cn_test_database_marker holds exactly one row, 'contractor-north-test'. Only the test
 *       database has that table (scripts/test-db/rebuild.cjs made it on an empty schema).
 *
 * tests/db-guard.test.ts proves every suite calls it; CI runs scripts/test-db/check-test-db.cjs
 * (the same two checks) before npm test.
 */

export const TEST_DB_USER_NAME = "postgres.olmehzbhtzegjxgswgyk";
export const TEST_DB_MARKER = "contractor-north-test";

export interface GuardedClient {
  user?: string | undefined;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

export async function assertTestDatabase(c: GuardedClient): Promise<void> {
  if (c.user !== TEST_DB_USER_NAME) {
    throw new Error(
      `DB guard: this suite is connected as ${c.user ?? "(no user)"}, not the test database's user ${TEST_DB_USER_NAME}. ` +
        "Point TEST_DB_HOST / TEST_DB_USER / TEST_DBPW at the contractor-north-test project. Refusing to run.",
    );
  }
  const present = (await c.query("select to_regclass('public.cn_test_database_marker') is not null as ok")).rows[0]?.ok === true;
  const rows = present ? (await c.query("select value from public.cn_test_database_marker")).rows : [];
  if (rows.length !== 1 || rows[0]?.value !== TEST_DB_MARKER) {
    throw new Error(
      `DB guard: public.cn_test_database_marker does not hold exactly one '${TEST_DB_MARKER}' row on this database ` +
        `(${present ? `${rows.length} row(s)` : "no marker table"}). This is not the test database. Refusing to run.`,
    );
  }
}

/**
 * A case whose migration is not on this database. On the Mac that is a warning and the case does not
 * run (a branch's suite before its migration is applied to the test database). In CI it FAILS: CI
 * checks the test database carries every file in supabase/migrations before npm test
 * (scripts/test-db/check-test-db.cjs), so a case that still finds its migration missing there would
 * otherwise pass having asserted nothing (audit v1018, class 10). Every suite's ready()/needs() gate
 * goes through here; tests/db-guard.test.ts pins that no suite merely warns.
 */
export function notOnThisDatabase(message: string): false {
  if (process.env.CI) {
    throw new Error(`${message} In CI the test database carries every migration, so this case must run: fix its check, or run node scripts/test-db/rebuild.cjs.`);
  }
  console.warn(message);
  return false;
}

/**
 * PRODUCTION REPLAYS (*.prod-replay.test.ts) are the one exception, and they cannot write: they read
 * a live company's books to prove a plan against real data. They connect with REPLAY_DB_HOST /
 * REPLAY_DB_USER / REPLAY_DBPW (never TEST_DB_*), run only when their opt-in flag is set, never in
 * CI, and every one calls this right after connect: the session is made read-only before its first
 * statement, and read back. tests/db-guard.test.ts proves each replay calls it and opens every
 * transaction READ ONLY.
 */
export async function assertReadOnlyReplay(c: GuardedClient): Promise<void> {
  if (process.env.CI) throw new Error("Replay guard: a production replay never runs in CI. Refusing.");
  await c.query("set session characteristics as transaction read only");
  const ro = (await c.query("show default_transaction_read_only")).rows[0]?.default_transaction_read_only;
  if (ro !== "on") throw new Error(`Replay guard: the session did not become read-only (default_transaction_read_only = ${ro}). Refusing.`);
}
