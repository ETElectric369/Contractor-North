-- 0208 — SITE VERSIONS: the design studio's memory (Erik: "GO GO", 2026-08-21).
--
-- The public site's marketing content lives as ~18 keys inside organizations.settings and every
-- writer mutates it IN PLACE — there is no history, no draft state for the homepage, and no way
-- to try a redesign without doing it live. This table gives the site the same shape the PDF
-- store gave documents: versions, never edits.
--
-- THE READ PATH DOES NOT MOVE. The renderer keeps reading organizations.settings exactly as
-- today; "publish" MATERIALIZES a version's doc onto those settings (one whitelisted merge, in
-- code) and stamps the row published. Rollback is publishing an older version. Neither live
-- site can break mid-rollout because nothing about serving changes — only where edits are
-- staged first.
--
-- `doc` holds ONLY the marketing subset (the SITE_DOC_KEYS list in src/lib/site-doc.ts — the
-- same family as update_site_content's whitelist). Org identity (name/phone/license — NAP must
-- match the Google Business Profile), routing identity (public_handle/custom_domain, protected
-- keys), and behavioral config (estimating_mode, thresholds) stay OUT and are read live.

create table if not exists site_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- Per-org sequence, assigned in the insert (max+1); unique below makes a race lose loudly.
  v integer not null,
  doc jsonb not null,
  status text not null default 'draft', -- draft | published | archived
  -- What this version IS, in a sentence — the designer pass writes its own summary here, a
  -- captured snapshot says where it came from. This is the version picker's label.
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (org_id, v)
);

-- Exactly one live version per org — publish flips the old one to archived in the same action.
create unique index if not exists site_versions_one_published
  on site_versions (org_id) where status = 'published';

create index if not exists site_versions_org_idx on site_versions (org_id, v desc);

alter table site_versions enable row level security;

create trigger site_versions_set_org before insert on site_versions
  for each row execute function public.set_org_id();

-- Staff manage their own org's versions. Preview reads go through the service client with an
-- internal resolveSiteContext gate (the draft-preview pattern), so no public policy exists —
-- deny-by-default outside the org. Site collaborators keep their existing whitelist RPC against
-- the LIVE settings for now; folding them into versions is a later, deliberate step.
create policy site_versions_select on site_versions
  for select using (org_id = public.auth_org_id());
create policy site_versions_write on site_versions
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

comment on table site_versions is
  'Versioned site-design documents (0208): the marketing-keys subset of org settings, staged as drafts and MATERIALIZED onto organizations.settings on publish. The renderer never reads this table.';
