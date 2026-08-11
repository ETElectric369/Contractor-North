-- 0190 — A DOCUMENT NUMBER THAT CANNOT WEDGE.
--
-- Erik, blocked mid-estimate: "i cant even make an estimate for some reason" — under the Save
-- button, in red: `duplicate key value violates unique constraint "quotes_org_number_key"`.
--
-- ── THE MECHANISM ───────────────────────────────────────────────────────────────────────────
--
-- next_doc_number bumps doc_counters.current and trusts it absolutely. ET Electric's quote
-- counter said 24, so the next estimate was E-025 — and E-025 already existed (created 8 Aug).
-- The insert violated quotes_org_number_key, the counter was rolled back with the transaction,
-- and the next attempt produced E-025 again.
--
-- THIS IS NOT A RACE. It is a permanent wedge: once the counter falls behind a number already on
-- the table, every future document of that type collides, forever, with no way out from inside
-- the app. Erik could not write ANY estimate.
--
-- The counter can fall behind several ways and it does not matter which one happened: a row
-- inserted with an explicit number (the trigger only fills a NULL), a restore or a copy between
-- environments, a counter edited by hand in Settings → Numbering, a row imported. Every one of
-- them is legitimate; the fragility is that the generator has no way to notice.
--
-- ── THE FIX: ASK THE TABLE ──────────────────────────────────────────────────────────────────
--
-- The counter stays the fast path. What is new is that the candidate is checked against the table
-- it will be written to, and the counter walks forward until it lands on a free one. So the first
-- insert after any drift REPAIRS the counter as a side effect and everything after it is exact.
--
-- The type→table mapping lives here rather than in each number_* trigger because there are seven
-- of them and one drifting copy of this rule is the whole problem restated. Identifiers come from
-- a fixed VALUES list, never from the caller, so the dynamic SQL cannot be injected. An unknown
-- p_type keeps the old behaviour rather than raising — a document type added tomorrow must not
-- fail its inserts because nobody updated this list.
--
-- Cost on the happy path: one EXISTS against a unique index, per document created. Nothing.

create or replace function public.next_doc_number(p_org uuid, p_type text, p_prefix text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n int;
  v_prefix text;
  v_tbl text;
  v_col text;
  cand text;
  taken boolean;
  guard int := 0;
begin
  select m.t, m.c into v_tbl, v_col
  from (values
    ('job',      'jobs',             'job_number'),
    ('quote',    'quotes',           'quote_number'),
    ('wo',       'work_orders',      'wo_number'),
    ('co',       'change_orders',    'co_number'),
    ('po',       'purchase_orders',  'po_number'),
    ('invoice',  'invoices',         'invoice_number'),
    ('contract', 'contracts',        'contract_number')
  ) as m(k, t, c)
  where m.k = p_type;

  select nullif(o.settings -> 'doc_prefixes' ->> p_type, '')
    into v_prefix
    from public.organizations o
   where o.id = p_org;
  v_prefix := coalesce(v_prefix, p_prefix);

  loop
    guard := guard + 1;

    insert into public.doc_counters (org_id, doc_type, current)
    values (p_org, p_type, 1)
    on conflict (org_id, doc_type)
    do update set current = public.doc_counters.current + 1
    returning current into n;

    cand := v_prefix || lpad(n::text, 3, '0');

    -- An unmapped type keeps the pre-0190 behaviour: take the counter's word for it.
    if v_tbl is null then
      return cand;
    end if;

    execute format('select exists (select 1 from public.%I where org_id = $1 and %I = $2)', v_tbl, v_col)
      into taken using p_org, cand;

    exit when not taken;

    -- A guard, not a policy. Reaching it means something is very wrong (a counter reset to 1
    -- against thousands of rows); erroring loudly beats spinning.
    if guard > 5000 then
      raise exception 'next_doc_number: could not find a free % number for org % after % tries', p_type, p_org, guard;
    end if;
  end loop;

  return cand;
end
$function$;

comment on function public.next_doc_number(uuid, text, text) is
  'Per-org document numbering. The counter is the fast path; the candidate is verified against the target table and the counter walks forward past anything already taken, so a counter that has fallen behind repairs itself on the next insert instead of wedging every future document (0190).';
