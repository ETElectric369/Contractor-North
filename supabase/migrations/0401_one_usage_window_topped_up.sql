-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0401: one usage window, topped up
--
-- A company's AI is ONE meter now (cn-v1140, Erik's design 2026-10-30: "look at how Anthropic pulls
-- tokens; usage is understandable to anyone"): the model spend this calendar month, which the ledger
-- ai_usage (0162) already records for every surface, against the plan's monthly usage budget
-- (lib/plans usageUsdPerMonth). A ring with a percent in it and "Resets Nov 1" under it; nothing to
-- explain. Dollars are never shown, and "estimates" is no longer a unit anywhere — the estimate
-- allowance of cn-v1128 (fullEstimatesPerMonth, the 'estimator:run' ticks) goes with this wave.
-- Past 100% nothing stops: Nort and the estimator run on the lighter model until the month turns,
-- and a company that wants its full model back before then buys extra usage through Stripe
-- Checkout. That purchase needs a home, and the month's spend needs a calendar read. This
-- migration gives both.
--
-- WHAT CHANGES:
--
--   1. public.usage_topups: one row per purchase of extra usage — the company, the month it is
--      for (YYYY-MM, the company's own calendar month), the usage it adds (internal dollars, the
--      same unit as ai_usage.cost_usd and the plan budgets), and the Stripe Checkout session that
--      paid for it, UNIQUE, so a webhook delivered twice lands once. RLS on with ONE deliberate
--      deny-all policy (0163's shape for ai_usage): this is North's meter, written only by the
--      webhook on the service role, never read or written from a client — the ring reads the
--      total through the RPC below, and a tenant never sees a dollar.
--
--   2. add_usage_topup(p_org, p_month, p_usd, p_session) → jsonb {id, inserted}: the webhook's one
--      write. Idempotent on the session (ON CONFLICT DO NOTHING; the second delivery answers
--      inserted=false with the row's id). A blank session, a month that is not YYYY-MM, usage that
--      adds nothing (≤ 0) and a company that is not there are refused in words.
--
--   3. usage_topup_total(p_org, p_month) → numeric: what the company bought for one month, summed
--      (0 when nothing). The ring's cap is the plan's budget plus this.
--
--   4. ai_spend_from(p_org_id, p_from) → numeric: the ledger summed from a date — the CALENDAR
--      MONTH read the ring needs (ai_spend_since, 0162, stays the rolling-30-day read the abuse
--      belt MONTHLY_AI_CEILING_USD keeps). The caller passes the 1st of the company's month;
--      ai_usage.usage_date is the UTC date of each call, so a call in the last few hours of a
--      Pacific month lands on the next month's first UTC day — a few hours a month, said in
--      lib/usage-meter, never corrected by hand.
--
--   All three are SECURITY DEFINER with search_path pinned, REVOKED from public, anon and
--   authenticated and granted to the service role alone (0182's law: a grant to service_role is
--   not a restriction; the revoke is).
--
-- LOCKS: CREATE TABLE and CREATE INDEX on a new, empty table (nothing waits); ENABLE ROW LEVEL
-- SECURITY and CREATE POLICY on it (the same). lock_timeout 3s: a busy catalog fails fast and
-- changes nothing; run it again. Twice-safe: the table and the index are IF NOT EXISTS, the policy
-- is dropped and re-created to the same text, the functions are CREATE OR REPLACE, the grants are
-- idempotent.
--
-- ORDER: after 0004 (organizations), 0162 (ai_usage) and 0182 (the revoke law). Apply BEFORE the
-- cn-v1140 deploy: lib/usage-meter calls ai_spend_from and usage_topup_total from the first ring,
-- and a missing function would read as a failed read — a "fine" ring at 0%, filed, never a lock-out.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.organizations') is null then
    raise exception '0401: organizations is not on this database. Nothing was changed.';
  end if;
  if to_regclass('public.ai_usage') is null then
    raise exception '0401: ai_usage (0162) is not on this database. Apply 0162 first. Nothing was changed.';
  end if;
  if to_regprocedure('public.ai_spend_since(uuid, integer)') is null then
    raise exception '0401: ai_spend_since (0162) is missing; the ledger this reads is not whole. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_usage' and column_name = 'cost_usd')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_usage' and column_name = 'usage_date') then
    raise exception '0401: ai_usage.cost_usd or ai_usage.usage_date (0162) is missing. Nothing was changed.';
  end if;
end $$;

-- ── 1. the purchases: one row per top-up, service role only ─────────────────────────────────────
create table if not exists public.usage_topups (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- The company's own calendar month this adds to, as the ring keys it (lib/usage-window monthKey).
  month              text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  -- Internal dollars, the ledger's unit (ai_usage.cost_usd); never shown to a tenant.
  usage_usd          numeric(12,6) not null check (usage_usd > 0),
  -- The Stripe Checkout session that paid: unique, so a webhook delivered twice lands once.
  stripe_session_id  text not null unique,
  created_at         timestamptz not null default now()
);

create index if not exists usage_topups_org_month_idx on public.usage_topups (org_id, month);

alter table public.usage_topups enable row level security;

-- Deliberate deny-all, stated (0163's lesson: an empty policy list is indistinguishable from a
-- forgotten one, and the RLS invariant in CI requires every org-scoped table to carry a policy).
drop policy if exists usage_topups_deny_all on public.usage_topups;
create policy usage_topups_deny_all on public.usage_topups
  for all
  using (false)
  with check (false);

comment on table public.usage_topups is
  'Extra usage a company bought for one month (0401): the month (YYYY-MM), the usage added in internal dollars (ai_usage''s unit), and the Stripe Checkout session that paid, unique. Service role only — written by the webhook through add_usage_topup, read by the ring through usage_topup_total; a tenant never sees a dollar.';
comment on policy usage_topups_deny_all on public.usage_topups is
  'Deliberate deny-all (0401, in 0163''s shape). This is North''s meter, not a company''s record: no tenant reads what extra usage cost, and nobody writes it from a client. Only the service role (which bypasses RLS) touches this table.';

-- ── 2. the webhook's one write: idempotent on the session ───────────────────────────────────────
create or replace function public.add_usage_topup(p_org uuid, p_month text, p_usd numeric, p_session text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_session is null or btrim(p_session) = '' then
    raise exception 'A usage top-up needs its checkout session.' using errcode = '22023';
  end if;
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'A usage top-up needs its month as YYYY-MM.' using errcode = '22023';
  end if;
  if p_usd is null or p_usd <= 0 then
    raise exception 'A usage top-up must add something.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'No such company for a usage top-up.' using errcode = '22023';
  end if;
  -- Land once per session: the second delivery of the same checkout finds the row and says so.
  insert into public.usage_topups (org_id, month, usage_usd, stripe_session_id)
  values (p_org, p_month, p_usd, btrim(p_session))
  on conflict (stripe_session_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'inserted', true);
  end if;
  select t.id into v_id from public.usage_topups t where t.stripe_session_id = btrim(p_session);
  return jsonb_build_object('id', v_id, 'inserted', false);
end $$;
comment on function public.add_usage_topup(uuid, text, numeric, text) is
  'The webhook''s one write of extra usage (0401): inserts a top-up for the company and month, once per Stripe Checkout session (the second delivery answers inserted=false with the row''s id). A blank session, a month that is not YYYY-MM, usage ≤ 0 and an unknown company are refused in words. Service role only.';
revoke execute on function public.add_usage_topup(uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.add_usage_topup(uuid, text, numeric, text) to service_role;

-- ── 3. what the company bought for one month ────────────────────────────────────────────────────
create or replace function public.usage_topup_total(p_org uuid, p_month text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(t.usage_usd), 0)
    from public.usage_topups t
   where t.org_id = p_org
     and t.month = p_month;
$$;
comment on function public.usage_topup_total(uuid, text) is
  'The extra usage a company bought for one month, summed (0401); 0 when none. The ring''s cap is the plan''s budget plus this. Service role only.';
revoke execute on function public.usage_topup_total(uuid, text) from public, anon, authenticated;
grant execute on function public.usage_topup_total(uuid, text) to service_role;

-- ── 4. the ledger from a date: the calendar-month read ──────────────────────────────────────────
create or replace function public.ai_spend_from(p_org_id uuid, p_from date)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(u.cost_usd), 0)
    from public.ai_usage u
   where u.org_id = p_org_id
     and u.usage_date >= p_from;
$$;
comment on function public.ai_spend_from(uuid, date) is
  'A company''s AI spend from a date (0401): the ledger (ai_usage, 0162) summed where usage_date >= p_from — the ring''s calendar-month read. ai_spend_since stays the rolling read the abuse ceiling keeps. Service role only.';
revoke execute on function public.ai_spend_from(uuid, date) from public, anon, authenticated;
grant execute on function public.ai_spend_from(uuid, date) to service_role;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_fn  text;
  v_col text;
  v_n   integer;
begin
  if to_regclass('public.usage_topups') is null then
    raise exception '0401: usage_topups is missing. Nothing was changed.';
  end if;
  foreach v_col in array array['id', 'org_id', 'month', 'usage_usd', 'stripe_session_id', 'created_at'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'usage_topups' and column_name = v_col) then
      raise exception '0401: usage_topups.% is missing. Nothing was changed.', v_col;
    end if;
  end loop;
  -- The two checks (the month's shape, usage above zero) and the one unique (the session).
  select count(*) into v_n from pg_constraint where conrelid = 'public.usage_topups'::regclass and contype = 'c';
  if v_n < 2 then
    raise exception '0401: usage_topups does not carry both check constraints (the month''s shape, usage > 0). Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.usage_topups'::regclass and c.contype = 'u'
       and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['stripe_session_id']
  ) then
    raise exception '0401: stripe_session_id is not unique on usage_topups, so a webhook delivered twice would land twice. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.usage_topups'::regclass and contype = 'f' and confrelid = 'public.organizations'::regclass) then
    raise exception '0401: usage_topups.org_id does not reference organizations. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'usage_topups' and indexname = 'usage_topups_org_month_idx') then
    raise exception '0401: the (org_id, month) index is missing from usage_topups. Nothing was changed.';
  end if;
  -- RLS on, with exactly the one deny-all policy and no other.
  if not (select relrowsecurity from pg_class where oid = 'public.usage_topups'::regclass) then
    raise exception '0401: row level security is off on usage_topups. Nothing was changed.';
  end if;
  select count(*) into v_n from pg_policies where schemaname = 'public' and tablename = 'usage_topups';
  if v_n <> 1 or not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'usage_topups' and policyname = 'usage_topups_deny_all' and qual = 'false' and with_check = 'false'
  ) then
    raise exception '0401: usage_topups must carry exactly its deny-all policy and no other. Nothing was changed.';
  end if;
  -- The three functions: there, security definer, search_path pinned, service role only.
  foreach v_fn in array array['public.add_usage_topup(uuid, text, numeric, text)', 'public.usage_topup_total(uuid, text)', 'public.ai_spend_from(uuid, date)'] loop
    if to_regprocedure(v_fn) is null then
      raise exception '0401: % is missing. Nothing was changed.', v_fn;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = v_fn::regprocedure and p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']) then
      raise exception '0401: % is not security definer with its search_path pinned. Nothing was changed.', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception '0401: anon can call %. Nothing was changed.', v_fn;
    end if;
    if has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception '0401: a signed-in person can call % (service role only). Nothing was changed.', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '0401: the service role cannot call %; the ring and the webhook would be locked out. Nothing was changed.', v_fn;
    end if;
  end loop;
  -- The write's body on the database, not only the file: once per session, the refusals in words.
  if position('on conflict (stripe_session_id) do nothing' in pg_get_functiondef('public.add_usage_topup(uuid, text, numeric, text)'::regprocedure)) = 0
     or position('A usage top-up needs its checkout session.' in pg_get_functiondef('public.add_usage_topup(uuid, text, numeric, text)'::regprocedure)) = 0 then
    raise exception '0401: add_usage_topup does not land once per session or does not refuse a blank session in words. Nothing was changed.';
  end if;
  -- The ledger's rolling read (0162) is untouched beside the calendar one.
  if to_regprocedure('public.ai_spend_since(uuid, integer)') is null then
    raise exception '0401: ai_spend_since (0162) went missing; the abuse ceiling would fail open for good. Nothing was changed.';
  end if;
  raise notice '0401: one usage window, topped up — extra usage has a table the service role alone touches, the webhook lands a top-up once per session, the ring reads the month''s spend and what was bought, and the 30-day ceiling stays as it was.';
end $$;
