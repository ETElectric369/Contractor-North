import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * PEN MARKS ON A SUPPLIER'S PAPER, KEPT ON THE BILL'S LINES (0417; cn-v1181). What this file proves
 * is the TEXT: the three columns, the foreign key, the three checks and the index, each added only
 * when it is not there (twice-safe), no data changed, nothing else made, the house timeouts, and a
 * self-check that refuses what it says it refuses.
 * NO DATABASE RUNS HERE: src/lib/pen-marks-0417.integration.test.ts asks the database.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const names = readdirSync(migrations).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
const migration = (prefix: string) => {
  const f = names.find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("migration 0417: pen marks on a supplier's paper, kept on the bill's lines", () => {
  const sql = migration("0417_");
  const code = noComments(sql);
  const flat = squash(code);

  // The newest-migration line moved to tests/migration-0418.test.ts with 0418 (house practice).
  it("is the one 0417, under the house timeouts, with no transaction of its own", () => {
    expect(names.filter((n) => n.startsWith("0417_"))).toEqual(["0417_pen_marks.sql"]);
    expect(code).toContain("set local lock_timeout = '3s';");
    expect(code).toContain("set local statement_timeout = '15s';");
    expect(code).not.toMatch(/^\s*(begin|commit|rollback|start transaction)\s*;/im);
  });

  it("quotes the owner and names its writers and readers the day the columns are added", () => {
    expect(sql).toContain("i am scanning redacted bills");
    expect(sql).toContain("un-used items have been returned");
    expect(sql).toContain("paperwork-core.ts insertItemizedBill");
    expect(sql).toContain("readBillStanding");
    expect(sql).toContain("tests/migration-0417.test.ts");
    expect(sql).toContain("src/lib/pen-marks-0417.integration.test.ts");
  });

  it("adds the three columns only when they are not there: pen_mark text null, returned not null default false, returned_credit_bill_id uuid null", () => {
    expect(flat).toContain(
      "alter table public.bill_line_items add column if not exists pen_mark text, add column if not exists returned boolean not null default false, add column if not exists returned_credit_bill_id uuid;",
    );
  });

  it("references bills on delete set null, by name, only when it is not there", () => {
    expect(flat).toContain(
      "if not exists ( select 1 from pg_constraint where conrelid = 'public.bill_line_items'::regclass and conname = 'bill_line_items_returned_credit_bill_id_fkey' ) then alter table public.bill_line_items add constraint bill_line_items_returned_credit_bill_id_fkey foreign key (returned_credit_bill_id) references public.bills(id) on delete set null; end if;",
    );
  });

  it("adds the two checks the contract names and the word check, each by name, each only when it is not there", () => {
    for (const [name, rule] of [
      ["bill_line_items_returned_not_billed", "check (not returned or billable = false);"],
      ["bill_line_items_credit_needs_return", "check (returned_credit_bill_id is null or returned);"],
      ["bill_line_items_pen_mark_word", "check (pen_mark is null or pen_mark in ('struck', 'quantity', 'unclear'));"],
    ]) {
      expect(flat).toContain(
        `if not exists ( select 1 from pg_constraint where conrelid = 'public.bill_line_items'::regclass and conname = '${name}' ) then alter table public.bill_line_items add constraint ${name} ${rule} end if;`,
      );
    }
  });

  it("indexes returned_credit_bill_id where it is not null, only when the index is not there", () => {
    expect(flat).toContain(
      "create index if not exists bill_line_items_returned_credit_idx on public.bill_line_items (returned_credit_bill_id) where returned_credit_bill_id is not null;",
    );
  });

  it("changes no data and makes nothing else: no update, insert, delete, drop, policy, trigger or function", () => {
    expect(code).not.toMatch(/\b(update|insert into|delete from|truncate)\b\s+public\./i);
    expect(code).not.toMatch(/\bdrop\s+(table|column|constraint|index|trigger|function|policy)\b/i);
    expect(code).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(function|trigger|policy|view)\b/i);
    expect(code).not.toMatch(/\b(alter|disable)\s+row level security\b/i);
    expect((code.match(/\balter table\b/gi) ?? []).length).toBe(5);
  });

  it("the ground check and the self-check refuse what they say, and the self-check reads every made thing back", () => {
    const self = code.slice(code.lastIndexOf("do $$"));
    for (const needle of [
      "column_default = 'false'",
      "'bill_line_items_returned_credit_bill_id_fkey'",
      "position('ON DELETE SET NULL' in v_def) = 0",
      "'bill_line_items_returned_not_billed'",
      "position('billable = false' in v_def) = 0",
      "'bill_line_items_credit_needs_return'",
      "'bill_line_items_pen_mark_word'",
      "to_regclass('public.bill_line_items_returned_credit_idx') is null",
      "relrowsecurity",
      "policyname = 'bill_line_items_rw'",
      "where returned and billable",
      "where returned_credit_bill_id is not null and not returned",
    ])
      expect(self).toContain(needle);
    expect((self.match(/raise exception '0417:/g) ?? []).length).toBe(9);
    const ground = code.slice(code.indexOf("do $$"), code.indexOf("alter table public.bill_line_items"));
    expect(ground).toContain("to_regclass('public.bill_line_items') is null");
    expect(ground).toContain("column_name = 'billable' and data_type = 'boolean' and is_nullable = 'NO'");
    expect(ground).toContain("of another type");
  });
});
