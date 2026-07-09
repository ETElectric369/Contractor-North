-- Level-2 website customization: custom PAGES built from a curated palette of section BLOCKS.
-- A page is DATA — an ordered jsonb array of {type, props} blocks rendered by typed React
-- components (never freeform HTML), so an owner or a contracted designer can add pages, sections,
-- and buttons themselves with zero backend work and zero XSS surface. Same org-scoped access model
-- as site_posts: org staff + a granted external site collaborator.

create table site_pages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),  -- served at /p/<slug> on the org site
  title text not null,
  description text,                                            -- meta description
  blocks jsonb not null default '[]'::jsonb,                   -- ordered [{type, props}]
  published boolean not null default true,
  nav_label text,                                              -- non-null → shows in the site nav
  nav_order integer not null default 0,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, slug)
);
create index idx_site_pages_org_pub on site_pages(org_id, published, nav_order);

alter table site_pages enable row level security;
create trigger site_pages_set_org before insert on site_pages
  for each row execute function public.set_org_id();

-- Reads: any org member (harmless — same as site_posts; the public site reads via service client).
create policy site_pages_select on site_pages for select
  using (org_id = public.auth_org_id() or public.is_site_collaborator(org_id));
-- Writes: org staff OR a granted collaborator (mirror site_posts_write).
create policy site_pages_write on site_pages for all
  using ((org_id = public.auth_org_id() and public.is_org_staff()) or public.is_site_collaborator(org_id))
  with check ((org_id = public.auth_org_id() and public.is_org_staff()) or public.is_site_collaborator(org_id));
