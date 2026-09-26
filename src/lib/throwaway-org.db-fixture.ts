/**
 * A THROWAWAY COMPANY, MINTED INSIDE THE TEST'S OWN TRANSACTION AND ROLLED BACK WITH IT.
 *
 * The stock suites (stock-bill, stock-take, the Phase 3 cross-check) used to need a pre-made sandbox
 * org (TEST_SANDBOX_ORG) with an active tech and active office staff. There is none, and the day a
 * suite picked "the first org with a tech" it wrote into a live company's books and held its
 * invoice-claim lock. So each run makes its own: an organization, its owner, and its techs, all
 * named TEST, all inside the caller's open transaction - which the caller always rolls back, so
 * nothing here outlives the run. Every fixture the suite then writes names this org's id.
 *
 * THE RULES IT KEEPS:
 *   - Inside a transaction or not at all. It opens a savepoint first; outside a transaction block
 *     Postgres refuses the savepoint, and so this refuses before writing anything.
 *   - As the server, never as a person: it resets the role and the JWT claims before it writes.
 *   - Never a live company. The id is minted, never looked up, and the three live companies are
 *     refused by id anyway (a belt with the braces).
 *   - A person is a real sign-in row (auth.users, then profiles), because RLS and every helper
 *     (is_staff, is_member, auth_org_id) read profiles by auth.uid(). The invite-only gate (0125)
 *     is passed by allowlisting each TEST email in the same transaction. The profile is written
 *     with ON CONFLICT so it lands whether or not handle_new_user already made the row; its
 *     role/org change passes 0225's guard because the row had no org yet (first-time onboarding).
 * No DDL, ever.
 */
import { randomUUID } from "node:crypto";

export interface FixtureSql {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

/** The live companies, refused by id whatever the database hands back. */
export const LIVE_ORGS: ReadonlySet<string> = new Set([
  "60195593-2e18-4230-bc8e-7a32d36d038d", // ET Electric
  "7d6da1e2-c9a0-47d8-bcc1-5b4c3e412fed", // Vivian
  "b4854fcd-50de-46de-a0cb-dff642b4b97b", // TAHOE DECK
]);

export type ThrowawayPerson = { id: string; name: string };
export type ThrowawayOrg = {
  orgId: string;
  /** The owner: office staff, the office bell's recipient. */
  owner: ThrowawayPerson;
  /** Active techs, in the order asked for. */
  techs: ThrowawayPerson[];
};

/**
 * Mint one TEST company in the caller's open transaction: the org, an owner, and `techs` active
 * techs (default 1). Throws, having written nothing, when there is no open transaction.
 */
export async function mintThrowawayOrg(c: FixtureSql, opts: { label: string; techs?: number }): Promise<ThrowawayOrg> {
  try {
    await c.query("savepoint throwaway_org");
  } catch (e) {
    throw new Error(`throwaway org: refused, there is no open transaction to roll it back with (${String((e as Error)?.message ?? e)}). BEGIN first.`);
  }
  try {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
    const tag = randomUUID().slice(0, 8);
    const org = (await c.query("insert into public.organizations (name) values ($1) returning id::text as id", [`TEST throwaway ${opts.label} ${tag}`])).rows[0];
    const orgId = String(org?.id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(orgId)) throw new Error("throwaway org: the organization insert returned no id.");
    if (LIVE_ORGS.has(orgId)) throw new Error("throwaway org: the minted id is a live company's. Refusing.");
    const hasAllowlist = !!(await c.query("select to_regclass('public.signup_allowlist') is not null as ok")).rows[0]?.ok;

    const person = async (role: "owner" | "tech", name: string): Promise<ThrowawayPerson> => {
      const id = randomUUID();
      const email = `test-throwaway-${id}@example.invalid`;
      if (hasAllowlist) {
        await c.query("insert into public.signup_allowlist (email, note) values ($1, 'TEST throwaway org, rolled back') on conflict (email) do nothing", [email]);
      }
      await c.query(
        `insert into auth.users (id, email, aud, role, raw_user_meta_data)
         values ($1, $2, 'authenticated', 'authenticated', jsonb_build_object('full_name', $3::text))`,
        [id, email, name],
      );
      const p = (
        await c.query(
          `insert into public.profiles (id, email, full_name, org_id, role, active)
           values ($1, $2, $3, $4, $5, true)
           on conflict (id) do update
             set email = excluded.email, full_name = excluded.full_name, org_id = excluded.org_id, role = excluded.role, active = true
           returning id::text as id, org_id::text as org_id, role::text as role, active`,
          [id, email, name, orgId, role],
        )
      ).rows[0];
      // Read back, never assumed (the silent-write law).
      if (!p || p.org_id !== orgId || p.role !== role || p.active !== true) throw new Error(`throwaway org: the ${role} profile did not land as asked.`);
      return { id, name };
    };

    const owner = await person("owner", `TEST Owner ${tag}`);
    const techs: ThrowawayPerson[] = [];
    for (let i = 1; i <= Math.max(0, opts.techs ?? 1); i++) techs.push(await person("tech", `TEST Tech ${i} ${tag}`));
    await c.query("release savepoint throwaway_org");
    return { orgId, owner, techs };
  } catch (e) {
    await c.query("rollback to savepoint throwaway_org").catch(() => undefined);
    throw e;
  }
}
