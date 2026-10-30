import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE PANEL DOOR IS MEASURED (0402, the panel-first wave), read from the migration file the way
 * migration-0401.test.ts reads 0401: three nullable numbers on job_panels (a space's height, the
 * label area's width beside each column), each with its own named range check, twice-safe, said in
 * the house voice — and nothing else: no function, no policy, no trigger, no row touched, 0333's
 * boundary (RLS, its three policies, its guard) proved untouched on the database. Applied migrations
 * are immutable; check-test-db.cjs hashes 0001–0401 as they are.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

const COLUMNS = [
  { col: "space_pitch_in", max: 3, check: "job_panels_space_pitch_in_range" },
  { col: "label_width_in", max: 6, check: "job_panels_label_width_in_range" },
  { col: "label_width_in_right", max: 6, check: "job_panels_label_width_in_right_range" },
] as const;

describe("migration 0402: the panel door is measured", () => {
  const sql = migration("0402_");
  const m0333 = migration("0333_");

  it("is the one 0402 and nothing sits past it", () => {
    const names = readdirSync(migrations);
    expect(names.filter((n) => n.startsWith("0402_"))).toEqual(["0402_the_panel_door_is_measured.sql"]);
    expect(names.some((n) => /^040[3-9]_|^04[1-9]\d_|^0[5-9]\d\d_/.test(n))).toBe(false);
  });

  it("exists, names itself, and runs under the house timeouts", () => {
    expect(sql).toContain("migration 0402: the panel door is measured");
    expect(sql).toContain("set local lock_timeout = '3s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toMatch(/raise notice '0402: the panel door is measured/);
    expect((sql.match(/Nothing was changed\./g) ?? []).length).toBeGreaterThanOrEqual(9);
    // The preconditions: 0333's table and its guard.
    expect(sql).toContain("if to_regclass('public.job_panels') is null then");
    expect(sql).toContain("if to_regprocedure('public.job_panel_guard()') is null then");
  });

  it("adds the three measurements twice-safe, each a nullable number with its own named range check and comment", () => {
    for (const { col, max, check } of COLUMNS) {
      expect(sql).toContain(
        `alter table public.job_panels add column if not exists ${col} numeric\n  constraint ${check} check (${col} is null or (${col} > 0 and ${col} <= ${max}));`,
      );
      expect(sql).toContain(`comment on column public.job_panels.${col} is`);
      expect(sql).not.toMatch(new RegExp(`${col} numeric[^\\n]*not null`));
    }
    expect((sql.match(/add column if not exists/g) ?? []).length).toBe(3);
    expect(sql).not.toMatch(/add column (?!if not exists)/);
    // The default is the code's (lib/panel/geometry), never written into the column.
    expect(sql).not.toMatch(/\bdefault\b\s+\d/);
    expect(sql).toContain("lib/panel/geometry");
  });

  it("the self-check proves the columns, the checks and 0333's boundary on the database", () => {
    expect(sql).toContain("foreach v_col in array array['space_pitch_in', 'label_width_in', 'label_width_in_right'] loop");
    expect(sql).toContain("and data_type = 'numeric' and is_nullable = 'YES'");
    expect(sql).toContain(
      "foreach v_con in array array['job_panels_space_pitch_in_range', 'job_panels_label_width_in_range', 'job_panels_label_width_in_right_range'] loop",
    );
    expect(sql).toContain("if not (select relrowsecurity from pg_class where oid = 'public.job_panels'::regclass) then");
    expect(sql).toContain("policyname in ('job_panels_read', 'job_panels_insert', 'job_panels_update')");
    expect(sql).toContain("tgname = 'job_panel_guard' and not tgisinternal");
    expect(sql).toContain("has_table_privilege('authenticated', 'public.job_panels', 'delete')");
    // 0333's rule, said again: nothing money- or part-shaped on a panel (and none of the three names trips it).
    expect(sql).toContain("column_name ~ '(price|cost|amount|supplier|vendor|part)'");
    for (const { col } of COLUMNS) expect(col).not.toMatch(/price|cost|amount|supplier|vendor|part/);
  });

  it("names every reader of the three columns, the day they are added", () => {
    expect(sql).toContain("/print/panel-labels/<job>");
    expect(sql).toContain("panelGeometry");
    expect(sql).toContain("savePanel");
  });

  it("changes nothing else: no function, no policy, no trigger, no other table, no row", () => {
    expect(sql).not.toMatch(/create (or replace )?function/i);
    expect(sql).not.toMatch(/drop function|drop table|drop index|drop column|drop policy|drop trigger/i);
    expect(sql).not.toMatch(/create policy|create trigger|create table|create index/i);
    expect(sql).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(sql).not.toMatch(/alter table public\.(?!job_panels\b)/i);
    expect(sql).not.toMatch(/enable row level security|disable row level security/i);
    expect(sql).not.toMatch(/\bupdate public\.\w+\s+set\b/i);
    expect(sql).not.toMatch(/\binsert into\b|\bdelete from\b/i);
    // 0333 itself is untouched (applied migrations are immutable) and still holds the policies 0402 checks for.
    expect(m0333).toContain("create policy job_panels_read on public.job_panels");
    expect(m0333).toContain("create policy job_panels_insert on public.job_panels");
    expect(m0333).toContain("create policy job_panels_update on public.job_panels");
    expect(m0333).not.toContain("space_pitch_in");
  });
});
