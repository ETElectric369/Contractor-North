-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — initial schema
-- Field service platform for electrical contractors.
--
-- Run this in the Supabase SQL editor (or via `supabase db push`).
-- It is idempotent-ish: safe enums/tables use IF NOT EXISTS where possible.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  create type user_role as enum ('owner', 'admin', 'office', 'tech');
exception when duplicate_object then null; end $$;

do $$ begin
  create type customer_type as enum ('residential', 'commercial', 'industrial');
exception when duplicate_object then null; end $$;

do $$ begin
  create type customer_status as enum ('lead', 'active', 'inactive');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_status as enum ('estimate', 'scheduled', 'in_progress', 'on_hold', 'complete', 'invoiced', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type quote_status as enum ('draft', 'sent', 'accepted', 'declined', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type work_order_status as enum ('draft', 'assigned', 'in_progress', 'complete', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type change_order_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type time_entry_status as enum ('open', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type time_entry_source as enum ('app', 'auto_gps', 'text', 'manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type document_kind as enum ('plan', 'photo', 'lidar', 'sketch', 'import', 'other');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPERS
-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at auto-touch
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- NOTE: the role/staff/member helper functions are defined AFTER the profiles
-- table below — SQL functions are validated against referenced tables at
-- creation time, so profiles must exist first.

-- ─────────────────────────────────────────────────────────────────────────────
-- PROFILES  (1:1 with auth.users)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text,
  email        text,
  phone        text,
  role         user_role not null default 'tech',
  hourly_rate  numeric(10,2),
  avatar_url   text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Role/membership helpers (defined here, after profiles exists). SECURITY
-- DEFINER so RLS policies can call them without recursing into profiles' policy.
create or replace function public.current_role()
returns user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role in ('owner','admin','office') from public.profiles where id = auth.uid()),
    false);
$$;

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select active from public.profiles where id = auth.uid()),
    false);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CUSTOMERS / CRM
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.customers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  company_name  text,
  type          customer_type not null default 'residential',
  status        customer_status not null default 'lead',
  email         text,
  phone         text,
  address       text,
  city          text,
  state         text,
  zip           text,
  notes         text,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- JOBS  (a project at a site for a customer)
-- ─────────────────────────────────────────────────────────────────────────────
create sequence if not exists job_number_seq;
create table if not exists public.jobs (
  id              uuid primary key default gen_random_uuid(),
  job_number      text not null unique default ('J-' || lpad(nextval('job_number_seq')::text, 5, '0')),
  customer_id     uuid references public.customers(id) on delete set null,
  name            text not null,
  description     text,
  status          job_status not null default 'estimate',
  address         text,
  city            text,
  state           text,
  zip             text,
  scheduled_start timestamptz,
  scheduled_end   timestamptz,
  assigned_to     uuid[] not null default '{}',
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists jobs_customer_idx on public.jobs(customer_id);
create index if not exists jobs_status_idx on public.jobs(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- JOB CODES  (cost / labor codes used by the timeclock)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.job_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  description text not null,
  billable    boolean not null default true,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- QUOTES + line items
-- ─────────────────────────────────────────────────────────────────────────────
create sequence if not exists quote_number_seq;
create table if not exists public.quotes (
  id            uuid primary key default gen_random_uuid(),
  quote_number  text not null unique default ('Q-' || lpad(nextval('quote_number_seq')::text, 5, '0')),
  customer_id   uuid references public.customers(id) on delete set null,
  job_id        uuid references public.jobs(id) on delete set null,
  status        quote_status not null default 'draft',
  title         text,
  notes         text,
  tax_rate      numeric(6,4) not null default 0,      -- e.g. 0.0825 for 8.25%
  subtotal      numeric(12,2) not null default 0,
  tax           numeric(12,2) not null default 0,
  total         numeric(12,2) not null default 0,
  valid_until   date,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists quotes_customer_idx on public.quotes(customer_id);

create table if not exists public.quote_line_items (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  description text not null,
  quantity    numeric(12,2) not null default 1,
  unit        text default 'ea',
  unit_price  numeric(12,2) not null default 0,
  line_total  numeric(12,2) generated always as (round(quantity * unit_price, 2)) stored,
  sort_order  int not null default 0
);
create index if not exists quote_items_quote_idx on public.quote_line_items(quote_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- WORK ORDERS
-- ─────────────────────────────────────────────────────────────────────────────
create sequence if not exists work_order_number_seq;
create table if not exists public.work_orders (
  id            uuid primary key default gen_random_uuid(),
  wo_number     text not null unique default ('WO-' || lpad(nextval('work_order_number_seq')::text, 5, '0')),
  job_id        uuid references public.jobs(id) on delete set null,
  customer_id   uuid references public.customers(id) on delete set null,
  title         text not null,
  description   text,
  status        work_order_status not null default 'draft',
  sketch_url    text,
  scheduled_for timestamptz,
  assigned_to   uuid references public.profiles(id),
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists work_orders_job_idx on public.work_orders(job_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- MATERIAL LISTS  (generated material take-offs, attachable to job or WO)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.material_lists (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  job_id        uuid references public.jobs(id) on delete cascade,
  work_order_id uuid references public.work_orders(id) on delete cascade,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now()
);

create table if not exists public.material_list_items (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references public.material_lists(id) on delete cascade,
  description text not null,
  part_number text,
  quantity    numeric(12,2) not null default 1,
  unit        text default 'ea',
  vendor      text,
  est_cost    numeric(12,2),
  sort_order  int not null default 0
);
create index if not exists material_items_list_idx on public.material_list_items(list_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- TIME ENTRIES  (the timeclock flow)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.time_entries (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  job_id          uuid references public.jobs(id) on delete set null,
  job_code        text,                          -- references job_codes.code (soft)
  clock_in        timestamptz not null default now(),
  clock_out       timestamptz,
  lunch_minutes   int not null default 0,
  gps_in          jsonb,                          -- { lat, lng, accuracy }
  gps_out         jsonb,
  notes           text,                           -- "what did you do today?"
  translated_notes text,                          -- talk + translate + transcribe
  status          time_entry_status not null default 'open',
  source          time_entry_source not null default 'app',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists time_entries_profile_idx on public.time_entries(profile_id);
create index if not exists time_entries_status_idx on public.time_entries(status);
-- A user can only have one open entry at a time.
create unique index if not exists one_open_entry_per_user
  on public.time_entries(profile_id) where (status = 'open');

-- ─────────────────────────────────────────────────────────────────────────────
-- CHANGE ORDERS
-- ─────────────────────────────────────────────────────────────────────────────
create sequence if not exists change_order_number_seq;
create table if not exists public.change_orders (
  id            uuid primary key default gen_random_uuid(),
  co_number     text not null unique default ('CO-' || lpad(nextval('change_order_number_seq')::text, 5, '0')),
  job_id        uuid references public.jobs(id) on delete cascade,
  work_order_id uuid references public.work_orders(id) on delete set null,
  description   text not null,
  amount        numeric(12,2) not null default 0,
  status        change_order_status not null default 'pending',
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- FORMS  (dynamic forms + submissions)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.forms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  schema      jsonb not null default '[]'::jsonb,  -- array of field defs
  active      boolean not null default true,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

create table if not exists public.form_submissions (
  id            uuid primary key default gen_random_uuid(),
  form_id       uuid not null references public.forms(id) on delete cascade,
  job_id        uuid references public.jobs(id) on delete set null,
  data          jsonb not null default '{}'::jsonb,
  submitted_by  uuid references public.profiles(id),
  created_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- DOCUMENTS  (plans, photos, lidar scans, imported docs)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.documents (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        document_kind not null default 'other',
  file_url    text,
  job_id      uuid references public.jobs(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  uploaded_by uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- AI ASSISTANT  (conversations + messages)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  title       text not null default 'New conversation',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system')),
  content         text not null,
  created_at      timestamptz not null default now()
);
create index if not exists messages_conversation_idx on public.messages(conversation_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at triggers
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','customers','jobs','quotes','work_orders',
    'change_orders','time_entries','conversations'
  ] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s;', t);
    execute format(
      'create trigger touch_%1$s before update on public.%1$s
       for each row execute function public.touch_updated_at();', t);
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- Model: every authenticated, active staff member belongs to the one company.
--   • Business records: any active member can read; staff (office+) can write.
--   • Time entries: a tech sees/edits only their own; staff see/manage all.
--   • Profiles: members can read the staff directory; you edit your own;
--     owner/admin can edit anyone.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.profiles            enable row level security;
alter table public.customers           enable row level security;
alter table public.jobs                enable row level security;
alter table public.job_codes           enable row level security;
alter table public.quotes              enable row level security;
alter table public.quote_line_items    enable row level security;
alter table public.work_orders         enable row level security;
alter table public.material_lists      enable row level security;
alter table public.material_list_items enable row level security;
alter table public.time_entries        enable row level security;
alter table public.change_orders       enable row level security;
alter table public.forms               enable row level security;
alter table public.form_submissions    enable row level security;
alter table public.documents           enable row level security;
alter table public.conversations       enable row level security;
alter table public.messages            enable row level security;

-- ---- profiles ----
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select using (public.is_member());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid() or public.current_role() in ('owner','admin'));

drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert on public.profiles
  for insert with check (public.current_role() in ('owner','admin') or id = auth.uid());

-- ---- generic helper to apply read=member / write=staff to a table ----
do $$
declare t text;
begin
  foreach t in array array[
    'customers','jobs','job_codes','quotes','quote_line_items',
    'work_orders','material_lists','material_list_items',
    'change_orders','forms','form_submissions','documents'
  ] loop
    execute format('drop policy if exists %1$s_read on public.%1$s;', t);
    execute format(
      'create policy %1$s_read on public.%1$s for select using (public.is_member());', t);
    execute format('drop policy if exists %1$s_write on public.%1$s;', t);
    execute format(
      'create policy %1$s_write on public.%1$s for all
         using (public.is_staff()) with check (public.is_staff());', t);
  end loop;
end $$;

-- ---- time_entries: own rows for techs, all for staff ----
drop policy if exists time_entries_select on public.time_entries;
create policy time_entries_select on public.time_entries
  for select using (profile_id = auth.uid() or public.is_staff());

drop policy if exists time_entries_insert on public.time_entries;
create policy time_entries_insert on public.time_entries
  for insert with check (profile_id = auth.uid() or public.is_staff());

drop policy if exists time_entries_update on public.time_entries;
create policy time_entries_update on public.time_entries
  for update using (profile_id = auth.uid() or public.is_staff());

drop policy if exists time_entries_delete on public.time_entries;
create policy time_entries_delete on public.time_entries
  for delete using (public.is_staff());

-- ---- conversations + messages: private to their owner ----
drop policy if exists conversations_owner on public.conversations;
create policy conversations_owner on public.conversations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists messages_owner on public.messages;
create policy messages_owner on public.messages
  for all using (
    exists (select 1 from public.conversations c
            where c.id = conversation_id and c.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.conversations c
            where c.id = conversation_id and c.user_id = auth.uid())
  );
