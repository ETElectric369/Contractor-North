-- EXTERNAL site/content collaborators — an outside SEO/content pro (e.g. an agency like OCG)
-- granted access to ONE thing: a contractor's public-site ARTICLES (site_posts). Never the
-- operational app.
--
-- SECURITY MODEL — deny-by-default by construction, not by patching:
-- A collaborator is NOT an org member. Their profile keeps org_id = NULL, so auth_org_id() is
-- null and EVERY org-scoped table (whose read policy is "org_id = auth_org_id()") denies them
-- automatically — customers, jobs, the team roster with pay rates, files, everything. This grants
-- table is the ONLY thing that opens a door, and it opens exactly one: site_posts for the granted
-- org. A future table added with the usual org-scoped policy can never re-leak to a collaborator,
-- because there is nothing about them that satisfies "org_id = auth_org_id()".

create table site_collaborators (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,   -- null until they sign up & claim
  invited_email text not null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);
create unique index uq_site_collab_org_email on site_collaborators(org_id, lower(invited_email));
create unique index uq_site_collab_org_user on site_collaborators(org_id, user_id) where user_id is not null;
create index idx_site_collab_user on site_collaborators(user_id) where user_id is not null;

-- Does the CURRENT user hold a claimed content grant for target_org? (definer: only ever checks
-- the caller's own grants.)
create or replace function public.is_site_collaborator(target_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.site_collaborators
    where user_id = auth.uid() and org_id = target_org
  );
$$;

-- On sign-up, a collaborator claims any grants sent to THEIR verified email. Definer so it can
-- read auth.users + bypass the staff-only write policy, but it only ever matches the caller's own
-- email, so a user can only ever claim grants that were addressed to them.
create or replace function public.claim_site_collaborations()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.site_collaborators sc
     set user_id = auth.uid(), claimed_at = now()
   where sc.user_id is null
     and lower(sc.invited_email) = lower((select email from auth.users where id = auth.uid()));
  get diagnostics n = row_count;
  return n;
end $$;

alter table site_collaborators enable row level security;
-- Org staff manage grants for their OWN org (invite / list / revoke).
create policy site_collab_staff on site_collaborators for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
-- A collaborator may read their OWN grants (to discover which org they edit). Read-only.
create policy site_collab_self on site_collaborators for select
  using (user_id = auth.uid());

-- Widen site_posts to admit a granted collaborator IN ADDITION to org staff. Everything else about
-- site_posts (path constraints, the public service-client reads) is unchanged.
drop policy if exists site_posts_select on site_posts;
create policy site_posts_select on site_posts for select
  using (org_id = public.auth_org_id() or public.is_site_collaborator(org_id));

drop policy if exists site_posts_write on site_posts;
create policy site_posts_write on site_posts for all
  using ((org_id = public.auth_org_id() and public.is_org_staff()) or public.is_site_collaborator(org_id))
  with check ((org_id = public.auth_org_id() and public.is_org_staff()) or public.is_site_collaborator(org_id));
