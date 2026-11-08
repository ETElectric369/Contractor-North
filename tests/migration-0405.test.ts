import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A SENT BILL REMEMBERS ITS FIGURE (0405; Erik, 2026-11-07: the link a customer holds is live, so
 * the only thing that can go stale is the figure they paid against), read from the migration file
 * the way migration-0404.test.ts reads 0404: one nullable numeric(12,2) on invoices, the same type
 * as total, one BEFORE trigger that copies total into it whenever sent_at moves, twice-safe, no
 * backfill (a figure nobody recorded is never guessed), said in the house voice, its readers named
 * - and nothing else: no policy, no grant, no other table, no row. Applied migrations are immutable.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

describe("migration 0405: a sent bill remembers its figure", () => {
  const sql = migration("0405_");
  /** The statements alone, without the header's words. */
  const code = sql.replace(/--.*$/gm, "");

  it("is the one 0405 (what sits past it is the newest migration's own test: migration-0406.test.ts)", () => {
    const names = readdirSync(migrations);
    expect(names.filter((n) => n.startsWith("0405_"))).toEqual(["0405_a_sent_bill_remembers_its_figure.sql"]);
  });

  it("exists, names itself, and runs under the house timeouts", () => {
    expect(sql).toContain("migration 0405: a sent bill remembers its figure");
    expect(sql).toContain("set local lock_timeout = '3s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toMatch(/raise notice '0405: a sent bill remembers its figure/);
    expect((sql.match(/Nothing was changed\./g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(sql).toContain("if to_regclass('public.invoices') is null then");
    // It stands on 0267's delivery stamp and says so before it touches anything.
    expect(sql).toContain("and table_name = 'invoices' and column_name = 'sent_at'");
  });

  it("adds the one column twice-safe: numeric(12,2) like invoices.total (0003), nullable, no default", () => {
    expect(sql).toContain("alter table public.invoices add column if not exists sent_total numeric(12,2);");
    expect(migration("0003_")).toMatch(/total\s+numeric\(12,2\)/);
    expect((sql.match(/add column if not exists/g) ?? []).length).toBe(1);
    expect(sql).not.toMatch(/add column (?!if not exists)/);
    expect(code).not.toMatch(/\bdefault\b/i);
    expect(code).not.toMatch(/sent_total numeric\(12,2\)\s+not null/i);
    expect(sql).toContain("comment on column public.invoices.sent_total is");
  });

  it("one trigger copies the total into sent_total whenever sent_at moves, and only then", () => {
    expect(sql).toContain("create or replace function public.invoices_sent_total_follows_send()");
    expect(sql).toContain("set search_path = public");
    expect(sql).toContain("drop trigger if exists invoices_sent_total_follows_send on public.invoices;");
    expect(sql).toContain("create trigger invoices_sent_total_follows_send before insert or update of sent_at on public.invoices");
    expect(sql).toContain("for each row execute function public.invoices_sent_total_follows_send();");
    // A null send records nothing; the same instant again records nothing; a new row with a send
    // on it records (OLD has no row on an insert, so the branch is on tg_op).
    expect(code).toMatch(/if new\.sent_at is null then\s+return new;/);
    expect(sql).toContain("if tg_op = 'INSERT' or new.sent_at is distinct from old.sent_at then");
    expect(sql).toContain("new.sent_total := new.total;");
    expect(sql).not.toMatch(/security definer/i);
  });

  it("NO BACKFILL: a figure nobody recorded stays null, and the header says why", () => {
    expect(sql).toContain("NO BACKFILL");
    expect(sql).toMatch(/Null = sent before 0405, or never sent/);
    expect(code).not.toMatch(/\bupdate public\.\w+\s+set\b/i);
    expect(code).not.toMatch(/\binsert into\b|\bdelete from\b/i);
  });

  it("the self-check proves the column, the function, the trigger and invoices' RLS on the database", () => {
    expect(sql).toContain("and data_type = 'numeric' and numeric_precision = 12 and numeric_scale = 2 and is_nullable = 'YES'");
    expect(sql).toContain("if to_regprocedure('public.invoices_sent_total_follows_send()') is null then");
    expect(sql).toContain("tgname = 'invoices_sent_total_follows_send' and not tgisinternal");
    expect(sql).toContain("if not (select relrowsecurity from pg_class where oid = 'public.invoices'::regclass) then");
  });

  it("names its readers the day they are added, and quotes the one who asked", () => {
    expect(sql).toContain("customerHoldsOlderCopy");
    expect(sql).toContain("lib/invoice-revision.ts");
    expect(sql).toContain("billing/page.tsx");
    expect(sql).toContain("billing/[id]/page.tsx");
    expect(sql).toContain("lib/export/registry.ts");
    expect(sql).toContain("Erik, 2026-11-07");
  });

  it("changes nothing else: no policy, no grant, no other table, no index, no row", () => {
    expect(sql).not.toMatch(/drop function|drop table|drop index|drop column|drop policy/i);
    expect(sql).not.toMatch(/create policy|create table|create index/i);
    expect(sql).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(sql).not.toMatch(/alter table public\.(?!invoices\b)/i);
    expect(sql).not.toMatch(/enable row level security|disable row level security/i);
  });
});
