-- Let the app log its OWN caught errors straight into sentry_events (no Sentry webhook to configure).
-- reportError() calls this with a stable key (hash of where+message) so repeats dedupe into a count.
-- SECURITY DEFINER + RLS-locked table → only this function's callers (the server-side reportError)
-- write; a service-role reader (Claude, each session) triages.
create or replace function public.record_app_error(
  p_key text, p_title text, p_where text, p_level text, p_payload jsonb
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.sentry_events (issue_id, title, culprit, level, payload, event_count, status)
  values (p_key, left(coalesce(p_title, p_where, 'error'), 500), p_where, coalesce(p_level, 'error'), p_payload, 1, 'new')
  on conflict (issue_id) where issue_id is not null
  do update set
    event_count = public.sentry_events.event_count + 1,
    last_seen   = now(),
    title       = excluded.title,
    culprit     = excluded.culprit,
    level       = excluded.level,
    payload     = excluded.payload,
    status      = 'new';  -- a fresh occurrence re-opens a previously-triaged error
$$;
