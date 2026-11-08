import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A JOB KNOWS WHERE IT IS (0404, the clock-in picks the job you are standing at), read from the
 * migration file the way migration-0402.test.ts reads 0402: two nullable numeric(9,6) coordinates
 * and a nullable stamp on jobs, each coordinate with its own named range check, one trigger that
 * clears them when the address moves, twice-safe, said in the house voice — and nothing else: no
 * policy, no grant, no other table, no row. Applied migrations are immutable.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

describe("migration 0404: a job knows where it is", () => {
  const sql = migration("0404_");
  /** The statements alone, without the header's words. */
  const code = sql.replace(/--.*$/gm, "");

  it("is the one 0404 (what sits past it is the newest migration's own test: migration-0405.test.ts)", () => {
    const names = readdirSync(migrations);
    expect(names.filter((n) => n.startsWith("0404_"))).toEqual(["0404_a_job_knows_where_it_is.sql"]);
  });

  it("exists, names itself, and runs under the house timeouts", () => {
    expect(sql).toContain("migration 0404: a job knows where it is");
    expect(sql).toContain("set local lock_timeout = '3s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toMatch(/raise notice '0404: a job knows where it is/);
    expect((sql.match(/Nothing was changed\./g) ?? []).length).toBeGreaterThanOrEqual(7);
    expect(sql).toContain("if to_regclass('public.jobs') is null then");
  });

  it("adds the three columns twice-safe: two ranged numeric(9,6) and a timestamptz, all nullable, no default", () => {
    expect(sql).toContain(
      "alter table public.jobs add column if not exists geo_lat numeric(9,6)\n  constraint jobs_geo_lat_range check (geo_lat is null or (geo_lat >= -90 and geo_lat <= 90));",
    );
    expect(sql).toContain(
      "alter table public.jobs add column if not exists geo_lng numeric(9,6)\n  constraint jobs_geo_lng_range check (geo_lng is null or (geo_lng >= -180 and geo_lng <= 180));",
    );
    expect(sql).toContain("alter table public.jobs add column if not exists geocoded_at timestamptz;");
    expect((sql.match(/add column if not exists/g) ?? []).length).toBe(3);
    expect(sql).not.toMatch(/add column (?!if not exists)/);
    expect(code).not.toMatch(/not null|\bdefault\b/i);
    for (const c of ["geo_lat", "geo_lng", "geocoded_at"]) expect(sql).toContain(`comment on column public.jobs.${c} is`);
  });

  it("one trigger clears a place when its address moves, and only when it does", () => {
    expect(sql).toContain("create or replace function public.jobs_geo_follows_address()");
    expect(sql).toContain("set search_path = public");
    expect(sql).toContain("drop trigger if exists jobs_geo_follows_address on public.jobs;");
    expect(sql).toContain("create trigger jobs_geo_follows_address before update of address, city, state, zip on public.jobs");
    for (const c of ["address", "city", "state", "zip"]) expect(sql).toContain(`new.${c} is distinct from old.${c}`);
    expect(sql).toContain("new.geocoded_at := null;");
    expect(sql).not.toMatch(/security definer/i);
  });

  it("the self-check proves the columns, the checks, the trigger and jobs' RLS on the database", () => {
    expect(sql).toContain("and data_type = 'numeric' and numeric_precision = 9 and numeric_scale = 6 and is_nullable = 'YES'");
    expect(sql).toContain("and data_type = 'timestamp with time zone' and is_nullable = 'YES'");
    expect(sql).toContain("foreach v_con in array array['jobs_geo_lat_range', 'jobs_geo_lng_range'] loop");
    expect(sql).toContain("tgname = 'jobs_geo_follows_address' and not tgisinternal");
    expect(sql).toContain("if not (select relrowsecurity from pg_class where oid = 'public.jobs'::regclass) then");
  });

  it("names its readers the day they are added", () => {
    expect(sql).toContain("coordinatesOfJobs");
    expect(sql).toContain("resolveTechJobToday");
    expect(sql).toContain("which-job-actions");
  });

  it("changes nothing else: no policy, no grant, no other table, no row", () => {
    expect(sql).not.toMatch(/drop function|drop table|drop index|drop column|drop policy/i);
    expect(sql).not.toMatch(/create policy|create table|create index/i);
    expect(sql).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(sql).not.toMatch(/alter table public\.(?!jobs\b)/i);
    expect(sql).not.toMatch(/enable row level security|disable row level security/i);
    expect(sql).not.toMatch(/\bupdate public\.\w+\s+set\b/i);
    expect(sql).not.toMatch(/\binsert into\b|\bdelete from\b/i);
  });
});
