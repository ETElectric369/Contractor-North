-- $0.00 IS AN ANSWER, NOT A BLANK (review of 0274, 2026-09-19).
--
-- 0274 taught the price book to read a bill line's EXTENSION instead of the unit price beside it,
-- because CED prices per hundred and per thousand and the typed column had a $50.00 wall plate and
-- a $1,458.96 weatherproof cover in it. It kept one escape hatch: when the extension was zero or
-- absent, it fell back to the very column it had just discredited.
--
-- A supply house prints exactly that shape. A BACK-ORDERED line carries the price of the part
-- beside an extension of $0.00, because nothing shipped. So the next CED invoice with a
-- back-ordered plate on it - "50.00" per hundred, nothing sent - would have taught the book a
-- fifty dollar wall plate all over again, worded identically to a correctly derived price, and
-- priced it into an estimate with the markup on top.
--
-- The rule is now whole: the extension says what the line cost, and a line that cost nothing
-- teaches nothing. The `unit_price > 0` filter already downstream drops it, so a back-ordered part
-- simply does not appear in "what I've paid" - which is the truth, because he has not paid for it.
-- The fallback survives only for a row with no quantity to divide by, which no stored bill line
-- has (both columns are NOT NULL).
--
-- The app-side reading moved with it in the same wave: billLineCost now treats an explicit $0.00
-- extension as zero cost rather than falling through to unit x qty, which is what was putting a
-- $312.50 row for never-shipped merchandise on a customer's invoice.

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
           -- THE ONE READING OF WHAT A THING COST, shared with billLineCost and the invoice
           -- arithmetic. The extension is the figure the supplier stands behind and the figure the
           -- customer was billed from; `unit_price` is what somebody typed or a reader guessed.
           case
             when bli.amount is not null and coalesce(bli.quantity, 0) > 0
               then (bli.amount / bli.quantity)::numeric
             else bli.unit_price::numeric
           end as unit_price,
           b.bill_date,
           b.supplier,
           lower(btrim(regexp_replace(bli.description, '\s+', ' ', 'g'))) as norm
    from public.bill_line_items bli
    join public.bills b on b.id = bli.bill_id
    where bli.description ilike '%' || p_search || '%'
      -- A COUNTER PREVIEW IS NOT A PRICE HE PAYS (0271). The Sunnyvale ticket printed asterisks
      -- where his Truckee contract price belongs, and the reader took the retail column beside
      -- them. Learning from that prices his estimates at a rate he is never charged.
      and b.pricing_provisional = false
      -- Once a preview has been replaced, only the replacement teaches anything. Otherwise the same
      -- purchase votes twice in the average: once at retail, once at his real price.
      and b.superseded_by_bill_id is null
  ),
  priced as (
    -- Tests the DERIVED price, so a line whose extension is zero - nothing shipped - teaches
    -- nothing, and a line whose typed unit price was blank still teaches what its extension says.
    select * from matched where unit_price > 0
  ),
  latest as (
    select distinct on (norm)
           norm, description, unit_price as last_price, bill_date as last_date, supplier as last_supplier
    from priced
    order by norm, bill_date desc nulls last
  ),
  agg as (
    select norm,
           round(avg(unit_price), 2) as avg_price,
           min(unit_price)           as low_price,
           max(unit_price)           as high_price,
           count(*)                  as times_bought,
           max(bill_date)            as max_date
    from priced
    group by norm
  )
  select l.description                as item,
         round(l.last_price, 2)       as last_price,
         round(a.avg_price, 2)        as avg_price,
         round(a.low_price, 2)        as low_price,
         round(a.high_price, 2)       as high_price,
         a.times_bought,
         l.last_date, l.last_supplier
  from latest l
  join agg a using (norm)
  order by a.max_date desc nulls last
  limit greatest(1, least(40, p_limit));
$$;

comment on function public.learned_prices(text, int) is
  'What the company actually paid, derived from bill line EXTENSIONS - the same reading billLineCost and the invoice itemisation use. Reading unit_price directly taught the book a per-hundred price as a per-piece price (0274); falling back to it on a $0.00 extension let a back-ordered line do the same (0275).';
