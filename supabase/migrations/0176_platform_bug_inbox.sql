-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0176: the platform can see the bugs its testers file
--
-- Erik is opening the product to its first outside beta tester (Andrew Cohen). The
-- point of a beta is that WE see what he hits and fix it — but bug_reports is scoped
-- strictly per org:
--     bug_reports_staff:  org_id = auth_org_id() AND is_org_staff()
-- so a report Andrew files in HIS org is invisible to Erik. He'd be testing into a
-- void, and neither of them would know.
--
-- Erik: "i want to compare for sure and build this properly not just have his bugs
-- 'necessarily' go unfiltered."
--
-- THE COMPARISON IS THE WHOLE POINT, and it already works on the two orgs that exist:
--   7 open on /timeclock, 6 on /planner, 4 on /leads, 4 on /appointments — each hit by
--   BOTH tenants. A page two unrelated contractors both trip over is a PRODUCT bug. A
--   page only one trips over may just be that person's workflow. You cannot tell those
--   apart from inside a single tenant, which is exactly why the platform needs the view.
--
-- WHY A TABLE AND NOT A ROLE. profiles.role is tenant-controlled — an org owner sets
-- roles inside their own org, so a role-based platform admin would be self-grantable by
-- every customer. This table is RLS-locked with NO policies: service-role writes only,
-- invisible to every client. Granting it is a deliberate act outside the product.
--
-- WHAT IT DOES *NOT* GRANT. bug_reports only. Not customers, not invoices, not payroll,
-- not another tenant's jobs. Today's audit turned up an app host that would render any
-- tenant to anyone; the lesson taken from it is that a cross-tenant read has to be one
-- narrow, named, auditable hole rather than a general power.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  granted_at timestamptz not null default now()
);

comment on table public.platform_admins is
  'People who may read bug reports ACROSS tenants, for running the beta. Service-role writes only (RLS on, no policies) — profiles.role is tenant-controlled and would be self-grantable. Scoped to bug_reports and nothing else — 0176.';

alter table public.platform_admins enable row level security;
-- Deliberately NO policies: nothing client-side can read or write this table.

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

grant execute on function public.is_platform_admin() to authenticated;

-- Reading and triaging bugs across tenants. The org-scoped rule is UNCHANGED and still
-- carries every normal user; this only adds a second way in, for a named few.
drop policy if exists bug_reports_staff on public.bug_reports;
create policy bug_reports_staff on public.bug_reports
  for all to authenticated
  using (
    (org_id = public.auth_org_id() and public.is_org_staff())
    or public.is_platform_admin()
  )
  with check (
    -- A platform admin TRIAGES (status, notes); they do not author reports into someone
    -- else's org. Writing stays org-scoped so a bug can never appear in a tenant's list
    -- having come from outside it.
    org_id = public.auth_org_id() and public.is_org_staff()
  );

-- Erik, by user id resolved from his email so this is re-runnable and doesn't hardcode a uuid.
insert into public.platform_admins (user_id, note)
select id, 'Erik Taylor — platform owner, running the beta (0176)'
  from auth.users
 where lower(email) = lower('eriktaylor222@gmail.com')
on conflict (user_id) do nothing;

-- ── ATTRIBUTION, or it's just a dump ──────────────────────────────────────────
-- Seeing another tenant's bug without knowing WHOSE it is fails the actual purpose:
-- the value of a second tester is telling "both of them hit this" (a product bug) from
-- "only he hits this" (his workflow). But `organizations` is RLS-scoped too, so the
-- join comes back empty and every foreign report reads as "?".
--
-- Rather than widening access to the organizations row — which carries settings, Stripe
-- account ids and billing state — this returns the NAME and nothing else, and only to a
-- platform admin. One field, one caller, one reason.
create or replace function public.platform_org_label(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_platform_admin()
      then (select name from public.organizations where id = p_org)
    else null
  end;
$$;

comment on function public.platform_org_label(uuid) is
  'The org NAME for a cross-tenant bug report, and nothing else. Returns null unless the caller is a platform admin. Exists so the beta inbox can attribute a report without opening the organizations row — 0176.';

grant execute on function public.platform_org_label(uuid) to authenticated;
