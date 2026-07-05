-- The "learn from bills" price book, aggregated IN THE DATABASE so it's correct at any scale.
-- (The first cut aggregated a capped .limit(500) row fetch in JS with no ORDER BY — for an org with
-- >500 matching line items that silently averaged an arbitrary subset. This groups over ALL matching
-- rows.) SECURITY INVOKER so the caller's RLS on bill_line_items + bills applies — an org only ever
-- sees its own purchases, and the underlying policies already require org-staff.
create or replace function public.learned_prices(p_search text, p_limit int default 15)
returns table (
  item          text,
  last_price    numeric,
  avg_price     numeric,
  low_price     numeric,
  high_price    numeric,
  times_bought  bigint,
  last_date     date,
  last_supplier text
)
language sql
stable
security invoker
set search_path = public
as $$
  with matched as (
    select bli.description,
           bli.unit_price::numeric as unit_price,
           b.bill_date,
           b.supplier,
           lower(btrim(regexp_replace(bli.description, '\s+', ' ', 'g'))) as norm
    from public.bill_line_items bli
    join public.bills b on b.id = bli.bill_id
    where bli.unit_price > 0
      and bli.description ilike '%' || p_search || '%'
  ),
  -- the most-recent purchase per normalized description (its price/date/supplier/label)
  latest as (
    select distinct on (norm)
           norm, description, unit_price as last_price, bill_date as last_date, supplier as last_supplier
    from matched
    order by norm, bill_date desc nulls last
  ),
  agg as (
    select norm,
           round(avg(unit_price), 2) as avg_price,
           min(unit_price)           as low_price,
           max(unit_price)           as high_price,
           count(*)                  as times_bought,
           max(bill_date)            as max_date
    from matched
    group by norm
  )
  select l.description                as item,
         round(l.last_price, 2)       as last_price,
         a.avg_price, a.low_price, a.high_price, a.times_bought,
         l.last_date, l.last_supplier
  from latest l
  join agg a using (norm)
  order by a.max_date desc nulls last
  limit greatest(1, least(40, p_limit));
$$;
