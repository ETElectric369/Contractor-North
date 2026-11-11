import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE WORDS THAT WENT OUT (0407; cn-v1155 — Erik, 2026-11-07: "the ability to modify the message and
 * details of anything i send out via email or text … that i will then be getting a copy of … but
 * have all the options there for approval before sending"), read from the migration file the way
 * migration-0406.test.ts reads 0406: ONE new table, sent_messages, one row per email or text that
 * left for a bill, quote, contract, portal link or receipt, as the customer got it; org_id stamped
 * by 0004's set_org_id; row level security on with a select policy and an insert policy for the
 * company's staff and NO update, delete or all-commands policy (a record, never a draft); one index
 * for the list each document shows; twice-safe; said in the house voice; its readers named — and
 * nothing else: no other table touched, no grant, no row. The DB suite (lib/sent-messages
 * .integration.test.ts) proves the policies on the database; this test pins the file. Applied
 * migrations are immutable: 0407 is pinned the day it is applied.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

describe("migration 0407: the words that went out", () => {
  const sql = migration("0407_");
  /** The statements alone, without the header's words. */
  const code = sql.replace(/--.*$/gm, "");

  it("is the one 0407 (what sits past it is the newest migration's own test: migration-0408.test.ts)", () => {
    const names = readdirSync(migrations);
    expect(names.filter((n) => n.startsWith("0407_"))).toEqual(["0407_the_words_that_went_out.sql"]);
  });

  it("exists, names itself, runs under the house timeouts, and checks its ground before touching anything", () => {
    expect(sql).toContain("migration 0407: the words that went out");
    expect(sql).toContain("set local lock_timeout = '3s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toMatch(/raise notice '0407: the words that went out/);
    expect((sql.match(/Nothing was changed\./g) ?? []).length).toBeGreaterThanOrEqual(10);
    expect(sql).toContain("if to_regclass('public.organizations') is null then");
    expect(sql).toContain("if to_regclass('public.profiles') is null then");
    expect(sql).toContain("if to_regprocedure('public.set_org_id()') is null then");
    expect(sql).toContain("if to_regprocedure('public.auth_org_id()') is null then");
    expect(sql).toContain("if to_regprocedure('public.is_org_staff()') is null then");
    // The three it leans on were born where it says.
    expect(migration("0004_")).toMatch(/function (public\.)?set_org_id\(\)/);
    expect(migration("0004_")).toMatch(/function (public\.)?auth_org_id\(\)/);
    expect(migration("0158_")).toMatch(/function (public\.)?is_org_staff\(\)/);
  });

  it("one table, twice-safe, tied to the company and the sender, its two word lists checked", () => {
    expect(sql).toContain("create table if not exists public.sent_messages (");
    expect((code.match(/create table/gi) ?? []).length).toBe(1);
    expect(sql).toContain("org_id      uuid not null references public.organizations(id) on delete cascade,");
    expect(sql).toContain("doc_kind    text not null check (doc_kind in ('invoice', 'quote', 'contract', 'portal', 'receipt')),");
    expect(sql).toContain("channel     text not null check (channel in ('email', 'sms')),");
    expect(sql).toContain("to_addr     text not null,");
    expect(sql).toContain("body        text not null,");
    expect(sql).toContain("sent_by     uuid references public.profiles(id) on delete set null,");
    expect(sql).toContain("sent_at     timestamptz not null default now(),");
    expect(sql).toContain("auto        boolean not null default false");
    // No foreign key on doc_id: five kinds of document, five tables — said in the header.
    expect(sql).toContain("doc_id      uuid,");
    expect(sql).toContain("no foreign key because five kinds of document live in");
  });

  it("one index for each document's list, newest first", () => {
    expect(sql).toContain(
      "create index if not exists sent_messages_doc_idx\n  on public.sent_messages(org_id, doc_kind, doc_id, sent_at desc);",
    );
    expect((code.match(/create index/gi) ?? []).length).toBe(1);
  });

  it("org_id is stamped by 0004's trigger function, twice-safe", () => {
    expect(sql).toContain("drop trigger if exists set_org_id_sent_messages on public.sent_messages;");
    expect(sql).toContain(
      "create trigger set_org_id_sent_messages before insert on public.sent_messages\n  for each row execute function public.set_org_id();",
    );
    expect((code.match(/create trigger/gi) ?? []).length).toBe(1);
    expect(code).not.toMatch(/create (or replace )?function/i);
    expect(sql).not.toMatch(/security definer/i);
  });

  it("row level security on; staff of the company read and append; nobody edits or deletes", () => {
    expect(sql).toContain("alter table public.sent_messages enable row level security;");
    expect(sql).toContain("drop policy if exists sent_messages_read on public.sent_messages;");
    expect(sql).toContain(
      "create policy sent_messages_read on public.sent_messages\n  for select using (org_id = public.auth_org_id() and public.is_org_staff());",
    );
    expect(sql).toContain("drop policy if exists sent_messages_insert on public.sent_messages;");
    expect(sql).toContain(
      "create policy sent_messages_insert on public.sent_messages\n  for insert with check (org_id = public.auth_org_id() and public.is_org_staff());",
    );
    expect((code.match(/create policy/gi) ?? []).length).toBe(2);
    expect(code).not.toMatch(/for update|for delete|for all/i);
    expect(code).not.toMatch(/\bgrant\b|\brevoke\b/i);
  });

  it("no backfill, no row: a record starts empty", () => {
    expect(code).not.toMatch(/\bupdate public\.\w+\s+set\b/i);
    expect(code).not.toMatch(/\binsert into\b|\bdelete from\b/i);
  });

  it("the self-check proves RLS on, the one select and the one insert policy, no edit policy, and the trigger", () => {
    expect(sql).toContain("if not (select relrowsecurity from pg_class where oid = 'public.sent_messages'::regclass) then");
    expect(sql).toContain("tablename = 'sent_messages' and cmd in ('UPDATE', 'DELETE', 'ALL')");
    expect(sql).toContain("tablename = 'sent_messages' and cmd = 'SELECT') <> 1 then");
    expect(sql).toContain("tablename = 'sent_messages' and cmd = 'INSERT') <> 1 then");
    expect(sql).toContain("tgname = 'set_org_id_sent_messages' and not tgisinternal");
  });

  it("names its readers and its writer the day they are added", () => {
    for (const reader of ["components/sent-messages-list", "lib/sent-messages", "readSentMessages", "logSend", "lib/export/registry"]) {
      expect(sql).toContain(reader);
    }
    expect(sql).toContain("comment on table public.sent_messages is");
  });

  it("changes nothing else: no other table, no drop, no column elsewhere", () => {
    expect(code).not.toMatch(/drop function|drop table|drop index|drop column/i);
    expect(code).not.toMatch(/add column|add constraint/i);
    expect(code).not.toMatch(/alter table public\.(?!sent_messages\b)/i);
    expect(code).not.toMatch(/comment on (table|column) public\.(?!sent_messages\b)/i);
  });
});
