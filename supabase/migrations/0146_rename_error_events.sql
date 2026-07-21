-- Retire the Sentry-era name. The paid Sentry SaaS was removed long ago (no @sentry SDK, no DSN,
-- no perf tracing) — this table is the app's OWN internal error log, written by reportError() via
-- record_app_error(). The name `sentry_events` was a fossil that kept reading (even to the owner)
-- like a live external dependency. Rename the table + its indexes and rebuild the writer so nothing
-- says "sentry" anymore. Posture is unchanged: RLS on, zero policies → service-role only.
alter table if exists public.sentry_events rename to error_events;
alter index if exists sentry_events_issue_uidx rename to error_events_issue_uidx;
alter index if exists sentry_events_recent_idx rename to error_events_recent_idx;
-- The PK constraint (+ its backing index) keeps the old name after a table rename; rename it too so
-- no "sentry" fossil survives. Guarded so the whole file stays safe to re-run against any DB state.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'sentry_events_pkey') then
    alter table public.error_events rename constraint sentry_events_pkey to error_events_pkey;
  end if;
end $$;

-- record_app_error keeps its (already-fine) name but must insert into the renamed table. The
-- ON CONFLICT DO UPDATE qualifies the target by table name, so it has to be re-stated here — a
-- rename alone would leave the qualified `public.sentry_events.event_count` reference dangling.
create or replace function public.record_app_error(
  p_key text, p_title text, p_where text, p_level text, p_payload jsonb
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.error_events (issue_id, title, culprit, level, payload, event_count, status)
  values (p_key, left(coalesce(p_title, p_where, 'error'), 500), p_where, coalesce(p_level, 'error'), p_payload, 1, 'new')
  on conflict (issue_id) where issue_id is not null
  do update set
    event_count = public.error_events.event_count + 1,
    last_seen   = now(),
    title       = excluded.title,
    culprit     = excluded.culprit,
    level       = excluded.level,
    payload     = excluded.payload,
    status      = 'new';  -- a fresh occurrence re-opens a previously-triaged error
$$;
