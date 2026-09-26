-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0353: the app counts page opens (Wave 0)
--
-- Nothing records which pages a company opens. The simplicity audits could only count saved rows,
-- and "no rows" is not "nobody looks at it", so usage could set no defaults. This counts OPENS:
--
--   page_opens (org_id, page, day) → opens
--     page: the route with every id taken out ("/jobs/[id]", "/jobs/[id]?tab=costs"). Only a
--           ?tab= survives from the query string; nothing else a URL can carry (names, searches,
--           tokens) is kept.
--     day:  the UTC day. On purpose: an org's timezone setting that doesn't parse must never make
--           a counter throw, and a day's edge is not what this is for.
--   No user id, no role, no device: a company's count, never a person's trail.
--
-- WHO WRITES: bump_page_open(page), SECURITY DEFINER, for the caller's own company only
-- (auth_org_id(): nobody signed in, a deactivated seat or a person with no company counts
-- nothing). The client strips ids before it calls (lib/page-pattern.ts); this strips them AGAIN,
-- because a client is never trusted: any path segment with a digit, or 25 characters or more,
-- becomes [id]. A page longer than 200 characters, or one not starting with "/", is not counted.
-- A crafted call can only inflate its own company's numbers.
--
-- WHO READS: platform admins (is_platform_admin(), 0176), and nobody else. RLS is on and there is
-- NO tenant read policy: a company can't read its own counts either (in a one-person company the
-- count is that person's usage). Usage sets feature DEFAULTS; it never justifies a cut.
--
-- LOCKS: a new table and a new function. Nothing existing is touched.
--
-- ORDER: after 0158 (auth_org_id) and 0176 (is_platform_admin). SAFE BEFORE OR AFTER THE CODE: the
-- counter's call fails quietly until this is applied (it is telemetry: a failed count is ignored,
-- never shown, never retried) and nothing else reads the table. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('public.auth_org_id()') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0353: auth_org_id (0158) or is_platform_admin (0176) is not on this database. Nothing was changed.';
  end if;
end $$;

create table if not exists public.page_opens (
  org_id uuid    not null references public.organizations(id) on delete cascade,
  page   text    not null,
  day    date    not null,
  opens  integer not null default 0,
  primary key (org_id, page, day),
  constraint page_opens_page_shape check (page ~ '^/[a-z0-9/_.\[\]-]{0,200}(\?tab=[a-z0-9_-]{1,40})?$' and length(page) <= 250),
  constraint page_opens_opens_nonneg check (opens >= 0)
);
comment on table public.page_opens is
  'How often each app page (ids stripped) is opened per company per UTC day (0353). No user id. Written only by bump_page_open for the caller''s company; read only by platform admins. Usage sets feature defaults; it never justifies a cut.';

alter table public.page_opens enable row level security;
revoke all on table public.page_opens from anon, authenticated;
grant select on table public.page_opens to authenticated;   -- and the one policy below says who
drop policy if exists page_opens_platform_read on public.page_opens;
create policy page_opens_platform_read on public.page_opens
  for select to authenticated
  using (public.is_platform_admin());

create or replace function public.bump_page_open(p_page text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.auth_org_id();   -- nobody / deactivated / no company: nothing counted
  v_path text;
  v_tab text;
  v_page text;
begin
  if v_org is null or p_page is null or length(p_page) > 200 or left(p_page, 1) <> '/' then
    return false;
  end if;
  v_path := lower(split_part(p_page, '?', 1));
  v_tab := lower(substring(p_page from '[?&]tab=([A-Za-z0-9_-]{1,40})(&|$)'));
  -- Re-strip the ids (never trust the client): a segment with a digit, or 25+ characters, is an id.
  select string_agg(case when t.seg ~ '[0-9]' or length(t.seg) >= 25 then '[id]' else t.seg end, '/' order by t.ord)
    into v_path
    from unnest(string_to_array(v_path, '/')) with ordinality as t(seg, ord);
  v_page := coalesce(nullif(v_path, ''), '/') || coalesce('?tab=' || v_tab, '');
  if v_page !~ '^/[a-z0-9/_.\[\]-]{0,200}(\?tab=[a-z0-9_-]{1,40})?$' then
    return false;
  end if;
  insert into public.page_opens as po (org_id, page, day, opens)
  values (v_org, v_page, (now() at time zone 'utc')::date, 1)
  on conflict (org_id, page, day) do update set opens = po.opens + 1;
  return true;
end $$;
revoke execute on function public.bump_page_open(text) from public, anon;
grant execute on function public.bump_page_open(text) to authenticated;
comment on function public.bump_page_open(text) is
  'Count one open of an app page for the caller''s company (0353). Ids are stripped again here; no user id is stored.';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_class c where c.oid = 'public.page_opens'::regclass and c.relrowsecurity
  ) then
    raise exception '0353: page_opens has row level security switched off. Nothing was changed.';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'page_opens') <> 1
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'page_opens'
                     and policyname = 'page_opens_platform_read' and cmd = 'SELECT') then
    raise exception '0353: page_opens must have exactly one policy, the platform admins'' read. Nothing was changed.';
  end if;
  if has_table_privilege('authenticated', 'public.page_opens', 'insert')
     or has_table_privilege('authenticated', 'public.page_opens', 'update')
     or has_table_privilege('authenticated', 'public.page_opens', 'delete')
     or has_table_privilege('anon', 'public.page_opens', 'select') then
    raise exception '0353: page_opens can be written or read by someone it should not be. Nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'page_opens'
              and column_name not in ('org_id', 'page', 'day', 'opens')) then
    raise exception '0353: page_opens holds a column beyond org, page, day and opens. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.bump_page_open(text)', 'execute') then
    raise exception '0353: anon can call bump_page_open. Nothing was changed.';
  end if;
  raise notice '0353: the app counts page opens.';
end $$;
