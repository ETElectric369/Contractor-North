-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0391: an estimate may be revised, and the revision supersedes it
--
-- Two accepted estimates on one job ADD UP everywhere that sums a job's accepted estimates: the
-- job's tasks and length (sync-job-tasks), its buy list (sync-job-materials), the contract total the
-- draws are percentages of (payment-schedule-math), the preliminary notice's figure, the won
-- tally. That is right for a CHANGE ORDER (phase 2 is also the deal) and wrong for a REVISION — a
-- corrected price for the same work — and nothing told them apart: the lock on a signed estimate
-- said "Duplicate it as a revision" while Duplicate made a plain copy that remembered nothing.
--
--   quotes.revises_quote_id   the estimate this one revises (the INTENT, set at the revision's birth
--                             by Revise on the original's page). Null for every estimate that is not
--                             a revision.
--   quote_status 'superseded' the FACT: when the revision is accepted, the original moves from sent or
--                             accepted to superseded (lib/estimate/revision supersedeRevised), so every
--                             reader of "accepted" sees ONE estimate for the work without learning a
--                             new rule. A superseded estimate keeps its lines and its history; it
--                             simply stops counting — the bills' precedent (0271 superseded_by_bill_id).
--
-- No backfill owed: production has no job with two accepted estimates today (read-only, 2026-10-11).
-- The new enum value is added and NOT used in this transaction (PostgreSQL's one rule for it); the
-- self-check reads the catalog by label. Idempotent: add value / column / index if not exists.
-- RLS unchanged (0004).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

alter type public.quote_status add value if not exists 'superseded';

alter table public.quotes
  add column if not exists revises_quote_id uuid references public.quotes(id) on delete set null;
comment on column public.quotes.revises_quote_id is
  'The estimate this one REVISES (set by Revise on the original''s page). When this estimate is accepted, '
  'the original moves to status superseded (lib/estimate/revision), so a job''s accepted estimates are '
  'one price for the work, never a revision and its original added together (0391).';

create index if not exists quotes_revises_idx
  on public.quotes (revises_quote_id)
  where revises_quote_id is not null;
comment on index public.quotes_revises_idx is
  'Finds the revision(s) of an estimate ("Superseded by Q-0043"); partial, since most estimates revise nothing (0391).';

-- Self-check: the column and the enum label exist (a catalog read, not a use of the new value).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'quotes' and column_name = 'revises_quote_id'
  ) then
    raise exception '0391: quotes.revises_quote_id is missing';
  end if;
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'quote_status' and e.enumlabel = 'superseded'
  ) then
    raise exception '0391: quote_status has no superseded value';
  end if;
end $$;
