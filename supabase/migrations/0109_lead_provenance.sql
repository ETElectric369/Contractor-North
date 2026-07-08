-- Lead provenance: link the estimate / quote / job created from a lead back to that lead,
-- so you can trace "where did this job come from?" from the money doc, and (later) report the
-- conversion funnel (lead → estimate → job → invoice). Erik: "a new estimate can attach to a
-- new lead." Additive + nullable + ON DELETE SET NULL — deleting a lead never cascades to a
-- job/quote (the money doc is the source of truth once it exists; it just loses the backlink).

alter table jobs   add column if not exists inquiry_id uuid references inquiries(id) on delete set null;
alter table quotes add column if not exists inquiry_id uuid references inquiries(id) on delete set null;

-- Partial indexes: only linked rows are worth indexing (the vast majority have no source lead).
create index if not exists idx_jobs_inquiry_id   on jobs(inquiry_id)   where inquiry_id is not null;
create index if not exists idx_quotes_inquiry_id on quotes(inquiry_id) where inquiry_id is not null;

-- No RLS change needed: jobs/quotes are already org-scoped, and inquiries is org-scoped, so the
-- FK can only ever point within the same org's data. The embed reads ride the existing policies.
