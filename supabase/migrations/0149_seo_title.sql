-- SEO wave 3 (2026-07-24): optional per-page/per-post SEO title override.
-- The <title> a search snippet shows doesn't have to match the on-page H1 — an SEO vendor
-- (the Jill workflow) tunes titles for keywords without touching the visible page. Blank =
-- today's behavior ("<title/h1> — <org name>"), so this ships inert.
alter table public.site_posts add column if not exists seo_title text;
alter table public.site_pages add column if not exists seo_title text;
