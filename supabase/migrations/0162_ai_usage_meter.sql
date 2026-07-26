-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0162: the AI meter — know what each tenant costs before charging them.
--
-- THE PROBLEM. The pricing promise is "AI included, never metered." You cannot make
-- that promise without a meter BEHIND it (the customer never sees one; we do). Today
-- nothing aggregates spend per org, so on day one of paid customers the question
-- "is this customer profitable?" has no answer. And /api/chat has no rate limit at
-- all: a 12-round agentic loop on an Opus-class model with web search is roughly
-- $0.50-1.50 for ONE message, uncapped and unattributed.
--
-- Published data puts the top 5% of users at 50-70% of total inference spend, so the
-- median tells you nothing — the tail is the whole risk. A flat $59 tier survives a
-- typical user easily and is destroyed by one heavy one.
--
-- THE SHAPE. One row per org per day per model. Written on the service role from a
-- shared recorder after every Anthropic call; never written or read by the client
-- (there is no RLS policy granting tenants access on purpose — this is OUR cost
-- ledger, not a customer-facing usage meter).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.ai_usage (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  usage_date    date not null default (now() at time zone 'utc')::date,
  model         text not null,
  -- The four token classes are priced DIFFERENTLY (cache reads are ~10% of input,
  -- cache writes ~125%), so collapsing them into one number would misstate cost by
  -- an order of magnitude on a cached agentic loop.
  input_tokens        bigint not null default 0,
  cache_read_tokens   bigint not null default 0,
  cache_write_tokens  bigint not null default 0,
  output_tokens       bigint not null default 0,
  -- Computed at write time from the model's price, so a later price change doesn't
  -- silently rewrite history.
  cost_usd      numeric(12,6) not null default 0,
  calls         integer not null default 0,
  surface       text,  -- 'chat' | 'quote' | 'materials' | 'organize' | 'site-chat' | …
  updated_at    timestamptz not null default now(),
  unique (org_id, usage_date, model, surface)
);

create index if not exists ai_usage_org_date_idx on public.ai_usage (org_id, usage_date desc);

alter table public.ai_usage enable row level security;
-- Deliberately NO policies: service-role only. Tenants must not read or write our
-- cost ledger, and RLS-on with zero policies denies everyone else by default.

comment on table public.ai_usage is
  'Per-org, per-day, per-model AI cost ledger (0162). Service-role only — this is the '
  'platform''s COGS record, not a customer-facing usage meter. The product promise is '
  '"AI included, never metered"; this is how that promise stays affordable.';

/**
 * Add one call's usage to today's row. Upsert-on-conflict so concurrent calls from the
 * same org accumulate instead of racing — the whole point is that the tail user is the
 * one who generates many calls at once.
 */
create or replace function public.record_ai_usage(
  p_org_id       uuid,
  p_model        text,
  p_surface      text,
  p_input        bigint,
  p_cache_read   bigint,
  p_cache_write  bigint,
  p_output       bigint,
  p_cost_usd     numeric
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ai_usage as u
    (org_id, usage_date, model, surface, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, calls)
  values
    (p_org_id, (now() at time zone 'utc')::date, p_model, p_surface,
     greatest(p_input, 0), greatest(p_cache_read, 0), greatest(p_cache_write, 0), greatest(p_output, 0),
     greatest(p_cost_usd, 0), 1)
  on conflict (org_id, usage_date, model, surface) do update set
    input_tokens       = u.input_tokens       + greatest(p_input, 0),
    cache_read_tokens  = u.cache_read_tokens  + greatest(p_cache_read, 0),
    cache_write_tokens = u.cache_write_tokens + greatest(p_cache_write, 0),
    output_tokens      = u.output_tokens      + greatest(p_output, 0),
    cost_usd           = u.cost_usd           + greatest(p_cost_usd, 0),
    calls              = u.calls + 1,
    updated_at         = now();
$$;

comment on function public.record_ai_usage is
  'Accumulate one AI call into today''s per-org ledger row. Upsert so concurrent calls '
  'from one org add up rather than racing (0162).';

/** This org's AI spend in the last N days — the number a cap is checked against. */
create or replace function public.ai_spend_since(p_org_id uuid, p_days integer)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(cost_usd), 0)
    from public.ai_usage
   where org_id = p_org_id
     and usage_date >= ((now() at time zone 'utc')::date - greatest(p_days, 0));
$$;

grant execute on function public.record_ai_usage(uuid, text, text, bigint, bigint, bigint, bigint, numeric) to service_role;
grant execute on function public.ai_spend_since(uuid, integer) to service_role;
