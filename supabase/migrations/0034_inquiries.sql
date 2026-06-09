-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0034: inquiries as a first-class entity
-- An inquiry is its OWN record (web lead or manual). It is never silently
-- turned into a customer; the user explicitly converts it (→ customer / quote /
-- job) and we stamp the link. The public splash form now lands here, not in
-- customers. Run AFTER 0026. Existing 'lead' customers are left untouched.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.inquiries (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references public.organizations(id) on delete cascade,
  name            text not null,
  company_name    text,
  email           text,
  phone           text,
  address         text,
  city            text,
  state           text,
  zip             text,
  type            text default 'residential',     -- residential | commercial | industrial
  message         text,                            -- what they're asking for
  notes           text,
  source          text not null default 'manual',  -- manual | public_form
  status          text not null default 'new',     -- new | contacted | quoted | won | lost
  next_follow_up_at  date,
  last_contacted_at  timestamptz,
  -- Explicit conversion linkage (null until the user converts):
  customer_id     uuid references public.customers(id) on delete set null,
  converted_to    text,                            -- customer | quote | job
  converted_at    timestamptz,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists inquiries_org_idx on public.inquiries(org_id, created_at desc);
create index if not exists inquiries_open_idx on public.inquiries(org_id, converted_at, next_follow_up_at);

drop trigger if exists stamp_org_inquiries on public.inquiries;
create trigger stamp_org_inquiries before insert on public.inquiries
  for each row execute function public.set_org_id();

alter table public.inquiries enable row level security;

drop policy if exists inquiries_read on public.inquiries;
create policy inquiries_read on public.inquiries
  for select using (org_id = public.auth_org_id());

drop policy if exists inquiries_write on public.inquiries;
create policy inquiries_write on public.inquiries
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

-- Public splash submissions now create an inquiry (not a customer).
create or replace function public.submit_inquiry(
  p_org     uuid,
  p_name    text,
  p_email   text default null,
  p_phone   text default null,
  p_message text default null,
  p_address text default null,
  p_city    text default null,
  p_state   text default null,
  p_zip     text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Name is required';
  end if;
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'Unknown organization';
  end if;

  insert into public.inquiries (
    org_id, name, email, phone, address, city, state, zip,
    message, source, status, type
  ) values (
    p_org,
    left(btrim(p_name), 200),
    nullif(left(btrim(coalesce(p_email, '')), 200), ''),
    nullif(left(btrim(coalesce(p_phone, '')), 50), ''),
    nullif(left(btrim(coalesce(p_address, '')), 300), ''),
    nullif(left(btrim(coalesce(p_city, '')), 100), ''),
    nullif(left(btrim(coalesce(p_state, '')), 50), ''),
    nullif(left(btrim(coalesce(p_zip, '')), 20), ''),
    nullif(left(btrim(coalesce(p_message, '')), 2000), ''),
    'public_form', 'new', 'residential'
  );
end $$;

grant execute on function public.submit_inquiry(uuid, text, text, text, text, text, text, text, text) to anon, authenticated;
