-- Server-side rate limiting for PUBLIC / unauthenticated endpoints (Ask Nort chat, the inbound
-- lead webhook, the site contact form). A fixed-window counter keyed by an arbitrary string
-- (e.g. "chat:<ip>"), incremented ATOMICALLY so concurrent requests can't race past the cap —
-- unlike a per-serverless-instance in-memory map.

create table if not exists public.rate_limits (
  key           text primary key,
  window_start  timestamptz not null default now(),
  count         integer not null default 0
);

-- Locked down: no policies → only the service role / the SECURITY DEFINER function below touch it.
alter table public.rate_limits enable row level security;

-- Atomically record a hit and report whether the caller is OVER the limit for the current window.
-- Returns TRUE = limited (reject), FALSE = allowed. Resets the window once it has elapsed.
create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.rate_limits(key, window_start, count)
    values (p_key, now(), 1)
  on conflict (key) do update set
    window_start = case when public.rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                        then now() else public.rate_limits.window_start end,
    count = case when public.rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                 then 1 else public.rate_limits.count + 1 end
  returning count into v_count;
  return v_count > p_limit;
end;
$$;

-- Housekeeping: drop windows long past so the table stays small (call occasionally / from a cron).
create or replace function public.rate_limit_gc()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limits where window_start < now() - interval '1 day';
$$;
