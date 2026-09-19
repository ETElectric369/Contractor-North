-- FIFTY DOLLARS A WALL PLATE (Erik's price book, found 2026-09-19 loading the TTP 106 invoice).
--
-- CED does not price everything by the piece. Beside every price it prints a letter: E for each,
-- C for per hundred, M for per thousand. A one-gang decora plate is "50.00 C" - fifty cents, five
-- dollars a box of ten, not a fifty dollar wall plate. 93 of the 227 lines on his CED invoices are
-- priced per hundred or per thousand.
--
-- The receipt reader converts most of them. On five lines it did not, and those five went into the
-- price book at the undivided figure, because `learned_prices` read `unit_price` and nothing else:
--
--   1G BRN Decora plate (TP26)        $50.00      really  $0.50
--   2G Decora plate BRN (TP262)       $97.50      really  $0.98
--   1G BRZ IN-USE CVR                 $1,458.96   really  $14.59
--   FLEXBOX SINGLE GANG 16 CU IN      $436.42     really  $4.36
--   NMB 6/3 W/GND (1000ft REEL)       $4,321.03   really  $4.32 a foot
--
-- That book is what prices his estimates and what Nort answers from. A quote with ten weatherproof
-- covers in it would have carried $14,589.60 of cover.
--
-- CUSTOMER INVOICES WERE NEVER WRONG, and the reason says where the fix belongs. Every money path
-- in the app already reads the EXTENSION (`amount`) and treats `unit_price` as decoration:
-- billLineCost is `amount ?? unit_price * qty`, and billItemisation divides that cost by the
-- quantity to show a per-item figure. So the invoice billed $0.50 for the plate while the price
-- book said $50.00 - the same row, read two ways, and only one of them was ever checked against the
-- paper. The price book now reads the line the same way the invoice does.

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
           -- customer was billed from; `unit_price` is what somebody typed or a reader guessed. A
           -- zero or absent extension is not "this was free", it is "the extension is missing" -
           -- a back-ordered line carries a real price and a $0.00 extension - so that case falls
           -- back to the stated unit price exactly as before.
           case
             when bli.amount is not null and bli.amount <> 0 and coalesce(bli.quantity, 0) > 0
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
    -- The `unit_price > 0` filter moved down here so it tests the DERIVED price. Above, it was
    -- throwing away a line whose stated unit price was blank even when the extension knew exactly
    -- what the thing cost.
    select * from matched where unit_price > 0
  ),
  -- the most-recent purchase per normalized description (its price/date/supplier/label)
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
  'What the company actually paid, derived from bill line EXTENSIONS - the same reading billLineCost and the invoice itemisation use. Reading unit_price directly taught the book a per-hundred price as a per-piece price (0274).';

-- THE STORED LINES, CORRECTED WHERE THE PAPER PROVES THE DIVISOR.
--
-- This only touches a row where dividing by a hundred or a thousand lands EXACTLY on the supplier's
-- own extension, to the cent. That is not a guess about what a part should cost: it is the
-- arithmetic on the invoice saying which unit the price was quoted in. Every other row is left
-- alone, including the penny-rounding ones (a $0.66 foot of wire whose extension is $165.29 rather
-- than $165.00) and a back-ordered line whose extension is $0.00 with a real price beside it.
update public.bill_line_items li
   set unit_price = round(li.unit_price / 100.0, 4)
 where li.quantity > 0
   and li.amount is not null and li.amount <> 0
   and round(li.unit_price * li.quantity, 2) <> round(li.amount, 2)
   and round(li.unit_price / 100.0 * li.quantity, 2) = round(li.amount, 2);

update public.bill_line_items li
   set unit_price = round(li.unit_price / 1000.0, 4)
 where li.quantity > 0
   and li.amount is not null and li.amount <> 0
   and round(li.unit_price * li.quantity, 2) <> round(li.amount, 2)
   and round(li.unit_price / 1000.0 * li.quantity, 2) = round(li.amount, 2);

-- AND THE COLUMN THAT EXISTS TO SAY THIS OUT LOUD (0273). `per_unit` shipped last night and was
-- never filled: the loader that read the 47 portal PDFs computed a price and an extension and
-- dropped the letter between them, so the one column written to stop a per-thousand wire price
-- being read as a piece price was null on all 227 lines. The letter is recoverable, because only
-- one divisor can reproduce the extension the supplier printed.
update public.supplier_invoice_lines l
   set per_unit = case
     when round(l.quantity * l.unit_price / 1000.0, 2) = round(l.extension, 2) then 'M'
     when round(l.quantity * l.unit_price /  100.0, 2) = round(l.extension, 2) then 'C'
     else 'E'
   end
 where l.per_unit is null
   and l.quantity is not null and l.unit_price is not null and l.extension is not null
   -- A credit memo carries a negative quantity AND a negative price, which multiply back positive,
   -- so the test below is written on the absolute values in ced-invoice-parse.ts. Here the same
   -- signs appear on both sides of the equality, so it holds either way - but a zero quantity or a
   -- zero extension proves nothing and is left null rather than called 'E'.
   and l.quantity <> 0 and l.extension <> 0;
