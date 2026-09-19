-- A COUNTER PREVIEW IS NOT HIS PRICE, AND THE REAL INVOICE IS STILL COMING (Erik, 2026-09-18).
--
-- He bought at the CED branch near Sunnyvale on his Truckee account, and then explained what that
-- piece of paper actually is:
--
--   "my account gets priced by truckee thats why the final lines are blank so that is just a
--    preview of sunnyvale retail counter price not my prices which havent come back yet from the
--    truckee office but should land imminently"
--
-- So bill 'Contractors Electrical Distributors' ($467.87, Jason Waldow) is a QUOTE at another
-- branch's retail counter, not a bill at his contract pricing. Three things follow, and the app was
-- wrong about all three.
--
-- 1. THE PRICE BOOK IS LEARNING PRICES HE DOES NOT PAY. learned_prices (0100) reads bill_line_items
--    live and its own header calls them "their real net cost (their own supplier pricing)". Eight
--    electrical lines off that ticket are in there now at Sunnyvale retail - a 125A load centre at
--    $107.33, Square D breakers, Twister wire nuts - and every estimate built from that book
--    inherits them. This migration teaches the function to skip a provisionally priced bill. It is
--    a no-op until something is flagged, because nothing is flagged yet.
--
-- 2. THE REAL INVOICE WILL ARRIVE AS A SECOND BILL. Truckee prices the order and sends it, by
--    email, into the same import that already brought his CED statements in. Nothing links the two,
--    so the same purchase would be counted twice on the same job - exactly the shape of the one
--    duplicate already in his books ($95.27, filed to both 13631 Northwoods and 85 Whitney Place).
--    `superseded_by_bill_id` is how the real one takes over from the preview instead of joining it.
--    A superseded bill keeps its rows and its history; it simply stops counting.
--
-- 3. THE COST ON THAT JOB IS PROVISIONAL and nothing on any screen says so. The flag exists so a
--    card can say it out loud rather than presenting a retail preview as settled cost.
--
-- Nothing is flagged by this migration. Which bills are previews is Erik's knowledge - the paper
-- says so by leaving its final column blank, and no OCR of ours read that reliably enough to decide
-- for him.

alter table public.bills
  -- The prices on this document are a preview (another branch's counter, a quote, an estimate).
  -- Real enough to carry as job cost, not real enough to teach the price book or to settle.
  add column if not exists pricing_provisional boolean not null default false,
  -- The bill that replaced this one when the priced version arrived. Set = this row stops counting.
  add column if not exists superseded_by_bill_id uuid references public.bills(id) on delete set null;

comment on column public.bills.pricing_provisional is
  'true = the amounts here are a counter preview, not this account''s contract pricing. Still job cost; never a learned price; expects a priced invoice to supersede it.';

comment on column public.bills.superseded_by_bill_id is
  'The properly priced bill that replaced this preview. A superseded bill keeps its lines and its history and stops counting, so the same purchase is never counted twice.';

create index if not exists bills_superseded_idx
  on public.bills (org_id, superseded_by_bill_id)
  where superseded_by_bill_id is not null;

-- THE PRICE BOOK STOPS LEARNING FROM PREVIEWS AND FROM SUPERSEDED PAPER.
--
-- Rebuilt from 0100 with two clauses added to the `matched` CTE and NOTHING else changed: the same
-- return columns in the same order (Postgres refuses a changed return type, which is how a first
-- attempt at this caught itself), the same normalisation, the same ranking, the same limits. This
-- is a correctness patch, not a redesign of how he prices work.
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
      -- A COUNTER PREVIEW IS NOT A PRICE HE PAYS (0271). The Sunnyvale ticket printed asterisks
      -- where his Truckee contract price belongs, and the reader took the retail column beside
      -- them. Learning from that prices his estimates at a rate he is never charged.
      and b.pricing_provisional = false
      -- Once a preview has been replaced, only the replacement teaches anything. Otherwise the same
      -- purchase votes twice in the average: once at retail, once at his real price.
      and b.superseded_by_bill_id is null
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
