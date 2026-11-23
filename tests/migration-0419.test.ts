import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A CUSTOMER'S OWN PAGE STARTS OFF, AND TWO NOTICES CAN BE PUT AWAY (0419; cn-v1186).
 *
 * The owner, 2026-11-22: "lets set the customer portal to default as OFF and then we can turn it on
 * when needed for who needs it only". 0419 makes customer_portal_access.enabled default to false and
 * sweeps the links nobody ever used off ONCE; it adds invoices.resend_dismissed_at and
 * bills.duplicate_dismissed_at, two plain stamps.
 *
 * THE TWICE-SAFE GUARD IS THE WHOLE POINT OF THE SHAPE: the sweep runs only while the column's default
 * is still not false, which is only the first time. Outside the guard, a second run would switch off a
 * link the office turned on yesterday for a customer who has not opened it yet.
 *
 * NO DATABASE RUNS HERE. These are text pins; src/lib/portal-starts-off-0419.integration.test.ts asks
 * the database (the default, the sweep, a second run, the two columns).
 */
const migrations = join(process.cwd(), "supabase", "migrations");
const names = readdirSync(migrations).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
const read = (name: string) => readFileSync(join(migrations, name), "utf8");
/** The statements, with the comment lines taken out. */
const codeOf = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
const squash = (s: string) => s.replace(/\s+/g, " ");

describe("migration 0419: the portal starts off, and two put-aways", () => {
  const FILE = "0419_the_portal_starts_off_and_two_put_aways.sql";
  const sql = read(FILE);
  const code = codeOf(sql);
  const flat = squash(code);

  it("is the newest migration, the one 0419, with no transaction of its own", () => {
    expect(names.filter((n) => n.startsWith("0419_"))).toEqual([FILE]);
    expect(names[names.length - 1]).toBe(FILE);
    expect(code).not.toMatch(/^\s*(begin|commit|rollback|start transaction)\s*;/im);
  });

  it("the sweep and the new default sit INSIDE the guard that only the first run passes", () => {
    const guard = flat.indexOf("if v_default is distinct from 'false' then");
    expect(guard).toBeGreaterThan(-1);
    const end = flat.indexOf("end if;", guard);
    expect(end).toBeGreaterThan(guard);
    const inside = flat.slice(guard, end);
    expect(inside).toContain("update public.customer_portal_access a set enabled = false, disabled_at = now(), disabled_by = null");
    expect(inside).toContain("alter table public.customer_portal_access alter column enabled set default false;");
    // Nowhere else: no sweep and no default outside the guard.
    expect(flat.split("update public.customer_portal_access").length - 1).toBe(1);
    expect(flat.split("set default false").length - 1).toBe(1);
    // The guard reads the column's default itself, not a ledger.
    expect(flat).toMatch(
      /select column_default into v_default from information_schema\.columns where table_schema = 'public' and table_name = 'customer_portal_access' and column_name = 'enabled';/,
    );
  });

  it("the sweep's three 'used' predicates: opened, a customer's own device, a code asked for", () => {
    const guard = flat.indexOf("if v_default is distinct from 'false' then");
    const inside = flat.slice(guard, flat.indexOf("end if;", guard));
    expect(inside).toContain("where a.enabled and a.last_opened_at is null");
    expect(inside).toContain(
      "and not exists ( select 1 from public.customer_portal_sessions s where s.customer_id = a.customer_id and s.kind = 'customer')",
    );
    expect(inside).toContain("and not exists ( select 1 from public.customer_portal_codes k where k.customer_id = a.customer_id);");
  });

  it("the two stamps are plain nullable timestamptz columns, added twice-safe", () => {
    expect(flat).toContain("alter table public.invoices add column if not exists resend_dismissed_at timestamptz null;");
    expect(flat).toContain("alter table public.bills add column if not exists duplicate_dismissed_at timestamptz null;");
  });

  it("makes no foreign key, no trigger and no policy", () => {
    expect(code).not.toMatch(/\breferences\b/i);
    expect(code).not.toMatch(/foreign key/i);
    expect(code).not.toMatch(/create (or replace )?trigger/i);
    expect(code).not.toMatch(/create policy/i);
  });

  it("checks itself, then tells the data API to read the schema again, last", () => {
    expect(flat).toContain("raise exception '0419: customer_portal_access.enabled should default to false';");
    expect(flat).toContain("raise exception '0419: invoices.resend_dismissed_at is missing';");
    expect(flat).toContain("raise exception '0419: bills.duplicate_dismissed_at is missing';");
    expect(sql.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});
