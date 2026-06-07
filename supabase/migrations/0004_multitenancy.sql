-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0004: MULTI-TENANCY
--
-- Turns the single-company app into a proper multi-tenant SaaS:
--   • organizations table (also holds per-org settings + subscription fields)
--   • org_id on every business table
--   • RLS rewritten so each org only sees its own data
--   • org_id auto-stamped on insert from the signed-in user (no app changes)
--   • per-organization document numbering (Q-, INV-, etc.)
--   • invitations table for team members
--
-- Run AFTER 0001, 0002, 0003. Safe to run once on an existing project: it
-- creates a "Default Organization", assigns any existing rows/users to it, and
-- promotes the first existing user to owner so you are not locked out.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- A. ORGANIZATIONS (identity + settings + subscription)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.organizations (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  -- settings / letterhead
  logo_url           text,
  address_line1      text,
  address_line2      text,
  phone              text,
  email              text,
  license            text,
  default_tax_rate   numeric(6,4) not null default 0,
  brand_color        text not null default '#0b57c4',
  -- subscription (Stripe) — populated in the billing phase
  plan                  text not null default 'trial',
  subscription_status   text not null default 'trialing',
  stripe_customer_id    text,
  stripe_subscription_id text,
  trial_ends_at         timestamptz not null default (now() + interval '14 days'),
  current_period_end    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

drop trigger if exists touch_organizations on public.organizations;
create trigger touch_organizations before update on public.organizations
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- B. INVITATIONS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,
  role        user_role not null default 'tech',
  token       text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by  uuid references public.profiles(id),
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists invitations_org_idx on public.invitations(org_id);
create index if not exists invitations_email_idx on public.invitations(email);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. ADD org_id COLUMNS (nullable for now; backfilled in D, locked in H)
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','customers','jobs','job_codes','quotes','quote_line_items',
    'work_orders','material_lists','material_list_items','time_entries',
    'change_orders','forms','form_submissions','documents','inventory_items',
    'purchase_orders','purchase_order_items','invoices','invoice_items','payments'
  ] loop
    execute format(
      'alter table public.%I add column if not exists org_id uuid references public.organizations(id) on delete cascade;', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- D. DEFAULT ORG + BACKFILL existing data (no-op on a fresh DB)
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  default_org uuid;
  first_user  uuid;
begin
  -- Only create a default org if there is existing data to rescue.
  if exists (select 1 from public.profiles) then
    select id into default_org from public.organizations where name = 'Default Organization' limit 1;
    if default_org is null then
      insert into public.organizations (name) values ('Default Organization')
      returning id into default_org;
    end if;

    update public.profiles            set org_id = default_org where org_id is null;
    update public.customers           set org_id = default_org where org_id is null;
    update public.jobs                set org_id = default_org where org_id is null;
    update public.job_codes           set org_id = default_org where org_id is null;
    update public.quotes              set org_id = default_org where org_id is null;
    update public.quote_line_items    set org_id = default_org where org_id is null;
    update public.work_orders         set org_id = default_org where org_id is null;
    update public.material_lists      set org_id = default_org where org_id is null;
    update public.material_list_items set org_id = default_org where org_id is null;
    update public.time_entries        set org_id = default_org where org_id is null;
    update public.change_orders       set org_id = default_org where org_id is null;
    update public.forms               set org_id = default_org where org_id is null;
    update public.form_submissions    set org_id = default_org where org_id is null;
    update public.documents           set org_id = default_org where org_id is null;
    update public.inventory_items     set org_id = default_org where org_id is null;
    update public.purchase_orders     set org_id = default_org where org_id is null;
    update public.purchase_order_items set org_id = default_org where org_id is null;
    update public.invoices            set org_id = default_org where org_id is null;
    update public.invoice_items       set org_id = default_org where org_id is null;
    update public.payments            set org_id = default_org where org_id is null;

    -- Promote the earliest user to owner if the org has no owner yet.
    if not exists (select 1 from public.profiles where org_id = default_org and role = 'owner') then
      select id into first_user from public.profiles where org_id = default_org
        order by created_at asc limit 1;
      if first_user is not null then
        update public.profiles set role = 'owner' where id = first_user;
      end if;
    end if;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- E. HELPERS — rename current_role() → app_user_role(); add auth_org_id()
-- ─────────────────────────────────────────────────────────────────────────────
-- Drop policies that depend on current_role() before dropping the function.
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_admin_insert on public.profiles;
drop policy if exists profiles_read on public.profiles;
drop function if exists public.current_role();

create or replace function public.app_user_role()
returns user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.auth_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid();
$$;

create or replace function public.is_org_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role in ('owner','admin','office') from public.profiles where id = auth.uid()),
    false);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- F. AUTO-STAMP org_id ON INSERT (so module code doesn't have to pass it)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.set_org_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    new.org_id := public.auth_org_id();
  end if;
  return new;
end $$;

-- Non-numbered business tables: just stamp org_id.
do $$
declare t text;
begin
  foreach t in array array[
    'customers','job_codes','quote_line_items','material_lists',
    'material_list_items','time_entries','forms','form_submissions','documents',
    'inventory_items','purchase_order_items','invoice_items','payments'
  ] loop
    execute format('drop trigger if exists stamp_org_%1$s on public.%1$s;', t);
    execute format(
      'create trigger stamp_org_%1$s before insert on public.%1$s
       for each row execute function public.set_org_id();', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- G. PER-ORG DOCUMENT NUMBERING
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.doc_counters (
  org_id   uuid not null references public.organizations(id) on delete cascade,
  doc_type text not null,
  current  bigint not null default 0,
  primary key (org_id, doc_type)
);

create or replace function public.next_doc_number(p_org uuid, p_type text, p_prefix text)
returns text language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  insert into public.doc_counters (org_id, doc_type, current)
  values (p_org, p_type, 1)
  on conflict (org_id, doc_type)
  do update set current = public.doc_counters.current + 1
  returning current into n;
  return p_prefix || lpad(n::text, 5, '0');
end $$;

-- Each numbered table: stamp org_id, then assign a per-org number if missing.
-- Drop the old global-sequence defaults first.
alter table public.jobs            alter column job_number     drop default;
alter table public.quotes          alter column quote_number   drop default;
alter table public.work_orders     alter column wo_number      drop default;
alter table public.change_orders   alter column co_number      drop default;
alter table public.purchase_orders alter column po_number      drop default;
alter table public.invoices        alter column invoice_number drop default;

create or replace function public.number_jobs() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then new.org_id := public.auth_org_id(); end if;
  if new.job_number is null or new.job_number = '' then
    new.job_number := public.next_doc_number(new.org_id, 'job', 'J-');
  end if;
  return new;
end $$;
create or replace function public.number_quotes() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then new.org_id := public.auth_org_id(); end if;
  if new.quote_number is null or new.quote_number = '' then
    new.quote_number := public.next_doc_number(new.org_id, 'quote', 'Q-');
  end if;
  return new;
end $$;
create or replace function public.number_work_orders() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then new.org_id := public.auth_org_id(); end if;
  if new.wo_number is null or new.wo_number = '' then
    new.wo_number := public.next_doc_number(new.org_id, 'wo', 'WO-');
  end if;
  return new;
end $$;
create or replace function public.number_change_orders() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then new.org_id := public.auth_org_id(); end if;
  if new.co_number is null or new.co_number = '' then
    new.co_number := public.next_doc_number(new.org_id, 'co', 'CO-');
  end if;
  return new;
end $$;
create or replace function public.number_purchase_orders() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then new.org_id := public.auth_org_id(); end if;
  if new.po_number is null or new.po_number = '' then
    new.po_number := public.next_doc_number(new.org_id, 'po', 'PO-');
  end if;
  return new;
end $$;
create or replace function public.number_invoices() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then new.org_id := public.auth_org_id(); end if;
  if new.invoice_number is null or new.invoice_number = '' then
    new.invoice_number := public.next_doc_number(new.org_id, 'invoice', 'INV-');
  end if;
  return new;
end $$;

drop trigger if exists number_jobs on public.jobs;
create trigger number_jobs before insert on public.jobs
  for each row execute function public.number_jobs();
drop trigger if exists number_quotes on public.quotes;
create trigger number_quotes before insert on public.quotes
  for each row execute function public.number_quotes();
drop trigger if exists number_work_orders on public.work_orders;
create trigger number_work_orders before insert on public.work_orders
  for each row execute function public.number_work_orders();
drop trigger if exists number_change_orders on public.change_orders;
create trigger number_change_orders before insert on public.change_orders
  for each row execute function public.number_change_orders();
drop trigger if exists number_purchase_orders on public.purchase_orders;
create trigger number_purchase_orders before insert on public.purchase_orders
  for each row execute function public.number_purchase_orders();
drop trigger if exists number_invoices on public.invoices;
create trigger number_invoices before insert on public.invoices
  for each row execute function public.number_invoices();

-- Seed each existing org's counters past its current max so numbers don't repeat.
do $$
declare r record;
begin
  for r in select id from public.organizations loop
    insert into public.doc_counters(org_id, doc_type, current) values
      (r.id, 'job',     coalesce((select count(*) from public.jobs            where org_id = r.id),0)),
      (r.id, 'quote',   coalesce((select count(*) from public.quotes          where org_id = r.id),0)),
      (r.id, 'wo',      coalesce((select count(*) from public.work_orders     where org_id = r.id),0)),
      (r.id, 'co',      coalesce((select count(*) from public.change_orders   where org_id = r.id),0)),
      (r.id, 'po',      coalesce((select count(*) from public.purchase_orders where org_id = r.id),0)),
      (r.id, 'invoice', coalesce((select count(*) from public.invoices        where org_id = r.id),0))
    on conflict (org_id, doc_type) do nothing;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H. LOCK org_id NOT NULL on business tables (profiles stays nullable:
--    a brand-new signup has no org until onboarding).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'customers','jobs','job_codes','quotes','quote_line_items','work_orders',
    'material_lists','material_list_items','time_entries','change_orders',
    'forms','form_submissions','documents','inventory_items','purchase_orders',
    'purchase_order_items','invoices','invoice_items','payments'
  ] loop
    -- Only enforce NOT NULL if there are no null rows left (safety on fresh DBs
    -- there are none; on existing DBs we backfilled in D).
    execute format('alter table public.%I alter column org_id set not null;', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- I. RLS REWRITE — org-scoped read, staff-of-org write
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.organizations enable row level security;
alter table public.invitations   enable row level security;
alter table public.doc_counters  enable row level security;

-- organizations: create freely (onboarding), read/own-update by members.
drop policy if exists organizations_insert on public.organizations;
create policy organizations_insert on public.organizations
  for insert with check (auth.uid() is not null);
drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select using (id = public.auth_org_id());
drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update using (id = public.auth_org_id() and public.app_user_role() in ('owner','admin'));

-- invitations: managed by owner/admin of the org.
drop policy if exists invitations_all on public.invitations;
create policy invitations_all on public.invitations
  for all using (org_id = public.auth_org_id() and public.app_user_role() in ('owner','admin'))
  with check (org_id = public.auth_org_id() and public.app_user_role() in ('owner','admin'));

-- doc_counters: never touched directly by clients.
drop policy if exists doc_counters_none on public.doc_counters;
create policy doc_counters_none on public.doc_counters
  for select using (org_id = public.auth_org_id());

-- profiles: read your team; update self or (owner/admin) anyone in your org.
create policy profiles_read on public.profiles
  for select using (id = auth.uid() or org_id = public.auth_org_id());
create policy profiles_update_self on public.profiles
  for update using (
    id = auth.uid()
    or (org_id = public.auth_org_id() and public.app_user_role() in ('owner','admin'))
  );
create policy profiles_insert_self on public.profiles
  for insert with check (id = auth.uid());

-- Business tables: read if same org; write if same org AND office+.
do $$
declare t text;
begin
  foreach t in array array[
    'customers','jobs','job_codes','quotes','quote_line_items','work_orders',
    'material_lists','material_list_items','change_orders','forms',
    'form_submissions','documents','inventory_items','purchase_orders',
    'purchase_order_items','invoices','invoice_items','payments'
  ] loop
    execute format('drop policy if exists %1$s_read on public.%1$s;', t);
    execute format('drop policy if exists %1$s_write on public.%1$s;', t);
    execute format(
      'create policy %1$s_read on public.%1$s for select
         using (org_id = public.auth_org_id());', t);
    execute format(
      'create policy %1$s_write on public.%1$s for all
         using (org_id = public.auth_org_id() and public.is_org_staff())
         with check (org_id = public.auth_org_id() and public.is_org_staff());', t);
  end loop;
end $$;

-- time_entries: a tech sees/edits only their own within the org; staff see all.
drop policy if exists time_entries_select on public.time_entries;
create policy time_entries_select on public.time_entries
  for select using (
    org_id = public.auth_org_id()
    and (profile_id = auth.uid() or public.is_org_staff())
  );
drop policy if exists time_entries_insert on public.time_entries;
create policy time_entries_insert on public.time_entries
  for insert with check (
    org_id = public.auth_org_id()
    and (profile_id = auth.uid() or public.is_org_staff())
  );
drop policy if exists time_entries_update on public.time_entries;
create policy time_entries_update on public.time_entries
  for update using (
    org_id = public.auth_org_id()
    and (profile_id = auth.uid() or public.is_org_staff())
  );
drop policy if exists time_entries_delete on public.time_entries;
create policy time_entries_delete on public.time_entries
  for delete using (org_id = public.auth_org_id() and public.is_org_staff());

-- conversations / messages stay private to the owning user (already isolated).

-- ─────────────────────────────────────────────────────────────────────────────
-- J. Prevent self role-escalation
--    A user may edit their own profile, but cannot change their own role unless
--    they are already owner/admin, or this is first-time onboarding (no org yet).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.prevent_role_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role
     and old.org_id is not null
     and coalesce(public.app_user_role()::text, '') not in ('owner','admin') then
    raise exception 'Only an owner or admin can change roles.';
  end if;
  return new;
end $$;

drop trigger if exists guard_role on public.profiles;
create trigger guard_role before update on public.profiles
  for each row execute function public.prevent_role_escalation();

-- ─────────────────────────────────────────────────────────────────────────────
-- K. ONBOARDING — create an organization and become its owner (atomic, safe).
--    SECURITY DEFINER so it can set the owner role and seed defaults regardless
--    of RLS, but it only ever acts on the calling user and only if they have no
--    org yet. Seeds standard job codes + a starter safety form for the new org.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.create_organization(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  existing uuid;
  new_org uuid;
begin
  if uid is null then
    raise exception 'Not authenticated.';
  end if;

  select org_id into existing from public.profiles where id = uid;
  if existing is not null then
    return existing;  -- already in an org; no-op
  end if;

  insert into public.organizations (name) values (coalesce(nullif(trim(p_name), ''), 'My Company'))
  returning id into new_org;

  update public.profiles set org_id = new_org, role = 'owner' where id = uid;
  if not found then
    -- Auth user exists but has no profile row yet (e.g. signed up before the
    -- profiles trigger existed). Create it now.
    insert into public.profiles (id, org_id, role, email)
    values (uid, new_org, 'owner', auth.email())
    on conflict (id) do update set org_id = new_org, role = 'owner';
  end if;

  -- Seed standard electrical job codes for this org.
  insert into public.job_codes (org_id, code, description, billable) values
    (new_org, 'SVC',   'Service call',            true),
    (new_org, 'ROUGH', 'Rough-in wiring',         true),
    (new_org, 'TRIM',  'Trim-out / devices',      true),
    (new_org, 'PANEL', 'Panel / service upgrade', true),
    (new_org, 'TROUB', 'Troubleshooting',         true),
    (new_org, 'LOW',   'Low voltage / data',      true),
    (new_org, 'GEN',   'Generator install',       true),
    (new_org, 'TRAVEL','Travel time',             true),
    (new_org, 'SHOP',  'Shop / yard time',        false),
    (new_org, 'PTO',   'Paid time off',           false)
  on conflict do nothing;

  -- Seed a starter safety form.
  insert into public.forms (org_id, name, description, schema)
  values (
    new_org,
    'Job Site Safety Checklist',
    'Quick pre-work safety walkthrough.',
    '[
      {"key":"ppe","label":"PPE worn (hard hat, glasses, gloves)","type":"checkbox"},
      {"key":"loto","label":"Lockout/Tagout applied where required","type":"checkbox"},
      {"key":"voltage_verified","label":"Verified de-energized with meter","type":"checkbox"},
      {"key":"hazards","label":"Hazards noted","type":"textarea"},
      {"key":"photos","label":"Site photos attached","type":"checkbox"}
    ]'::jsonb
  );

  return new_org;
end $$;
