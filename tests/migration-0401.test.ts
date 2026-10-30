import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * ONE USAGE WINDOW, TOPPED UP (0401, cn-v1140), read from the migration file the way
 * migration-0400.test.ts reads 0400: the top-ups table (service role only, RLS on with its one
 * deny-all policy in 0163's shape, the session unique), the webhook's idempotent write, the
 * month's top-up total, the ledger's calendar-month read beside the rolling one — and that it
 * leaves 0001–0400 alone (applied migrations are immutable; the DB proof is
 * src/lib/usage-topups.integration.test.ts against the test database).
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

/** The three functions 0401 may define, and no other. */
const ALLOWED_FUNCTIONS = ["add_usage_topup", "usage_topup_total", "ai_spend_from"] as const;

const ADD = "public.add_usage_topup(uuid, text, numeric, text)";
const TOTAL = "public.usage_topup_total(uuid, text)";
const FROM = "public.ai_spend_from(uuid, date)";

/** The refusals, as the SQL spells them. */
const REFUSALS = {
  noSession: "A usage top-up needs its checkout session.",
  badMonth: "A usage top-up needs its month as YYYY-MM.",
  nothing: "A usage top-up must add something.",
  noCompany: "No such company for a usage top-up.",
} as const;

describe("migration 0401: one usage window, topped up", () => {
  const sql = migration("0401_");
  const m0162 = migration("0162_");
  const m0400 = migration("0400_");

  it("is the one 0401 and nothing sits past it", () => {
    const names = readdirSync(migrations);
    expect(names.filter((n) => n.startsWith("0401_"))).toEqual(["0401_one_usage_window_topped_up.sql"]);
    expect(names.some((n) => /^040[2-9]_|^04[1-9]\d_|^0[5-9]\d\d_/.test(n))).toBe(false);
  });

  it("exists, names itself, and runs under the house timeouts", () => {
    expect(sql).toContain("migration 0401: one usage window, topped up");
    expect(sql).toContain("set local lock_timeout = '3s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toMatch(/raise notice '0401: one usage window, topped up/);
    // Every precondition miss says what it is and that nothing moved.
    expect((sql.match(/Nothing was changed\./g) ?? []).length).toBeGreaterThanOrEqual(18);
    // The preconditions: the ledger this reads, and the rolling read it leaves beside the new one.
    expect(sql).toContain("if to_regclass('public.ai_usage') is null then");
    expect(sql).toContain("if to_regprocedure('public.ai_spend_since(uuid, integer)') is null then");
  });

  describe("the table: one row per top-up, service role only", () => {
    const table = sql.slice(sql.indexOf("create table if not exists public.usage_topups"), sql.indexOf("comment on table public.usage_topups"));

    it("is created twice-safe with the six columns, the two checks, the unique session and the company's cascade", () => {
      expect(table).toContain("create table if not exists public.usage_topups (");
      expect(table).toContain("id                 uuid primary key default gen_random_uuid(),");
      expect(table).toContain("org_id             uuid not null references public.organizations(id) on delete cascade,");
      expect(table).toContain("month              text not null check (month ~ '^\\d{4}-(0[1-9]|1[0-2])$'),");
      expect(table).toContain("usage_usd          numeric(12,6) not null check (usage_usd > 0),");
      expect(table).toContain("stripe_session_id  text not null unique,");
      expect(table).toContain("created_at         timestamptz not null default now()");
      expect(table).toContain("create index if not exists usage_topups_org_month_idx on public.usage_topups (org_id, month);");
    });

    it("has RLS on with exactly one deliberate deny-all policy, in 0163's shape, and says why", () => {
      expect(table).toContain("alter table public.usage_topups enable row level security;");
      expect(table).toContain("drop policy if exists usage_topups_deny_all on public.usage_topups;");
      expect(table).toContain("create policy usage_topups_deny_all on public.usage_topups\n  for all\n  using (false)\n  with check (false);");
      expect((sql.match(/create policy/g) ?? []).length).toBe(1);
      expect(sql).toContain("comment on policy usage_topups_deny_all on public.usage_topups is");
      expect(sql).toContain("the RLS invariant in CI requires every org-scoped table to carry a policy");
      // The self-check reads the policy back: one, and the deny.
      expect(sql).toContain("if v_n <> 1 or not exists (");
      expect(sql).toContain("policyname = 'usage_topups_deny_all' and qual = 'false' and with_check = 'false'");
      expect(sql).toContain("raise exception '0401: usage_topups must carry exactly its deny-all policy and no other. Nothing was changed.';");
    });

    it("the self-check proves the columns, both checks, the unique session, the foreign key, the index and RLS on the database", () => {
      expect(sql).toContain("foreach v_col in array array['id', 'org_id', 'month', 'usage_usd', 'stripe_session_id', 'created_at'] loop");
      expect(sql).toContain("contype = 'c';");
      expect(sql).toContain("= array['stripe_session_id']");
      expect(sql).toContain("contype = 'f' and confrelid = 'public.organizations'::regclass");
      expect(sql).toContain("indexname = 'usage_topups_org_month_idx'");
      expect(sql).toContain("if not (select relrowsecurity from pg_class where oid = 'public.usage_topups'::regclass) then");
    });

    it("a tenant never sees a dollar: the comments say it is North's meter, service role only", () => {
      expect(sql).toMatch(/comment on table public\.usage_topups is\n\s+'[^;]*Service role only/);
      expect(sql).toMatch(/a tenant never sees a dollar/);
    });
  });

  describe("the webhook's one write: add_usage_topup", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.add_usage_topup"), sql.indexOf("comment on function public.add_usage_topup"));

    it("answers jsonb {id, inserted}, lands once per session, and the second delivery says inserted=false with the row's id", () => {
      expect(fn).toContain("returns jsonb");
      expect(fn).toContain("insert into public.usage_topups (org_id, month, usage_usd, stripe_session_id)");
      expect(fn).toContain("values (p_org, p_month, p_usd, btrim(p_session))");
      expect(fn).toContain("on conflict (stripe_session_id) do nothing");
      expect(fn).toContain("returning id into v_id;");
      expect(fn).toContain("return jsonb_build_object('id', v_id, 'inserted', true);");
      expect(fn).toContain("select t.id into v_id from public.usage_topups t where t.stripe_session_id = btrim(p_session);");
      expect(fn).toContain("return jsonb_build_object('id', v_id, 'inserted', false);");
    });

    it("refuses a blank session, a bad month, nothing added and an unknown company, each in words", () => {
      expect(fn).toContain("if p_session is null or btrim(p_session) = '' then");
      expect(fn).toContain(`raise exception '${REFUSALS.noSession}' using errcode = '22023';`);
      expect(fn).toContain("if p_month is null or p_month !~ '^\\d{4}-(0[1-9]|1[0-2])$' then");
      expect(fn).toContain(`raise exception '${REFUSALS.badMonth}' using errcode = '22023';`);
      expect(fn).toContain("if p_usd is null or p_usd <= 0 then");
      expect(fn).toContain(`raise exception '${REFUSALS.nothing}' using errcode = '22023';`);
      expect(fn).toContain("if not exists (select 1 from public.organizations o where o.id = p_org) then");
      expect(fn).toContain(`raise exception '${REFUSALS.noCompany}' using errcode = '22023';`);
      for (const words of Object.values(REFUSALS)) {
        expect(words).toMatch(/^(A |No )/);
        expect(words).not.toMatch(/_|0\d{3}/);
      }
      // The body is read back from the database, not only the file.
      expect(sql).toContain("position('on conflict (stripe_session_id) do nothing' in pg_get_functiondef(");
      expect(sql).toContain(`position('${REFUSALS.noSession}' in pg_get_functiondef(`);
    });
  });

  describe("the two reads", () => {
    it("usage_topup_total sums one company's one month, 0 when none", () => {
      const fn = sql.slice(sql.indexOf("create or replace function public.usage_topup_total"), sql.indexOf("comment on function public.usage_topup_total"));
      expect(fn).toContain("returns numeric");
      expect(fn).toContain("stable");
      expect(fn).toContain("select coalesce(sum(t.usage_usd), 0)");
      expect(fn).toContain("where t.org_id = p_org");
      expect(fn).toContain("and t.month = p_month;");
    });

    it("ai_spend_from sums the ledger from a date, in ai_spend_since's shape, and leaves ai_spend_since in place", () => {
      const fn = sql.slice(sql.indexOf("create or replace function public.ai_spend_from"), sql.indexOf("comment on function public.ai_spend_from"));
      expect(fn).toContain("returns numeric");
      expect(fn).toContain("stable");
      expect(fn).toContain("select coalesce(sum(u.cost_usd), 0)");
      expect(fn).toContain("from public.ai_usage u");
      expect(fn).toContain("where u.org_id = p_org_id");
      expect(fn).toContain("and u.usage_date >= p_from;");
      // The rolling read (0162) is the ceiling's; the self-check sees it still there.
      expect(sql).toContain("if to_regprocedure('public.ai_spend_since(uuid, integer)') is null then\n    raise exception '0401: ai_spend_since (0162) went missing");
      expect(m0162).toContain("create or replace function public.ai_spend_since(p_org_id uuid, p_days integer)");
      expect(m0162).not.toContain("ai_spend_from");
      // The few-hour edge is said where the read is defined.
      expect(sql).toMatch(/usage_date is the UTC date of each call/);
    });
  });

  it("every function is SECURITY DEFINER with its search_path pinned, revoked from public, anon and authenticated, granted to the service role — and the self-check proves it", () => {
    expect((sql.match(/^security definer$/gm) ?? []).length).toBe(3);
    expect((sql.match(/^set search_path = public, pg_temp$/gm) ?? []).length).toBe(3);
    for (const fn of [ADD, TOTAL, FROM]) {
      expect(sql).toContain(`revoke execute on function ${fn} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${fn} to service_role;`);
    }
    expect(sql).toContain(`foreach v_fn in array array['${ADD}', '${TOTAL}', '${FROM}'] loop`);
    expect(sql).toContain("p.proconfig @> array['search_path=public, pg_temp']");
    expect(sql).toContain("has_function_privilege('anon', v_fn, 'execute')");
    expect(sql).toContain("has_function_privilege('authenticated', v_fn, 'execute')");
    expect(sql).toContain("has_function_privilege('service_role', v_fn, 'execute')");
    // No grant to authenticated anywhere: nothing here is a signed-in door.
    expect(sql).not.toMatch(/grant execute on function [^;]* to authenticated;/);
  });

  it("leaves 0001–0400 alone: no trigger touched, no other function defined or dropped, only its own table made, nothing updated", () => {
    expect(sql).not.toMatch(/drop trigger/i);
    expect(sql).not.toMatch(/create trigger/i);
    const defined = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual([...ALLOWED_FUNCTIONS].sort());
    expect(sql).not.toMatch(/drop function/i);
    expect(sql).not.toMatch(/drop table|drop index/i);
    expect(sql).not.toMatch(/alter table public\.(?!usage_topups\b)/i);
    expect(sql).not.toMatch(/create table (if not exists )?public\.(?!usage_topups\b)/i);
    expect(sql.match(/^create index/gim)?.length).toBe(1); // the essay names the statement once more, in capitals
    expect(sql).toContain("create index if not exists usage_topups_org_month_idx on public.usage_topups (org_id, month);");
    expect(sql).not.toMatch(/\bupdate public\.\w+\s+set\b/i);
    expect(sql).not.toMatch(/\bdelete from\b/i);
    // 0162 and 0400 themselves are untouched (applied migrations are immutable).
    expect(m0162).toContain("Migration 0162: the AI meter");
    expect(m0162).not.toContain("usage_topups");
    expect(m0400).toContain("Contractor North — migration 0400: the trial warns, the lapse keeps the lights on");
    expect(m0400).not.toContain("usage_topups");
  });
});
