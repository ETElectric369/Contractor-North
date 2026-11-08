import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * ONE LIST OF THE WAYS MONEY MOVES (0406; Erik, 2026-11-07: "there are some payment entry windows
 * that show venmo as an option then others that dont … i had to add venmo in the notes"), read from
 * the migration file the way migration-0404.test.ts reads 0404: the two word-list CHECKs (0264's on
 * pay_payments, 0270's on supplier_payments) come off, ONE generic trigger function runs 0287's
 * payment_method_key() on both columns before insert or update of method, 0287's own trigger on
 * payments is left alone, no row is touched (every stored word is already a key), twice-safe, said
 * in the house voice, its readers named — and nothing else: no policy, no grant, no column, no other
 * table. Applied migrations are immutable.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

describe("migration 0406: one list of the ways money moves", () => {
  const sql = migration("0406_");
  /** The statements alone, without the header's words. */
  const code = sql.replace(/--.*$/gm, "");

  it("is the one 0406 and nothing sits past it", () => {
    const names = readdirSync(migrations);
    expect(names.filter((n) => n.startsWith("0406_"))).toEqual(["0406_one_list_of_ways_money_moves.sql"]);
    expect(names.some((n) => /^040[7-9]_|^04[1-9]\d_|^0[5-9]\d\d_/.test(n))).toBe(false);
  });

  it("exists, names itself, and runs under the house timeouts", () => {
    expect(sql).toContain("migration 0406: one list of the ways money moves");
    expect(sql).toContain("set local lock_timeout = '3s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toMatch(/raise notice '0406: one list of the ways money moves/);
    expect((sql.match(/Nothing was changed\./g) ?? []).length).toBeGreaterThanOrEqual(7);
    expect(sql).toContain("if to_regclass('public.pay_payments') is null then");
    expect(sql).toContain("if to_regclass('public.supplier_payments') is null then");
    // It stands on 0287's normalizer and says so before touching anything.
    expect(sql).toContain("if to_regprocedure('public.payment_method_key(text)') is null then");
  });

  it("takes the two word lists off, by the names Postgres gave 0264's and 0270's inline checks, twice-safe", () => {
    expect(sql).toContain("alter table public.pay_payments drop constraint if exists pay_payments_method_check;");
    expect(sql).toContain("alter table public.supplier_payments drop constraint if exists supplier_payments_method_check;");
    expect((code.match(/drop constraint/gi) ?? []).length).toBe(2);
    expect(code).not.toMatch(/drop constraint (?!if exists)/i);
    // Neither 0264 nor 0270 named its check, so the auto-names are the ones to drop.
    const born = migration("0264_") + migration("0270_");
    expect(born).not.toMatch(/constraint\s+\w*method\w*\s+check/i);
    expect(born).toContain("method      text not null default 'cash' check (method in ('cash','check','transfer','other'))");
    expect(born).toContain("method text not null default 'check' check (method in ('cash','check','transfer','card','other'))");
  });

  it("one generic trigger function runs 0287's normalizer, on both tables, before insert or update of method", () => {
    expect(sql).toContain("create or replace function public.money_method_to_key()");
    expect(sql).toContain("returns trigger");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("new.method := public.payment_method_key(new.method);");
    expect(sql).toContain("drop trigger if exists pay_payments_method_to_key on public.pay_payments;");
    expect(sql).toContain(
      "create trigger pay_payments_method_to_key\n  before insert or update of method on public.pay_payments\n  for each row execute function public.money_method_to_key();",
    );
    expect(sql).toContain("drop trigger if exists supplier_payments_method_to_key on public.supplier_payments;");
    expect(sql).toContain(
      "create trigger supplier_payments_method_to_key\n  before insert or update of method on public.supplier_payments\n  for each row execute function public.money_method_to_key();",
    );
    expect((code.match(/create trigger/gi) ?? []).length).toBe(2);
    expect((code.match(/drop trigger if exists/gi) ?? []).length).toBe(2);
    expect(sql).not.toMatch(/security definer/i);
    // 0287's own trigger and normalizer are untouched: not redefined, not dropped.
    expect(code).not.toContain("payments_method_to_key on public.payments");
    expect(code).not.toContain("function public.payment_method_key(");
    expect(code).not.toContain("function public.payments_method_to_key(");
  });

  it("the normalizer it runs is the one the app's paymentMethodKey mirrors (0287), word for word", () => {
    const m0287 = migration("0287_");
    expect(m0287).toContain("create or replace function public.payment_method_key(m text)");
    expect(m0287).toContain("new.method := public.payment_method_key(new.method);");
    // The self-check holds the database's answers to the app's (payment-method.test.ts pins the same cases).
    expect(sql).toContain("public.payment_method_key('Venmo') <> 'venmo'");
    expect(sql).toContain("public.payment_method_key('Cheque') <> 'check'");
    expect(sql).toContain("public.payment_method_key(' Apple  Cash ') <> 'apple cash'");
    expect(sql).toContain("public.payment_method_key('') <> 'other'");
  });

  it("no backfill: every stored word is already a key, and the file says so", () => {
    expect(sql).toContain("NO BACKFILL");
    expect(code).not.toMatch(/\bupdate public\.\w+\s+set\b/i);
    expect(code).not.toMatch(/\binsert into\b|\bdelete from\b/i);
  });

  it("the self-check proves both checks gone, both triggers on, and RLS still on each table", () => {
    expect(sql).toContain("foreach v_tbl in array array['pay_payments', 'supplier_payments'] loop");
    expect(sql).toContain("conname = v_tbl || '_method_check' and contype = 'c'");
    expect(sql).toContain("tgname = v_tbl || '_method_to_key' and not tgisinternal");
    expect(sql).toContain("if not (select relrowsecurity from pg_class where oid = format('public.%I', v_tbl)::regclass) then");
  });

  it("names its readers the day they are added", () => {
    for (const reader of [
      "payroll/pay-sheet",
      "payroll/actions",
      "payroll/person-statement",
      "bills/suppliers-card",
      "bills/supplier-actions",
      "settings/payment-methods",
      "paymentMethodLabel",
      "paymentMethodKey",
    ]) {
      expect(sql).toContain(reader);
    }
  });

  it("changes nothing else: no policy, no grant, no column, no other table, no row", () => {
    expect(code).not.toMatch(/drop function|drop table|drop index|drop column|drop policy/i);
    expect(code).not.toMatch(/create policy|create table|create index|add column|add constraint/i);
    expect(code).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(code).not.toMatch(/alter table public\.(?!pay_payments\b|supplier_payments\b)/i);
    expect(code).not.toMatch(/enable row level security|disable row level security/i);
    expect(code).toContain("comment on column public.pay_payments.method is");
    expect(code).toContain("comment on column public.supplier_payments.method is");
  });
});
