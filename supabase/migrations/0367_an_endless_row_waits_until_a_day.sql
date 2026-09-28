-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0367: an endless Needs You row waits until a day
--
-- Wave 1, lane 5 (Needs You). Erik, 2026-09-27, "yes to all", answer 5: a Needs You row with no day
-- of its own and no honest ending (No Costs Yet on a labor-only job, To Buy while a part is
-- back-ordered, and the like) gets a Snooze that picks a day; it then sits in the Waiting fold with
-- that day and comes back on it. "Too quiet gets things lost": there is no "No Date", every wait has
-- a day.
--
-- ═══ APPLY ORDER ═══════════════════════════════════════════════════════════════════════════
--   SAFE BEFORE OR AFTER THE CODE. The code deploys first and reads this table tolerantly: while it
--   is missing (Postgres 42P01 / PostgREST PGRST205) Needs You draws no Snooze door on any row and no
--   error anywhere, exactly the list of the day before; a Snooze sent anyway (Nort) says it needs one
--   database update and changes nothing. Needs 0158 (auth_org_id, is_org_staff) and 0004
--   (set_org_id). Independent of 0366.
--   THE TEST DATABASE: the DB suite (src/lib/needs-you-waits.integration.test.ts) applies this file
--   inside its own rolled-back transaction when the database doesn't have it yet.
--   NEVER PRACTICE IT ON PRODUCTION inside BEGIN ... ROLLBACK: the lock waits are real either way.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- ONE TRANSACTION: apply-migration.cjs (production) and scripts/test-db/rebuild.cjs wrap the file
-- in begin/commit; it holds no begin/commit of its own, so a suite can run it inside a rolled-back
-- transaction. SAFE TO RUN TWICE: create ... if not exists, create or replace, drop-then-create for
-- the trigger and the policies, idempotent grants. It writes NO company data and backfills nothing.
--
-- ── public.needs_you_waits ─────────────────────────────────────────────────────────────────
--   one row per (company, item_key). item_key is the row's stable key as Needs You builds it
--   ("materials_needed:<job id>"): its kind, a colon, the record it is about.
--   until       the company's day it comes back (a date, never null: no "No Date").
--   reason      why it waits, said on its Waiting row (optional, at most 200 characters).
--   created_by  who snoozed it: the database's (the signed-in person), never what a client sent.
--   created_at  when it was last snoozed (a second Snooze moves the day and stamps this again).
--   A wait whose day has come is ignored by every read (the row is back on Needs You); one whose row
--   is gone matches nothing and is never drawn. The app clears a company's waits whose day has passed
--   whenever it saves one (on a write, never on a read).
--
-- ── WHO ─────────────────────────────────────────────────────────────────────────────────────
--   RLS on. The office of a company (auth_org_id() + is_org_staff(): owner, admin, office, active)
--   reads and writes its own company's waits, and nobody else reads or writes any (a tech never: the
--   rows a Snooze parks are money nudges, staff only). anon has nothing. The service role bypasses RLS
--   as always (it has no reader of this table).
--
-- ── LOCKS ───────────────────────────────────────────────────────────────────────────────────
--   A new table, its index, trigger and policies: nothing existing is touched. The foreign keys take a
--   SHARE ROW EXCLUSIVE lock on organizations and profiles for an instant (no rows to check).
--   lock_timeout 5s / statement_timeout 15s: queued behind a long transaction, it gives up and
--   changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('public.auth_org_id()') is null or to_regprocedure('public.is_org_staff()') is null then
    raise exception '0367: auth_org_id / is_org_staff (0158) are not on this database. Nothing was changed.';
  end if;
  if to_regprocedure('public.set_org_id()') is null then
    raise exception '0367: set_org_id (0004) is not on this database. Nothing was changed.';
  end if;
end $$;

create table if not exists public.needs_you_waits (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  item_key    text not null,
  until       date not null,
  reason      text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint needs_you_waits_one_per_row unique (org_id, item_key),
  constraint needs_you_waits_key_shape check (item_key ~ '^[a-z_]+:.+$' and char_length(item_key) <= 200),
  constraint needs_you_waits_reason_len check (reason is null or char_length(reason) <= 200)
);

comment on table public.needs_you_waits is
  'An endless Needs You row (No Costs Yet on a labor-only job, To Buy while a part is back-ordered) waiting until a day (0367). One row per company and row key; the row waits in the Waiting fold with its day and reason and comes back on it. Staff of the company only.';
comment on column public.needs_you_waits.item_key is
  'The Needs You row''s stable key as the build makes it: its kind, a colon, the record it is about ("materials_needed:<job id>").';
comment on column public.needs_you_waits.until is
  'The company''s day the row comes back to Needs You. Never null: nothing waits without a day.';
comment on column public.needs_you_waits.created_by is
  'Who snoozed it, written by the database from the signed-in person (needs_you_waits_stamp), never from the client.';

-- Who and when are the database's: the signed-in person and now, on every insert and update (a
-- second Snooze of the same row is an update: ON CONFLICT DO UPDATE). A server write (no one signed
-- in) keeps what it sent. The company is stamped when the writer left it out (set_org_id); the
-- policies below refuse any other company's.
create or replace function public.needs_you_waits_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_at := now();
  if new.org_id is null then
    new.org_id := public.auth_org_id();
  end if;
  return new;
end $fn$;
revoke execute on function public.needs_you_waits_stamp() from public, anon;

drop trigger if exists needs_you_waits_stamp on public.needs_you_waits;
create trigger needs_you_waits_stamp before insert or update on public.needs_you_waits
  for each row execute function public.needs_you_waits_stamp();

alter table public.needs_you_waits enable row level security;
revoke all on table public.needs_you_waits from public, anon, authenticated;
grant select, insert, update, delete on table public.needs_you_waits to authenticated;

drop policy if exists needs_you_waits_read on public.needs_you_waits;
create policy needs_you_waits_read on public.needs_you_waits for select to authenticated
  using (org_id = public.auth_org_id() and public.is_org_staff());
drop policy if exists needs_you_waits_insert on public.needs_you_waits;
create policy needs_you_waits_insert on public.needs_you_waits for insert to authenticated
  with check (org_id = public.auth_org_id() and public.is_org_staff());
drop policy if exists needs_you_waits_update on public.needs_you_waits;
create policy needs_you_waits_update on public.needs_you_waits for update to authenticated
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
drop policy if exists needs_you_waits_delete on public.needs_you_waits;
create policy needs_you_waits_delete on public.needs_you_waits for delete to authenticated
  using (org_id = public.auth_org_id() and public.is_org_staff());

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_class c where c.oid = 'public.needs_you_waits'::regclass and c.relrowsecurity) then
    raise exception '0367: needs_you_waits has row level security switched off. Nothing was changed.';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'needs_you_waits') <> 4 then
    raise exception '0367: needs_you_waits must have exactly its four staff policies. Nothing was changed.';
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'needs_you_waits'
       and (coalesce(qual, '') || coalesce(with_check, '')) !~ 'is_org_staff'
  ) then
    raise exception '0367: a needs_you_waits policy lets someone other than the office in. Nothing was changed.';
  end if;
  if has_table_privilege('anon', 'public.needs_you_waits', 'select')
     or has_table_privilege('anon', 'public.needs_you_waits', 'insert') then
    raise exception '0367: anon can reach needs_you_waits. Nothing was changed.';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'needs_you_waits' and column_name = 'until' and is_nullable = 'YES'
  ) then
    raise exception '0367: needs_you_waits.until must never be empty: every wait has a day. Nothing was changed.';
  end if;
  raise notice '0367: an endless Needs You row can wait until a day.';
end $$;
