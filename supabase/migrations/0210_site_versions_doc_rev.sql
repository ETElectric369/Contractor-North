-- 0210: optimistic concurrency for draft-doc writes. The on-page editor autosaves patches;
-- two writers doing read-coerce-write can silently lose the earlier patch. doc_rev is the
-- CAS token: writers select it with the doc and update with .eq(doc_rev), bumping it by 1.
alter table public.site_versions add column if not exists doc_rev integer not null default 0;
