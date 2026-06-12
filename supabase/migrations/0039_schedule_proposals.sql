-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0039: customer-confirmed scheduling
-- "Propose 3 dates → text the customer a link → they tap one → the job
-- schedules itself." Public access goes through SECURITY DEFINER RPCs keyed
-- by an unguessable token, mirroring the inquiry portal. Run AFTER 0026.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.schedule_proposals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  job_id      uuid not null references public.jobs(id) on delete cascade,
  token       text not null unique default replace(gen_random_uuid()::text, '-', ''),
  dates       jsonb not null,                  -- ["YYYY-MM-DD", ...] up to 3
  status      text not null default 'pending', -- pending | confirmed | cancelled
  chosen_date date,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists schedule_proposals_job_idx on public.schedule_proposals(job_id, status);

drop trigger if exists stamp_org_schedule_proposals on public.schedule_proposals;
create trigger stamp_org_schedule_proposals before insert on public.schedule_proposals
  for each row execute function public.set_org_id();

alter table public.schedule_proposals enable row level security;

drop policy if exists schedule_proposals_rw on public.schedule_proposals;
create policy schedule_proposals_rw on public.schedule_proposals
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

-- Public: what the customer sees on the pick page (branding + choices only).
create or replace function public.get_schedule_proposal(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'org_name', o.name,
    'logo_url', o.logo_url,
    'brand_color', o.brand_color,
    'phone', o.phone,
    'job_name', j.name,
    'address', j.address,
    'dates', sp.dates,
    'status', sp.status,
    'chosen_date', sp.chosen_date
  )
  from public.schedule_proposals sp
  join public.jobs j on j.id = sp.job_id
  join public.organizations o on o.id = sp.org_id
  where sp.token = p_token;
$$;

-- Public: the customer picks a date → job schedules itself (8am–4pm local-ish;
-- stored 15:00–23:00 UTC ≈ 8am–4pm Pacific).
create or replace function public.choose_schedule_date(p_token text, p_date date)
returns json language plpgsql security definer set search_path = public as $$
declare
  v record;
begin
  select * into v from public.schedule_proposals where token = p_token;
  if v is null then
    raise exception 'Unknown link';
  end if;
  if v.status <> 'pending' then
    raise exception 'This link was already used';
  end if;
  if not (v.dates ? p_date::text) then
    raise exception 'That date is not one of the offered options';
  end if;

  update public.schedule_proposals
    set status = 'confirmed', chosen_date = p_date
    where id = v.id;

  update public.jobs
    set scheduled_start = (p_date::timestamptz + interval '15 hours'),
        scheduled_end   = (p_date::timestamptz + interval '23 hours'),
        status = 'scheduled',
        updated_at = now()
    where id = v.job_id;

  return json_build_object('ok', true, 'chosen_date', p_date);
end $$;

grant execute on function public.get_schedule_proposal(text) to anon, authenticated;
grant execute on function public.choose_schedule_date(text, date) to anon, authenticated;
