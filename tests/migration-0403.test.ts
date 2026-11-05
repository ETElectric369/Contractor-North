import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A BILL THAT NAMES THE ESTIMATE SETTLES THE WORK (0403, 2026-11-04), read from the migration file the
 * way migration-0402.test.ts reads 0402: public.needs_you_done_not_billed replaced with 0371's rules
 * exactly as they were plus two (an invoice naming one of the job's estimates; a visit on an invoiced
 * job), the same signature and grants, the house self-check — and nothing else. Applied migrations
 * are immutable; 0371 is read, never edited.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};
const flat = (s: string) => s.replace(/\s+/g, " ");
const SIG = "public.needs_you_done_not_billed(timestamptz, timestamptz, integer)";

describe("migration 0403: a bill that names the estimate settles the work", () => {
  const sql = migration("0403_");
  const m0371 = migration("0371_");

  it("is the one 0403", () => {
    expect(readdirSync(migrations).filter((n) => n.startsWith("0403_"))).toEqual(["0403_a_bill_that_names_the_estimate_settles_the_work.sql"]);
  });

  it("names itself, runs under the house timeouts, checks what it stands on, and says it", () => {
    expect(sql).toContain("migration 0403: a bill that names the estimate settles the work");
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toContain(`if to_regprocedure('${SIG}') is null then`);
    expect(sql).toContain("column_name = 'quote_id'");
    expect(sql).toMatch(/raise notice '0403: a bill that names the estimate settles the work/);
    expect((sql.match(/Nothing was changed\./g) ?? []).length).toBeGreaterThanOrEqual(9);
    // It names the code that keeps in step with it.
    expect(sql).toContain("quoteSettled");
    expect(sql).toContain("legacyDoneItems");
    expect(sql).toContain("already-invoiced");
  });

  it("replaces the function with the same signature, columns, security and grants as 0371", () => {
    expect(sql).toContain("create or replace function public.needs_you_done_not_billed(\n  p_visit_from timestamptz,\n  p_job_from timestamptz,\n  p_limit integer default 200\n)");
    const cols = (s: string) => flat(s.slice(s.indexOf("returns table ("), s.indexOf("language sql")));
    expect(cols(sql)).toBe(cols(m0371));
    for (const s of ["language sql", "stable", "security invoker", "set search_path = public"]) expect(sql).toContain(s);
    expect(sql).not.toMatch(/security definer/i);
    expect(sql).toContain(`revoke all on function ${SIG} from public, anon;`);
    expect(sql).toContain(`grant execute on function ${SIG} to authenticated;`);
  });

  it("keeps every one of 0371's rules, word for word", () => {
    const body = (s: string) => flat(s.slice(s.indexOf("as $$"), s.indexOf("$$;", s.indexOf("as $$"))));
    const now = body(sql);
    for (const rule of [
      "select public.auth_org_id() as org_id, public.is_org_staff() as staff",
      "and a.absorbed = false",
      "and a.type in ('service_call', 'job')",
      "and a.status = 'completed'",
      "and a.starts_at >= p_visit_from",
      "and p.amount_paid > 0)",
      "and j.status = 'complete'",
      "and j.updated_at >= p_job_from",
      "b.status not in ('draft', 'void')",
      "order by d.at asc, d.src, d.id",
      "limit greatest(coalesce(p_limit, 200), 0);",
    ]) {
      expect(body(m0371)).toContain(rule);
      expect(now).toContain(rule);
    }
  });

  it("adds the two rules: an invoice naming one of the job's estimates, and the invoiced status", () => {
    const f = flat(sql);
    const named = "join public.quotes q on q.id = n.quote_id and q.org_id = me.org_id";
    expect(f.split(named).length - 1).toBe(2); // the visits arm and the jobs arm
    expect(f).toContain("where q.job_id = a.job_id and n.org_id = me.org_id and n.status not in ('draft', 'void')");
    expect(f).toContain("where q.job_id = j.id and n.org_id = me.org_id and n.status not in ('draft', 'void')");
    expect(f).toContain("and coalesce(j.status::text, '') <> 'invoiced'");
    // The finished-jobs arm still asks nothing about hours, receipts or the billing type.
    const arm = f.slice(f.indexOf("finished_jobs as ("), f.indexOf("done as ("));
    expect(arm).not.toContain("time_entries");
    expect(arm).not.toContain("billing_type");
  });

  it("the self-check proves the function on the database", () => {
    expect(sql).toContain(`v_fn  regprocedure := '${SIG}'::regprocedure;`);
    expect(sql).toContain("if (select prosecdef from pg_proc where oid = v_fn) then");
    expect(sql).toContain("if (select provolatile from pg_proc where oid = v_fn) <> 's' then");
    expect(sql).toContain("position('join public.quotes q on q.id = n.quote_id' in v_src) = 0");
    expect(sql).toContain("position('<> ''invoiced''' in v_src) = 0");
    expect(sql).toContain("if has_function_privilege('anon', v_fn, 'execute') then");
    expect(sql).toContain("if not has_function_privilege('authenticated', v_fn, 'execute') then");
  });

  it("changes nothing else: no table, no policy, no trigger, no row", () => {
    expect((sql.match(/create (or replace )?function/gi) ?? []).length).toBe(1);
    expect(sql).not.toMatch(/drop function|drop table|drop index|drop column|drop policy|drop trigger/i);
    expect(sql).not.toMatch(/create policy|create trigger|create table|create index|alter table/i);
    expect(sql).not.toMatch(/\bupdate public\.\w+\s+set\b/i);
    expect(sql).not.toMatch(/\binsert into\b|\bdelete from\b/i);
    // 0371 itself is untouched (applied migrations are immutable).
    expect(m0371).not.toContain("0403");
    expect(m0371).not.toContain("n.quote_id");
  });
});
