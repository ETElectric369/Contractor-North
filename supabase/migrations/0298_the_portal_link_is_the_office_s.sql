-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0298: a customer's portal link belongs to the office
--
-- THE HOLE (customer portal plan, P0; checked live 2026-09-24). customers.portal_token (0070) is
-- the whole credential for /portal/<token>: a page, open to anyone who holds the link, that lists
-- every invoice, contract and quote the customer has. The column sat on the customers row, and
-- customers_read is `org_id = auth_org_id()`, so EVERY member of the org could read it, techs
-- included — straight off /rest/v1/customers with their own session, and the /crm/<id> page shipped
-- it to the browser in the row. customer_portal(p_token) is SECURITY DEFINER and anon could run it.
-- So any crew member could pull any customer's link and read their money documents. And the link
-- had no off switch: no revoke, no rotate, no way to see whether it was ever opened
-- (token-portals-need-off-switches).
--
-- THE FIX, the 0215/0216 shape (move the private value to a staff-only home, then empty the
-- readable copy):
--  1. customer_portal_access — one row per customer, holding the SAME token value (every link
--     already in an inbox keeps working), an on/off switch, who rotated or turned it off, and when
--     it was last opened. RLS: only active office staff of the org read it. Nobody writes it
--     directly; the only writers are the functions below and the new-customer trigger.
--  2. customers.portal_token is emptied and pinned empty by a CHECK. It is NOT dropped yet: the
--     app that is live while this applies still names the column in two selects (the invoice email
--     and the portal email), and a dropped column would make both fail outright; an empty one just
--     leaves the portal link out. Drop it in a later migration once this deploy is live.
--  3. customer_portal(p_token) reads the token from its new home, answers a turned-off (or
--     replaced) link with {disabled: true, org: {name}} so the page can say so in plain words, and
--     is no longer executable by anon or authenticated: the page calls it with the service role.
--  4. portal_link_rotate / portal_link_set_enabled: the office's New Link and Turn Off / Turn On,
--     gated INSIDE the function (active staff, same org). portal_record_open stamps Last Opened,
--     at most once a minute per link, service role only.
--
-- ORDER: deploy the app first, then apply this. The new app reads the old column's world fine
-- (the portal page calls customer_portal as the service role, which could always run it), while
-- the OLD app calls customer_portal as anon and would 404 every portal link between this
-- migration and the deploy.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the office's home for the link ──────────────────────────────────────────────────────────
create table public.customer_portal_access (
  customer_id    uuid primary key references public.customers(id) on delete cascade,
  org_id         uuid not null references public.organizations(id) on delete cascade,
  token          text not null unique check (length(token) >= 32),
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  rotated_at     timestamptz,
  rotated_by     uuid references public.profiles(id) on delete set null,
  disabled_at    timestamptz,
  disabled_by    uuid references public.profiles(id) on delete set null,
  last_opened_at timestamptz
);
comment on table public.customer_portal_access is
  'PRIVATE (0298): the customer''s /portal/<token> link. Office staff read it (RLS); nobody writes it except portal_link_rotate / portal_link_set_enabled / portal_record_open and the customers insert trigger.';

create index customer_portal_access_org_idx on public.customer_portal_access(org_id);

-- Links the office replaced with New Link. Kept so the old link says "turned off" in plain words
-- instead of a bare 404 (a customer holding it should know to ask, not wonder). Server-side only.
create table public.customer_portal_retired_links (
  token       text primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  retired_at  timestamptz not null default now(),
  retired_by  uuid references public.profiles(id) on delete set null
);
create index customer_portal_retired_links_customer_idx on public.customer_portal_retired_links(customer_id);

alter table public.customer_portal_access enable row level security;
alter table public.customer_portal_retired_links enable row level security;

-- Supabase's default privileges hand every new table to anon and authenticated in full. Take it
-- back: the office READS the link (under the policy below); every write goes through a function.
revoke all on public.customer_portal_access from public, anon, authenticated;
revoke all on public.customer_portal_retired_links from public, anon, authenticated;
grant select on public.customer_portal_access to authenticated;
grant all on public.customer_portal_access to service_role;
grant all on public.customer_portal_retired_links to service_role;

create policy customer_portal_access_staff_read on public.customer_portal_access
  for select to authenticated
  using (org_id = public.auth_org_id() and public.is_org_staff());

-- ── 2. move every existing link, value for value ───────────────────────────────────────────────
insert into public.customer_portal_access (customer_id, org_id, token)
select c.id, c.org_id, c.portal_token
  from public.customers c
 where c.portal_token is not null
   and c.org_id is not null
on conflict (customer_id) do nothing;

-- Any customer that somehow had no token gets a fresh one (0070 made it NOT NULL, so none should).
insert into public.customer_portal_access (customer_id, org_id, token)
select c.id, c.org_id, encode(extensions.gen_random_bytes(16), 'hex')
  from public.customers c
 where not exists (select 1 from public.customer_portal_access a where a.customer_id = c.id)
   and c.org_id is not null;

do $$
declare n int;
begin
  -- Every link that exists today must exist in the new home with the same value.
  select count(*) into n
    from public.customers c
    left join public.customer_portal_access a on a.customer_id = c.id and a.token = c.portal_token
   where c.portal_token is not null and c.org_id is not null and a.customer_id is null;
  if n > 0 then
    raise exception '0298: % customer link(s) did not move with their value. Nothing was changed.', n;
  end if;
end $$;

-- A new customer gets its link the moment it exists, whichever of the many writers made it.
create or replace function public.customer_portal_access_for_new_customer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is not null then
    insert into public.customer_portal_access (customer_id, org_id, token)
    values (new.id, new.org_id, encode(extensions.gen_random_bytes(16), 'hex'))
    on conflict (customer_id) do nothing;
  end if;
  return null;
end $$;
revoke execute on function public.customer_portal_access_for_new_customer() from public, anon, authenticated;

create trigger customer_portal_access_for_new_customer
  after insert on public.customers
  for each row execute function public.customer_portal_access_for_new_customer();

-- ── 3. empty the copy every member could read, and keep it empty ───────────────────────────────
-- touch_customers would bump updated_at on all of them; this is not an edit anyone made.
alter table public.customers disable trigger touch_customers;
alter table public.customers alter column portal_token drop default;
alter table public.customers alter column portal_token drop not null;
update public.customers set portal_token = null where portal_token is not null;
alter table public.customers enable trigger touch_customers;
-- Live, the uniqueness is a CONSTRAINT (checked 2026-09-24), not the bare index 0070's file shows;
-- a bare DROP INDEX would refuse. Drop whichever this database has.
alter table public.customers drop constraint if exists customers_portal_token_key;
drop index if exists public.customers_portal_token_key;
alter table public.customers add constraint customers_portal_token_moved check (portal_token is null);
comment on column public.customers.portal_token is
  'EMPTY (0298): the portal link moved to customer_portal_access, which only office staff can read. Drop this column once the 0298 app is live.';

-- ── 4. the door, reading from the new home ─────────────────────────────────────────────────────
-- Rebuilt from the LIVE pg_get_functiondef (2026-09-24; 0070 + 0247's to_be_scheduled). Changes:
-- the lookup, the turned-off answer, and the org address (address_line1/city/state/zip) is no
-- longer projected: the page never rendered it.
create or replace function public.customer_portal(p_token text)
returns json language plpgsql stable security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  v_org uuid;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;

  select * into a from public.customer_portal_access where token = p_token;
  if not found then
    -- A link the office replaced: say it was turned off, never what it used to show.
    select r.org_id into v_org from public.customer_portal_retired_links r where r.token = p_token;
    if v_org is null then
      return null;
    end if;
    return json_build_object('disabled', true,
      'org', (select json_build_object('name', o.name) from public.organizations o where o.id = v_org));
  end if;

  if not a.enabled then
    return json_build_object('disabled', true,
      'org', (select json_build_object('name', o.name) from public.organizations o where o.id = a.org_id));
  end if;

  return (
    select json_build_object(
      'customer', json_build_object('name', c.name, 'company_name', c.company_name),
      'org', (select json_build_object(
          'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone, 'email', o.email,
          'brand_color', o.brand_color, 'license', o.license)
        from public.organizations o where o.id = c.org_id),
      'invoices', coalesce((select json_agg(json_build_object(
          'invoice_number', i.invoice_number, 'status', i.status, 'total', i.total,
          'amount_paid', i.amount_paid, 'public_token', i.public_token, 'created_at', i.created_at)
          order by i.created_at desc)
        from public.invoices i where i.customer_id = c.id and i.status in ('sent', 'partial', 'paid', 'overdue')), '[]'::json),
      'contracts', coalesce((select json_agg(json_build_object(
          'contract_number', ct.contract_number, 'status', ct.status, 'title', ct.title,
          'public_token', ct.public_token, 'signed_at', ct.signed_at) order by ct.created_at desc)
        from public.contracts ct where ct.customer_id = c.id and ct.status in ('sent', 'signed')), '[]'::json),
      'quotes', coalesce((select json_agg(json_build_object(
          'quote_number', q.quote_number, 'status', q.status, 'total', q.total,
          'doc_type', q.doc_type, 'public_token', q.public_token) order by q.created_at desc)
        from public.quotes q where q.customer_id = c.id and q.status in ('sent', 'accepted')), '[]'::json),
      -- Allowlist of customer-facing statuses (fail-closed): never surface internal
      -- pre-sale 'estimate' jobs or a future internal status to the customer.
      'jobs', coalesce((select json_agg(json_build_object(
          'name', j.name, 'status', j.status, 'job_number', j.job_number) order by j.created_at desc)
        from public.jobs j where j.customer_id = c.id and j.status in ('to_be_scheduled', 'scheduled', 'in_progress', 'on_hold', 'complete', 'invoiced')), '[]'::json)
    )
    from public.customers c
   where c.id = a.customer_id and c.org_id = a.org_id
  );
end $$;
revoke execute on function public.customer_portal(text) from public, anon, authenticated;
grant execute on function public.customer_portal(text) to service_role;

-- Last Opened. The page calls this from the customer's browser (never from link previewers or the
-- office's own look). At most one write a minute per link: a refresh storm is one row touch.
create or replace function public.portal_record_open(p_token text)
returns void language sql volatile security definer set search_path = public as $$
  update public.customer_portal_access
     set last_opened_at = now()
   where token = p_token
     and enabled
     and (last_opened_at is null or last_opened_at < now() - interval '1 minute');
$$;
revoke execute on function public.portal_record_open(text) from public, anon, authenticated;
grant execute on function public.portal_record_open(text) to service_role;

-- ── 5. the office's switches ───────────────────────────────────────────────────────────────────
-- New Link: the old link stops at once (it now reads "turned off"), and the new one works right
-- away — a fresh link is issued to be used, so this also turns the link back on.
create or replace function public.portal_link_rotate(p_customer_id uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  v_new text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  if auth.uid() is null or not public.is_org_staff() then
    raise exception 'Only the office can change a customer''s link.' using errcode = '42501';
  end if;
  select * into a from public.customer_portal_access
   where customer_id = p_customer_id and org_id = public.auth_org_id()
   for update;
  if not found then
    raise exception 'That customer isn''t in your book.' using errcode = 'P0002';
  end if;
  insert into public.customer_portal_retired_links (token, customer_id, org_id, retired_by)
  values (a.token, a.customer_id, a.org_id, auth.uid())
  on conflict (token) do nothing;
  update public.customer_portal_access
     set token = v_new, enabled = true, rotated_at = now(), rotated_by = auth.uid(),
         disabled_at = null, disabled_by = null, last_opened_at = null
   where customer_id = a.customer_id;
  return v_new;
end $$;
revoke execute on function public.portal_link_rotate(uuid) from public, anon;
grant execute on function public.portal_link_rotate(uuid) to authenticated, service_role;

-- Turn Off / Turn On. Returns the state it left the link in.
create or replace function public.portal_link_set_enabled(p_customer_id uuid, p_enabled boolean)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null or not public.is_org_staff() then
    raise exception 'Only the office can change a customer''s link.' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'Say on or off.' using errcode = '22004';
  end if;
  update public.customer_portal_access
     set enabled = p_enabled,
         disabled_at = case when p_enabled then null else now() end,
         disabled_by = case when p_enabled then null else auth.uid() end
   where customer_id = p_customer_id and org_id = public.auth_org_id();
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'That customer isn''t in your book.' using errcode = 'P0002';
  end if;
  return p_enabled;
end $$;
revoke execute on function public.portal_link_set_enabled(uuid, boolean) from public, anon;
grant execute on function public.portal_link_set_enabled(uuid, boolean) to authenticated, service_role;

-- ── 6. self-check ──────────────────────────────────────────────────────────────────────────────
do $$
declare n int;
begin
  select count(*) into n from public.customers c
   where c.org_id is not null
     and not exists (select 1 from public.customer_portal_access a where a.customer_id = c.id);
  if n > 0 then
    raise exception '0298: % customer(s) have no portal link row. Nothing was changed.', n;
  end if;
  select count(*) into n from public.customers where portal_token is not null;
  if n > 0 then
    raise exception '0298: % customer row(s) still carry a readable link. Nothing was changed.', n;
  end if;
  if has_function_privilege('anon', 'public.customer_portal(text)', 'execute')
     or has_function_privilege('authenticated', 'public.customer_portal(text)', 'execute') then
    raise exception '0298: customer_portal is still callable without the service role. Nothing was changed.';
  end if;
end $$;
