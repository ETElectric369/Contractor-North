import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * ONE FOREIGN KEY BETWEEN A BILL AND ITS LINES (0418; cn-v1181's repair).
 *
 * 0417 made bill_line_items.returned_credit_bill_id a foreign key to bills. A line already holds one
 * (bill_id), and the data API works out a join from the keys between two tables: with two it refuses
 * to guess, so every read of a bill WITH its lines failed in production from the minute 0417 was
 * applied. The same thing had been asked of the deposits release (0414) and refused by its builder;
 * the lesson was written down and the contract for 0417 asked for the key anyway. 0418 drops it and
 * keeps its two promises with triggers, which the data API does not read.
 *
 * NO DATABASE RUNS HERE. These are text pins; src/lib/pen-marks-0417.integration.test.ts asks the
 * database (its "deleting the credit memo's bill opens the line again" case now rests on the trigger).
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

describe("migration 0418: one key between a bill and its lines", () => {
  const sql = read("0418_one_key_between_bills_and_lines.sql");
  const code = codeOf(sql);

  // The newest-migration line moved to tests/migration-0419.test.ts with 0419 (house practice).
  it("is the one 0418, under the house timeouts, with no transaction of its own", () => {
    expect(names.filter((n) => n.startsWith("0418_"))).toEqual(["0418_one_key_between_bills_and_lines.sql"]);
    expect(code).toContain("set local lock_timeout = '3s';");
    expect(code).toContain("set local statement_timeout = '15s';");
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
  });

  it("drops 0417's key by name, and makes no foreign key of its own", () => {
    expect(code).toMatch(/alter table public\.bill_line_items\s+drop constraint if exists bill_line_items_returned_credit_bill_id_fkey;/);
    // (Its self-check SAYS "foreign key" in a sentence; what it must not do is MAKE one.)
    expect(code).not.toMatch(/add constraint/i);
    expect(code).not.toMatch(/foreign key\s*\([a-z_, ]+\)\s*references/i);
    expect(code).not.toMatch(/\breferences\s+public\./i);
  });

  it("keeps the key's first promise: a line can only name a credit bill that exists, refused with the key's own code", () => {
    expect(code).toMatch(/create trigger bill_line_items_credit_bill_exists\s+before insert or update of returned_credit_bill_id on public\.bill_line_items/);
    expect(code).toContain("when (new.returned_credit_bill_id is not null)");
    expect(code).toContain("select 1 from public.bills b where b.id = new.returned_credit_bill_id");
    expect(code).toContain("using errcode = '23503'");
  });

  it("keeps the second: deleting the credit memo's bill empties the link, so the line waits for its credit again", () => {
    expect(code).toMatch(/create trigger bills_reopen_returned_lines\s+before delete on public\.bills/);
    expect(code).toMatch(/update public\.bill_line_items\s+set returned_credit_bill_id = null\s+where returned_credit_bill_id = old\.id;/);
  });

  it("its two functions run as the owner with a pinned search path, and nobody may call them", () => {
    expect((code.match(/security definer/g) ?? []).length).toBe(2);
    expect((code.match(/set search_path = public/g) ?? []).length).toBe(2);
    expect(code).toContain("revoke all on function public.bill_line_items_credit_bill_exists() from public, anon, authenticated;");
    expect(code).toContain("revoke all on function public.bills_reopen_returned_lines() from public, anon, authenticated;");
  });

  it("can be run twice, checks that exactly ONE key is left, and tells the data API to read the schema again", () => {
    expect(code).toContain("drop trigger if exists bill_line_items_credit_bill_exists on public.bill_line_items;");
    expect(code).toContain("drop trigger if exists bills_reopen_returned_lines on public.bills;");
    expect((code.match(/create or replace function/g) ?? []).length).toBe(2);
    expect(code).toContain("must be joined by exactly ONE foreign key");
    expect(code).toMatch(/if n <> 1 then/);
    expect(code.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  it("THE LESSON, HELD: no later migration joins a bill and its lines, or an invoice and its lines, by a second key", () => {
    const later = names.filter((n) => n >= "0418_");
    const second = [
      /alter table\s+(public\.)?bill_line_items[^;]*\breferences\s+(public\.)?bills\b/i,
      /alter table\s+(public\.)?bills[^;]*\breferences\s+(public\.)?bill_line_items\b/i,
      /alter table\s+(public\.)?invoice_items[^;]*\breferences\s+(public\.)?invoices\b/i,
      /alter table\s+(public\.)?invoices[^;]*\breferences\s+(public\.)?invoice_items\b/i,
    ];
    const hits = later.filter((n) => second.some((re) => re.test(codeOf(read(n)))));
    expect(hits).toEqual([]);
  });
});
