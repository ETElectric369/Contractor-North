-- Articles / blog for the public org sites — the content layer of North's SEO story.
-- Posts are served on the org's own domain at their ORIGINAL paths (path includes the full
-- URL path minus the leading slash, e.g. Squarespace's "blog-1-1/redwood"), so a migrated
-- site's indexed URLs keep returning 200 with the same content instead of bleeding rankings.
-- New posts use "blog/<slug>". The SEO vendor (e.g. OCG) writes; North publishes.

create table if not exists site_posts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  path text not null check (path ~ '^[a-z0-9][a-z0-9/_-]*$' and path not like '%/'),
  title text not null,
  description text,
  cover_url text,
  body_html text not null default '',
  published boolean not null default true,
  published_at timestamptz not null default now(),
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, path)
);

create index if not exists idx_site_posts_org_pub on site_posts(org_id, published, published_at desc);

alter table site_posts enable row level security;

-- Stamp org_id from the caller's org on insert, like every other org table.
create trigger site_posts_set_org before insert on site_posts
  for each row execute function public.set_org_id();

-- Org staff manage their own org's posts. The PUBLIC site reads via the service client
-- (same pattern as getPublicOrgByHandle), so no anon/public read policy exists — RLS
-- stays deny-by-default for everyone outside the org.
create policy site_posts_select on site_posts
  for select using (org_id = public.auth_org_id());
create policy site_posts_write on site_posts
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
