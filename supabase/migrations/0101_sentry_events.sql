-- Ops sink for Sentry error alerts. Sentry POSTs each alerting issue to /api/inbound/sentry, which
-- upserts it here — so errors land in a queryable log the operator (and Claude, each session) can
-- triage and fix, instead of the owner getting paged by email. NOT tenant data: it's platform/ops,
-- so no org_id. RLS locked (no policies) → only the service-role webhook + a service-role reader touch it.
create table if not exists public.sentry_events (
  id           uuid primary key default gen_random_uuid(),
  issue_id     text,                                  -- Sentry's stable issue id (dedupe key)
  title        text,
  culprit      text,                                  -- the "where" (function/route)
  level        text,                                  -- error | warning | fatal | info
  project      text,
  permalink    text,                                  -- link to the Sentry issue
  event_count  integer not null default 1,            -- occurrences seen for this issue
  status       text not null default 'new',           -- new | triaged | fixed | ignored
  payload      jsonb,                                 -- the full webhook body, so nothing is lost
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
alter table public.sentry_events enable row level security;

-- Dedupe by issue: repeat occurrences bump the count + last_seen instead of piling up rows.
create unique index if not exists sentry_events_issue_uidx on public.sentry_events (issue_id) where issue_id is not null;
create index if not exists sentry_events_recent_idx on public.sentry_events (last_seen desc);
