import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A WORKER READS HIS OWN PAY PERIODS (0410; cn-v1166. The owner, 2026-11-16: "yes for tech sees all
 * their own data and past pay periods"), read from the migration file the way migration-0409.test.ts
 * reads 0409. One thing and nothing else: payroll_runs_read becomes "own company, and staff or his own
 * row", the shape pay_payments has had since 0264. The write policy (0062) is not named.
 *
 * NO DATABASE RUNS HERE. What this file can prove is the text: the one policy it makes, that it makes
 * nothing else, and that its self-check refuses the shapes it says it refuses. That the SQL does what
 * it says is src/app/(app)/timeclock/my-pay.integration.test.ts and the migration's own self-check.
 * Applied migrations are immutable: 0410 is pinned the day it is applied.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const names = readdirSync(migrations).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
const migration = (prefix: string) => {
  const f = names.find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};
/** The statements alone, without the header's words. */
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("migration 0410: a worker reads his own pay periods", () => {
  const sql = migration("0410_");
  const code = noComments(sql);

  it("is the one 0410, named for what it does, and takes its locks with a timeout (what sits past it is the newest migration's own test: migration-0411.test.ts)", () => {
    expect(names.filter((n) => n.startsWith("0410_"))).toEqual(["0410_a_worker_reads_his_own_pay_periods.sql"]);
    expect(code).toContain("set local lock_timeout = '3s';");
    expect(code).toContain("set local statement_timeout = '15s';");
    // The same opening 0409 has.
    expect(migration("0409_")).toContain("set local lock_timeout = '3s';");
  });

  it("names its reader the day it is added", () => {
    expect(sql).toContain("THE READER, named the day it is added: src/app/(app)/timeclock/pay (My Pay Periods).");
  });

  it("re-makes payroll_runs_read as: own company, and staff or his own row; for select only", () => {
    expect(squash(code)).toContain(
      squash(`drop policy if exists payroll_runs_read on public.payroll_runs;
create policy payroll_runs_read on public.payroll_runs
  for select using (
    org_id = public.auth_org_id()
    and (public.is_org_staff() or profile_id = auth.uid())
  );`),
    );
    // It is pay_payments' read, word for word but the table (0264).
    expect(squash(noComments(migration("0264_")))).toContain(
      "create policy pay_payments_read on public.pay_payments for select using (org_id = public.auth_org_id() and (public.is_org_staff() or profile_id = auth.uid()));",
    );
  });

  it("does nothing else: no write policy, no table, no column, no grant, no function, no index", () => {
    const statements = code
      .replace(/do \$\$[\s\S]*?end \$\$;/g, "")
      // A literal's own semicolons are words, not the end of a statement.
      .replace(/'(?:[^']|'')*'/g, "''")
      .split(";")
      .map((s) => squash(s))
      .filter(Boolean);
    expect(statements.map((s) => s.split(" ").slice(0, 3).join(" "))).toEqual([
      "set local lock_timeout",
      "set local statement_timeout",
      "drop policy if",
      "create policy payroll_runs_read",
      "comment on policy",
    ]);
    const bare = code.replace(/'(?:[^']|'')*'/g, "''");
    expect(bare).not.toMatch(/payroll_runs_write/);
    expect(bare).not.toMatch(/\b(alter table|create table|grant|revoke|create index|create or replace function|insert|update|delete)\b/i);
  });

  it("the comment says writes stay staff-only", () => {
    expect(code).toContain(
      "'Staff read the company''s pay runs; anyone else only his own (0410), so a worker''s statement reads each locked period at the gross it locked at. Writes stay staff-only (payroll_runs_write, 0062).'",
    );
    // 0062's write policy, which this does not touch, is staff-only on both sides.
    expect(squash(noComments(migration("0062_")))).toContain(
      "create policy payroll_runs_write on public.payroll_runs for all using (org_id = public.auth_org_id() and public.is_org_staff()) with check (org_id = public.auth_org_id() and public.is_org_staff());",
    );
  });

  it("checks its ground first and changes nothing when it is missing", () => {
    for (const need of ["to_regclass('public.payroll_runs') is null", "to_regprocedure('public.auth_org_id()') is null", "to_regprocedure('public.is_org_staff()') is null"]) {
      expect(code, need).toContain(need);
    }
    expect(code.indexOf("to_regclass('public.payroll_runs')")).toBeLessThan(code.indexOf("drop policy"));
  });

  it("checks itself after: row security on, one select policy, its shape, and every write policy staff-only", () => {
    const after = code.slice(code.indexOf("comment on policy"));
    expect(after).toContain("select relrowsecurity from pg_class where oid = 'public.payroll_runs'::regclass");
    expect(after).toContain("tablename = 'payroll_runs' and cmd = 'SELECT') <> 1");
    for (const part of ["position('auth_org_id()' in v_qual) = 0", "position('auth.uid()' in v_qual) = 0", "position('is_org_staff()' in v_qual) = 0"]) {
      expect(after, part).toContain(part);
    }
    expect(squash(after)).toContain("cmd <> 'SELECT' and (coalesce(position('is_org_staff()' in qual), 0) = 0 or coalesce(position('is_org_staff()' in with_check), 0) = 0)");
    expect((after.match(/raise exception '0410: [^']*Nothing was changed\.'/g) ?? []).length).toBe(4);
  });
});
