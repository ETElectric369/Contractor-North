-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0407: the words that went out
--
-- cn-v1155, review before anything goes out. Every email and text the app sends for a bill, a
-- quote, a contract, a portal link or a receipt now opens for the owner to read first, and what he
-- lets go is kept, word for word, so the document can show later exactly what the customer was
-- told. Until now the app kept only THAT a bill was sent (invoices.sent_at, and sent_total since
-- 0405), never what the message said.
--
-- WHAT THIS ADDS: one table, public.sent_messages, one row per message that left. It records the
-- document it was about (doc_kind + doc_id, no foreign key because five kinds of document live in
-- five tables), the customer, the channel, the address it went to, the subject and body as sent,
-- the address that got a copy (email only), who pressed send (null when the app sent it on its own,
-- with auto = true), and when.
--
-- A RECORD, NOT A DRAFT: there is no update policy and no delete policy, so a row, once written,
-- stays as written. Staff of the company read it and only staff add to it (every send door
-- is a staff door, so a tech cannot forge a "sent to X" row through the API). org_id is stamped from the caller's auth
-- context when not supplied, the way every tenant table does it (set_org_id, 0004).
--
-- THE READERS, named the day they are added: the Sent Messages list on each document
-- (components/sent-messages-list, through lib/sent-messages readSentMessages) and the company's
-- records zip (lib/export/registry). The writer is lib/sent-messages logSend, best-effort: a failed
-- log never fails a send, the same rule the sent_at stamp follows.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ── The ground it stands on ─────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.organizations') is null then
    raise exception '0407: public.organizations is not on this database. Nothing was changed.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception '0407: public.profiles is not on this database. Nothing was changed.';
  end if;
  if to_regprocedure('public.set_org_id()') is null then
    raise exception '0407: public.set_org_id() is missing (0004). Nothing was changed.';
  end if;
  if to_regprocedure('public.auth_org_id()') is null then
    raise exception '0407: public.auth_org_id() is missing (0004). Nothing was changed.';
  end if;
  if to_regprocedure('public.is_org_staff()') is null then
    raise exception '0407: public.is_org_staff() is missing (0158). Nothing was changed.';
  end if;
end $$;

create table if not exists public.sent_messages (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  doc_kind    text not null check (doc_kind in ('invoice', 'quote', 'contract', 'portal', 'receipt')),
  doc_id      uuid,
  customer_id uuid,
  channel     text not null check (channel in ('email', 'sms')),
  to_addr     text not null,
  subject     text,
  body        text not null,
  copy_to     text,
  sent_by     uuid references public.profiles(id) on delete set null,
  sent_at     timestamptz not null default now(),
  auto        boolean not null default false
);

create index if not exists sent_messages_doc_idx
  on public.sent_messages(org_id, doc_kind, doc_id, sent_at desc);

drop trigger if exists set_org_id_sent_messages on public.sent_messages;
create trigger set_org_id_sent_messages before insert on public.sent_messages
  for each row execute function public.set_org_id();

alter table public.sent_messages enable row level security;

-- Read: staff of the company see what went out.
drop policy if exists sent_messages_read on public.sent_messages;
create policy sent_messages_read on public.sent_messages
  for select using (org_id = public.auth_org_id() and public.is_org_staff());

-- Insert: only staff of the company append a row for their own company (the send doors are staff
-- doors). No update or delete policy: the words that went out are a record.
drop policy if exists sent_messages_insert on public.sent_messages;
create policy sent_messages_insert on public.sent_messages
  for insert with check (org_id = public.auth_org_id() and public.is_org_staff());

comment on table public.sent_messages is
  'The words that went out (0407): one row per email or text sent for a bill, quote, contract, portal link or receipt, as the customer got it. Append-only (no update or delete policy). Written by lib/sent-messages logSend, read by readSentMessages and the records zip. doc_kind + doc_id name the document (no foreign key: five kinds, five tables); auto is true when the app sent it on its own.';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.sent_messages'::regclass) then
    raise exception '0407: row level security is off on sent_messages. Nothing was changed.';
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'sent_messages' and cmd in ('UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception '0407: sent_messages has an update, delete or all-commands policy; the words that went out are a record. Nothing was changed.';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'sent_messages' and cmd = 'SELECT') <> 1 then
    raise exception '0407: sent_messages does not have its one select policy. Nothing was changed.';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'sent_messages' and cmd = 'INSERT') <> 1 then
    raise exception '0407: sent_messages does not have its one insert policy. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.sent_messages'::regclass and tgname = 'set_org_id_sent_messages' and not tgisinternal
  ) then
    raise exception '0407: the set_org_id trigger is not on sent_messages. Nothing was changed.';
  end if;
  raise notice '0407: the words that went out — sent_messages keeps every message as sent, staff read it and add to it, nobody edits or deletes it.';
end $$;
