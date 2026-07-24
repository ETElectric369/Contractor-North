-- SEO wave (Tahoe Deck audit 2026-07-24): renaming a builder page's slug or an article's
-- path used to ORPHAN the old URL — it fell through to the 307-home soft-404 and dumped any
-- accumulated search equity on the floor. Squarespace ships a URL-mappings manager; this is
-- ours, kept automatic: saveSitePage/saveSitePost record old→new here on every rename, and
-- the four public-site resolvers consult it before their miss fallback, issuing a real 301.
--
-- RLS on, ZERO policies → service-role only (the same posture as error_events): public reads
-- happen through the service client in lib/site-redirects.ts (org resolved upstream by
-- host/handle, never caller input), and writes happen inside the already-authenticated
-- save actions. Paths are stored as the PUBLIC path with a leading slash ("/about",
-- "/blog-1-1/redwood").
create table if not exists public.site_redirects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  from_path   text not null,
  to_path     text not null,
  created_at  timestamptz not null default now()
);
alter table public.site_redirects enable row level security;

-- One live redirect per source path per org; a re-rename overwrites (upsert on this key).
create unique index if not exists site_redirects_org_from_uidx
  on public.site_redirects (org_id, from_path);
