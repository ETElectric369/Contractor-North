import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE TRIAL WARNS, THE LAPSE KEEPS THE LIGHTS ON (0400, cn-v1137), read from the migration file the
 * way migration-0399.test.ts reads 0399: the three columns (the "told once" ledger, the comp, Both
 * Are Real), the organizations_update policy re-created from 0181 VERBATIM plus the three clauses it
 * never knew, the lock and the eraser (service role only), the comp door (admin checked inside, one
 * audit row) — and that it leaves 0001–0399 alone (applied migrations are immutable; the DB proof is
 * src/lib/billing-state.integration.test.ts against the test database).
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

/** The three functions 0400 may define, and no other. */
const ALLOWED_FUNCTIONS = ["claim_billing_notice", "release_billing_notice", "platform_set_comped_until"] as const;

const CLAIM = "public.claim_billing_notice(uuid, text)";
const RELEASE = "public.release_billing_notice(uuid, text)";
const COMP = "public.platform_set_comped_until(uuid, timestamptz)";

/** The refusals, as the SQL spells them (an escaped apostrophe). */
const REFUSALS = {
  notAdmin: "Only North''s own team can comp a company.",
  noKey: "A billing notice needs a key.",
} as const;

describe("migration 0400: the trial warns, the lapse keeps the lights on", () => {
  const sql = migration("0400_");
  const m0181 = migration("0181_");

  it("exists, names itself, and runs under the house timeouts", () => {
    expect(sql).toContain("migration 0400: the trial warns, the lapse keeps the lights on");
    expect(sql).toContain("set local lock_timeout = '3s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toMatch(/raise notice '0400: the trial warns, the lapse keeps the lights on/);
    // Every precondition miss says what it is and that nothing moved.
    expect((sql.match(/Nothing was changed\./g) ?? []).length).toBeGreaterThanOrEqual(20);
  });

  it("adds the three columns, twice-safe, each with its comment", () => {
    expect(sql).toContain("alter table public.organizations add column if not exists billing_notices jsonb not null default '{}'::jsonb;");
    expect(sql).toContain("alter table public.organizations add column if not exists comped_until timestamptz null;");
    expect(sql).toContain("alter table public.bills add column if not exists both_real_at timestamptz null;");
    expect(sql).toContain("comment on column public.organizations.billing_notices is");
    expect(sql).toContain("comment on column public.organizations.comped_until is");
    expect(sql).toContain("comment on column public.bills.both_real_at is");
    // The ledger's keys, named where the column is explained.
    for (const k of ["trial_7", "trial_3", "trial_1", "trial_0", "lapsed", "grace_3:<period_end>", "grace_1:<period_end>", "past_due:<period_end>"]) expect(sql).toContain(k);
  });

  describe("the pin: organizations_update from 0181, verbatim, plus three clauses", () => {
    const policy = sql.slice(sql.indexOf("drop policy if exists organizations_update"), sql.indexOf("comment on policy organizations_update"));

    it("is dropped only after the pre-check saw it, then re-created for update", () => {
      expect(sql).toContain("policyname = 'organizations_update') then");
      expect(sql).toContain("raise exception '0400: the organizations_update policy (0181) is not on this database; there is nothing to re-create. Nothing was changed.';");
      expect(sql.indexOf("policyname = 'organizations_update') then")).toBeLessThan(sql.indexOf("drop policy if exists organizations_update on public.organizations;"));
      expect(policy).toContain("drop policy if exists organizations_update on public.organizations;");
      expect(policy).toContain("create policy organizations_update on public.organizations\n  for update");
      expect((sql.match(/create policy/g) ?? []).length).toBe(1);
    });

    it("carries 0181's roles (owner, admin, OFFICE) in both using and with check", () => {
      const roles = "app_user_role() = any (array['owner'::user_role, 'admin'::user_role, 'office'::user_role])";
      expect((policy.match(new RegExp(roles.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(2);
      expect(policy).toContain("using (\n    id = auth_org_id()\n    and " + roles + "\n  )");
    });

    it("carries 0181's eleven billing clauses byte for byte", () => {
      const clauses = m0181.split("\n").filter((l) => /^\s+and not \(\w+\s+is distinct from \(select o\.\w+\s+from organizations o where o\.id = organizations\.id\)\)$/.test(l));
      expect(clauses).toHaveLength(11);
      for (const c of clauses) expect(policy, c).toContain(c);
      for (const col of [
        "subscription_status",
        "trial_ends_at",
        "current_period_end",
        "plan",
        "stripe_customer_id",
        "stripe_subscription_id",
        "stripe_price_id",
        "stripe_account_id",
        "stripe_account_status",
        "stripe_charges_enabled",
        "stripe_platform_fee_bps",
      ]) {
        expect(clauses.some((c) => c.includes(`(${col} `) || c.includes(`(${col}\t`))).toBe(true);
      }
    });

    it("adds the ledger and the comp in the same shape: no signed-in writer may move them", () => {
      expect(policy).toContain("and not (billing_notices      is distinct from (select o.billing_notices      from organizations o where o.id = organizations.id))");
      expect(policy).toContain("and not (comped_until         is distinct from (select o.comped_until         from organizations o where o.id = organizations.id))");
    });

    it("pins a SET Terminal Location (0252) against a repoint, and lets the lazy first fill through", () => {
      // The first fill (null → tml_…) is ensureTerminalLocation's own write with the staff member's
      // client; the full shape would have refused it and broken every company's first Tap to Pay.
      expect(policy).toContain("and not (stripe_terminal_location_id is distinct from (select o.stripe_terminal_location_id from organizations o where o.id = organizations.id)");
      expect(policy).toContain("and (select o.stripe_terminal_location_id from organizations o where o.id = organizations.id) is not null)");
      expect(sql).toContain("ensureTerminalLocation (billing/tap-actions.ts)");
    });

    it("says why the service role and the RPCs are the only writers, and the self-check reads the policy back", () => {
      expect(sql).toMatch(/SERVICE ROLE \(the notices[\s-]+cron and the Stripe webhook, which RLS does not bind\)/);
      expect(sql).toContain("select p.with_check, p.qual into v_check, v_using");
      for (const col of ["'billing_notices'", "'comped_until'", "'stripe_terminal_location_id'"]) expect(sql).toContain(col);
      expect(sql).toContain("raise exception '0400: organizations_update does not pin %. Nothing was changed.', v_fn;");
      expect(sql).toContain("raise exception '0400: the office seat (0181) fell out of organizations_update. Nothing was changed.';");
    });
  });

  describe("the lock and the eraser", () => {
    const claim = sql.slice(sql.indexOf("create or replace function public.claim_billing_notice"), sql.indexOf("comment on function public.claim_billing_notice"));
    const release = sql.slice(sql.indexOf("create or replace function public.release_billing_notice"), sql.indexOf("comment on function public.release_billing_notice"));

    it("claim: stamps the key with now() only when it is not there, and answers found", () => {
      expect(claim).toContain("returns boolean");
      expect(claim).toContain("set billing_notices = billing_notices || jsonb_build_object(p_key, to_jsonb(now()))");
      expect(claim).toContain("and not (billing_notices ? p_key);");
      expect(claim).toContain("return found;");
      expect(claim).toContain(`raise exception '${REFUSALS.noKey}' using errcode = '22023';`);
    });

    it("release: removes the key only when it is there, and answers found", () => {
      expect(release).toContain("returns boolean");
      expect(release).toContain("set billing_notices = billing_notices - p_key");
      expect(release).toContain("and (billing_notices ? p_key);");
      expect(release).toContain("return found;");
    });

    it("both are service role only: revoked from public, anon and authenticated", () => {
      expect(sql).toContain(`revoke execute on function ${CLAIM} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${CLAIM} to service_role;`);
      expect(sql).toContain(`revoke execute on function ${RELEASE} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${RELEASE} to service_role;`);
    });
  });

  it("the comp door: platform admins only, refused in words, null clears, one audit row in 0398's shape", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.platform_set_comped_until"), sql.indexOf("comment on function public.platform_set_comped_until"));
    expect(fn).toContain("returns boolean");
    expect(fn).toContain("if not public.is_platform_admin() then");
    expect(fn).toContain(`raise exception '${REFUSALS.notAdmin}' using errcode = '42501';`);
    expect(fn).toContain("select o.comped_until into v_prev from public.organizations o where o.id = p_org for update;");
    expect(fn).toContain("update public.organizations set comped_until = p_until where id = p_org;");
    expect(fn).toContain("insert into public.agent_audit_log (org_id, user_id, action, risk, effect, ok, input_summary, source)");
    expect(fn).toContain("values (p_org, auth.uid(), 'comp.set', 1, 'write', true,");
    expect(fn).toContain("jsonb_build_object('from', v_prev, 'to', p_until), 'ui');");
    expect(fn).toContain("return false;");
    expect(fn).toContain("return true;");
    expect(sql).toContain(`revoke execute on function ${COMP} from public, anon;`);
    expect(sql).toContain(`grant execute on function ${COMP} to authenticated;`);
    for (const words of Object.values(REFUSALS)) {
      expect(words).toMatch(/^(Only |A )/);
      expect(words).not.toMatch(/_|0\d{3}/);
    }
  });

  it("every SECURITY DEFINER function pins its search_path, and the self-check proves the grants on the database", () => {
    expect((sql.match(/^security definer$/gm) ?? []).length).toBe(3);
    expect((sql.match(/^set search_path = public, pg_temp$/gm) ?? []).length).toBe(3);
    expect(sql).toContain("p.proconfig @> array['search_path=public, pg_temp']");
    expect(sql).toContain("has_function_privilege('anon', v_fn, 'execute')");
    expect(sql).toContain("has_function_privilege('authenticated', v_fn, 'execute')");
    expect(sql).toContain("has_function_privilege('service_role', v_fn, 'execute')");
    expect(sql).toContain(`if not has_function_privilege('authenticated', '${COMP}', 'execute') then`);
    // The comp door's body is read back from the database: the admin check and the audit row.
    expect(sql).toContain("position('is_platform_admin' in pg_get_functiondef(");
    expect(sql).toContain("position('agent_audit_log' in pg_get_functiondef(");
  });

  it("leaves 0001–0399 alone: no trigger touched, no other function defined or dropped, only the two tables altered", () => {
    expect(sql).not.toMatch(/drop trigger/i);
    expect(sql).not.toMatch(/create trigger/i);
    const defined = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual([...ALLOWED_FUNCTIONS].sort());
    expect(sql).not.toMatch(/drop function/i);
    expect(sql).not.toMatch(/drop table|alter table public\.(?!organizations\b|bills\b)/i);
    expect(sql).not.toMatch(/drop index|create index/i);
    // Every UPDATE in the file is one company's row by p_org: no backfill, no sweep.
    expect(sql).not.toMatch(/\bupdate public\.\w+\s+set\b(?![^;]*where id = p_org)/i);
    // 0181 itself is untouched (applied migrations are immutable): the policy it holds is what 0400 copies.
    expect(m0181).toContain("Contractor North — migration 0181: the office manager's saves actually land");
    expect(m0181).not.toContain("billing_notices");
  });
});
