-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0416: one sale, one deposit (cn-v1178)
--
-- WHY. The read-only audit of the path from a lead to a paid invoice (2026-11-22) found the database
-- half of four things:
--   B1  a deposit belonged to ONE estimate's id. A revision (quotes.revises_quote_id, 0391) of an
--       estimate whose deposit was requested or paid stated the deposit again: the customer's link
--       offered it, a tap made a SECOND request on the job and charged it. 0414's unique index is one
--       live request per ESTIMATE and could not see the revision as the same sale.
--   B3  the link named the request's ASK, and the card door charges what is LEFT (its total less what
--       was paid on it) plus the company's card fee, which the link never knew.
--   C1  the customer's own Accept made a job billing by the company's usual kind (0413's (d)), so a
--       Quote whose paper says "This is a fixed price" could be born time and material, and its first
--       invoice billed hours instead of the price the paper promised.
--   D1  Done, Not Billed (needs_you_done_not_billed, 0403) read a payment request as a bill for the
--       work: a finished job whose only bill was a deposit never asked to be billed.
-- The owner's decision: ONE SALE, ONE DEPOSIT. A sale is an estimate and its revision family; Keep
-- Both clears the pointer, so estimates kept as separate work are separate sales.
--
-- WHAT, six things and nothing else:
--
--  1. public.quote_family_ids(uuid): the sale's estimates, the one rule (src/lib/sale-quotes.ts asks
--     it). Up from the estimate along revises_quote_id to the first of the line, at most 12 hops, in
--     the estimate's own company; then down from that first one through everything that revises any
--     of them, at most 12 levels, in the same company; distinct; the estimate itself always. A cycle
--     cannot loop: the hops are bounded. SECURITY INVOKER: a signed-in person is answered only from
--     the estimates row security shows them; inside the two definer functions below it runs as their
--     owner. Execute for authenticated and service_role, never anon. quotes_revises_idx (0391) finds
--     the revisions.
--  2. THE BOUNDARY, trigger invoices_one_deposit_per_sale on public.invoices, BEFORE INSERT OR UPDATE
--     OF quote_id, status, invoice_kind, for a row that is (after the write) a live deposit request
--     naming an estimate. It ACTS ONLY when the row BECOMES one or changes estimate: an insert, or an
--     update from void, or to another estimate, or from another kind. Any other update is let through
--     untouched: a payment landing on a request (sent to partial to paid) is never refused here, even
--     in a family that held two live requests before this file. When it acts it locks the family's
--     estimate rows in id order, then refuses when another live request of the company names ANOTHER
--     estimate of the family: "This sale already has a deposit request: INV-900. Use that one.
--     Nothing was made." The same estimate is left to 0414's unique index, which stays, so a second
--     tap on one estimate is still the 23505 the app reads as the lost race.
--  3. public.public_quote(text): 0414's body (the last migration that made it) with ONLY its deposit
--     block changed: every read there looks at the estimate's family; two keys are added,
--     deposit_due (what is left on the family's live request that is not paid, the oldest first; null
--     when there is none) and card_fee_percent (the company's, by the expression public_invoice reads,
--     0301); the block's comment says so. deposit_amount keeps its meaning (the request's ask, else
--     the stored figure) and deposit_state its five answers.
--  4. public.accept_public_quote(text): 0413's body with ONE expression changed. The new job's
--     billing_type is the paper's word, case when q.doc_type = 'quote' then 'fixed' else 'tm' end, the
--     SQL twin of billingKindOfDocType (src/lib/appointments/won-sheet.ts), in place of
--     public.usual_billing_type(q.org_id), and its comment. THE COLUMN: jobs.billing_type is text, not
--     null, under the check jobs_billing_type_check ('fixed', 'tm') (0063); the case yields text and
--     one of those two words, so no cast is needed (the ground check reads both facts first).
--     public.usual_billing_type stays: 0379's trigger and the app still read it.
--  5. public.needs_you_done_not_billed(timestamptz, timestamptz, integer): 0403's body with a payment
--     request left out of the SIX reads that ask "is there a bill for this work": the visit's anchored
--     unpaid bill (open_invoice_id), the visit's anchored paid bill (settled), the visit's job's real
--     billing, a real bill naming one of the visit's job's estimates, the finished job's real billing,
--     and a real bill naming one of the finished job's estimates. Its attributes as they were:
--     SECURITY INVOKER, stable, search path, execute for authenticated alone.
--  6. A self-check of all of it.
--
-- L1, THE OLDER RULES ON invoices READ AGAINST "A SECOND REQUEST IN ONE SALE": 0414's unique index
-- (one live request per estimate: blind to a revision; kept, it answers the same estimate); 0414's
-- prepayment_hold, guard_prepaid_credit_line, guard_prepayment_bill and guard_prepayment_delete (each
-- holds ONE request's own pool, its kind, its job and its delete: two requests in one sale were two
-- pools a bill took off one after the other, which is the double deposit this closes); 0415's
-- guard_invoice_unvoid (a request's line is money ahead and carries no claim, so a voided request came
-- back beside a sibling's live one with no refusal: this file's boundary now refuses it); 0343's
-- and 0361's un-void guards (pieces and people: a request's line names neither); 0405's sent-figure
-- stamp, 0349's draw-paper unstamp, 0226's money delete guard, 0228's customer promotion, 0004's
-- numbering and 0003's touch (none reads a request's estimate).
--
-- THE READERS, named the day the function is added: quote_family_ids is asked by src/lib/sale-quotes.ts
-- (saleQuoteIds, and through it liveRequestForQuote in src/lib/payment-request.ts), by public_quote
-- and by the boundary here. tests/migration-0416.test.ts reads this file;
-- src/lib/one-sale-one-deposit.integration.test.ts and src/lib/done-not-billed.integration.test.ts ask
-- the database.
--
-- ORDER. AFTER 0414 (it refuses without it) and BEFORE the deploy. Applied first, the app that is
-- running reads two more keys nobody reads yet, a revision's link stops offering a deposit its sale
-- already has, and a second request in one sale is refused in words.
--
-- LOCKS. create or replace trigger takes SHARE ROW EXCLUSIVE on invoices for a moment (writes wait for
-- the commit, reads never do); never drop trigger, which is ACCESS EXCLUSIVE. Four functions are
-- replaced or made (catalog rows only). lock_timeout 3s, statement_timeout 15s, the house's. ONE
-- TRANSACTION: the runners wrap the file, and the self-check leans on that (what the ground check
-- notes is read back at the end). TWICE-SAFE: the ground check takes each re-made function as its last
-- migration left it OR as this file leaves it, so a second run writes the same text again and passes;
-- any other body is a newer migration's, and this file refuses rather than put its text back over it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ── The ground it stands on ─────────────────────────────────────────────────────────────────────
do $$
declare
  r     record;
  v_src text;
  v_md5 text;
  v_def text;
begin
  for r in select t.tbl from (values ('invoices'), ('quotes'), ('jobs'), ('organizations'), ('appointments')) as t(tbl) loop
    if to_regclass('public.' || r.tbl) is null then
      raise exception '0416: public.% is not on this database. Nothing was changed.', r.tbl;
    end if;
  end loop;
  if (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception '0416: the roles anon, authenticated and service_role are not all on this database. Nothing was changed.';
  end if;

  -- EVERY COLUMN THE FAMILY, THE BOUNDARY, THE LINK AND THE JOB READ, with the migration that added it.
  for r in
    select * from (values
      ('quotes',        'org_id',           'uuid',    '0004'),
      ('quotes',        'doc_type',         'text',    '0047'),
      ('quotes',        'revises_quote_id', 'uuid',    '0391'),
      ('invoices',      'invoice_number',   'text',    '0003'),
      ('invoices',      'quote_id',         'uuid',    '0003'),
      ('invoices',      'total',            'numeric', '0003'),
      ('invoices',      'amount_paid',      'numeric', '0003'),
      ('invoices',      'created_at',       'timestamp with time zone', '0003'),
      ('invoices',      'org_id',           'uuid',    '0004'),
      ('invoices',      'invoice_kind',     'text',    '0063'),
      ('jobs',          'billing_type',     'text',    '0063'),
      ('organizations', 'settings',         'jsonb',   'an early migration')
    ) as t(tbl, col, kind, born)
  loop
    if not exists (
      select 1 from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col and c.data_type = r.kind
    ) then
      raise exception '0416: %.% (%, added by %) is missing. Nothing was changed.', r.tbl, r.col, r.kind, r.born;
    end if;
  end loop;
  if to_regclass('public.quotes_revises_idx') is null then
    raise exception '0416: the index quotes_revises_idx (0391) is not on this database: the family reads revisions by it. Nothing was changed.';
  end if;

  -- 0414 IS HERE: the kind, and its one live deposit request per estimate, which this file keeps.
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.invoices'::regclass and c.conname = 'invoices_invoice_kind_check'
       and pg_get_constraintdef(c.oid) like '%''prepayment''%'
  ) or to_regclass('public.invoices_one_live_deposit_request_per_estimate') is null then
    raise exception '0416: invoices_invoice_kind_check does not take ''prepayment'', or the index invoices_one_live_deposit_request_per_estimate is missing. Apply 0414 first. Nothing was changed.';
  end if;

  -- THE JOB'S COLUMN TAKES THE PAPER'S WORD AS TEXT: text, not null, one check, 'fixed' or 'tm' (0063).
  select pg_get_constraintdef(k.oid) into v_def from pg_constraint k
   where k.conrelid = 'public.jobs'::regclass and k.conname = 'jobs_billing_type_check';
  if v_def is null or position('''fixed''' in v_def) = 0 or position('''tm''' in v_def) = 0 then
    raise exception '0416: jobs.billing_type is not under the check jobs_billing_type_check (''fixed'', ''tm'') 0063 made (found %). Nothing was changed.', coalesce(v_def, 'none');
  end if;
  if not exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'jobs' and c.column_name = 'billing_type' and c.is_nullable = 'NO'
  ) then
    raise exception '0416: jobs.billing_type is nullable. Nothing was changed.';
  end if;

  -- THE NAMES THIS FILE TAKES: free, or this file's own (a second run).
  if to_regprocedure('public.quote_family_ids(uuid)') is not null then
    select p.prosrc into v_src from pg_proc p where p.oid = 'public.quote_family_ids(uuid)'::regprocedure;
    if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '') <> 'bbefad8de47aae8c9f11d826631d5a9d' then
      raise exception '0416: public.quote_family_ids(uuid) is on this database and is not this file''s. Read it before this runs. Nothing was changed.';
    end if;
  end if;
  if to_regprocedure('public.guard_one_deposit_per_sale()') is not null then
    select p.prosrc into v_src from pg_proc p where p.oid = 'public.guard_one_deposit_per_sale()'::regprocedure;
    if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '') <> '15de6d0f81fd1e038fd7b7886e9025c1' then
      raise exception '0416: public.guard_one_deposit_per_sale() is on this database and is not this file''s. Read it before this runs. Nothing was changed.';
    end if;
  end if;
  if exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.invoices'::regclass and t.tgname = 'invoices_one_deposit_per_sale' and not t.tgisinternal
       and t.tgfoid is distinct from to_regprocedure('public.guard_one_deposit_per_sale()')
  ) then
    raise exception '0416: a trigger invoices_one_deposit_per_sale on public.invoices runs another function. Nothing was changed.';
  end if;

  -- THE THREE FUNCTIONS THIS FILE RE-MAKES ARE THE ONES IT WAS WRITTEN FROM: each one's statements,
  -- with comments and spacing taken out, are its last migration's (WAS, read on production
  -- 2026-11-22) or this file's own (NOW). Anything else is refused and never overwritten.
  -- tests/migration-0416.test.ts recomputes all six from the files.
  for r in
    select * from (values
      ('public.public_quote(text)', '0414', 'd0874c32f52cdcb1ec997dc8ef7f637a', '6227a13074f5a8c37ca69bf2f125f0ce'),
      ('public.accept_public_quote(text)', '0413', '12278c3bde6fe0e7ab556cfa50a85634', '1f597e394b2c55165ffbfe6fe1a67f65'),
      ('public.needs_you_done_not_billed(timestamptz, timestamptz, integer)', '0403', '05abffcd3144db2c61ef84367b5609c2', '347b72f0e3582846f0ff228e4c4ea4ec')
    ) as t(fn, born, was, now)
  loop
    if to_regprocedure(r.fn) is null then
      raise exception '0416: % is not on this database (last made by %). Nothing was changed.', r.fn, r.born;
    end if;
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure(r.fn);
    v_md5 := coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '');
    if v_md5 not in (r.was, r.now) then
      raise exception '0416: % is neither the body % left nor this file''s (its statements read %). A newer migration re-made it, or it was changed by hand, and this file would put older text back over it. Read it (select pg_get_functiondef(''%''::regprocedure)) first. Nothing was changed.', r.fn, r.born, v_md5, r.fn;
    end if;
  end loop;
  if not has_function_privilege('anon', 'public.public_quote(text)', 'execute')
     or not has_function_privilege('anon', 'public.accept_public_quote(text)', 'execute') then
    raise exception '0416: the customer''s link cannot call public_quote or accept_public_quote on this database. Nothing was changed.';
  end if;

  -- Who owns each re-made function and who may call it, as they stand, for the self-check to compare.
  perform set_config(
    'cn.m0416_was',
    (select string_agg(p.oid::regprocedure::text || '=' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, ''), ' | ' order by p.oid::regprocedure::text)
       from pg_proc p
      where p.oid in ('public.public_quote(text)'::regprocedure, 'public.accept_public_quote(text)'::regprocedure,
                      'public.needs_you_done_not_billed(timestamptz, timestamptz, integer)'::regprocedure)),
    true);
end $$;

-- ── 1. The sale's estimates ─────────────────────────────────────────────────────────────────────
create or replace function public.quote_family_ids(p_quote uuid)
returns setof uuid
language sql
stable
security invoker
set search_path = public
as $$
  with recursive
  me as (
    select q.id, q.org_id from public.quotes q where q.id = p_quote
  ),
  -- UP to the first of the line, in the estimate's own company, at most 12 hops.
  up as (
    select q.id, q.revises_quote_id, 0 as hops
      from public.quotes q
      join me on me.id = q.id
    union all
    select p.id, p.revises_quote_id, up.hops + 1
      from up
      join public.quotes p on p.id = up.revises_quote_id
      join me on me.org_id = p.org_id
     where up.hops < 12
  ),
  first_of_line as (
    select up.id from up order by up.hops desc limit 1
  ),
  -- DOWN from it through everything that revises any of them, the same company, at most 12 levels.
  down as (
    select f.id, 0 as depth from first_of_line f
    union all
    select k.id, down.depth + 1
      from down
      join public.quotes k on k.revises_quote_id = down.id
      join me on me.org_id = k.org_id
     where down.depth < 12
  )
  -- The estimate itself is always one of its sale's, found or not.
  select p_quote
  union
  select down.id from down;
$$;

comment on function public.quote_family_ids(uuid) is
  'One sale''s estimates (0416): the estimate, every estimate it revises up to the first of the line, and everything that revises any of them (quotes.revises_quote_id), in the estimate''s own company, at most 12 hops each way; the estimate itself always. Keep Both clears the pointer, so estimates kept as separate work are separate sales. SECURITY INVOKER: a signed-in person is answered from the estimates row security shows them. Asked by src/lib/sale-quotes.ts, public_quote and guard_one_deposit_per_sale.';
revoke all on function public.quote_family_ids(uuid) from public, anon;
grant execute on function public.quote_family_ids(uuid) to authenticated, service_role;

-- ── 2. One live deposit request per sale ────────────────────────────────────────────────────────
create or replace function public.guard_one_deposit_per_sale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family uuid[];
  v_other  text;
begin
  -- IT ACTS ONLY WHEN THE ROW BECOMES A LIVE DEPOSIT REQUEST OR CHANGES ESTIMATE (the trigger's WHEN
  -- already says the row is, after this write, a live request naming an estimate): an insert, or an
  -- update from void, to another estimate, or from another kind. ANY OTHER UPDATE IS LET THROUGH
  -- UNTOUCHED: a payment landing on a request (sent to partial to paid) is never refused here, even in
  -- a sale that held two live requests before 0416.
  if tg_op = 'UPDATE'
     and old.status <> 'void'
     and old.quote_id is not distinct from new.quote_id
     and old.invoice_kind is not distinct from new.invoice_kind then
    return new;
  end if;

  select coalesce(array_agg(f.id order by f.id), array[]::uuid[]) into v_family
    from public.quote_family_ids(new.quote_id) as f(id);

  -- THE LOCK: the sale's estimate rows, in id order, so two writers for one sale wait for each other
  -- (the second then reads the first one's request) and never deadlock on the order.
  perform 1 from public.quotes q where q.id = any (v_family) order by q.id for update;

  -- ANOTHER estimate of the sale with a live request. The same estimate is 0414's unique index's
  -- (invoices_one_live_deposit_request_per_estimate), which answers it as it always has.
  select coalesce(d.invoice_number, 'another payment request') into v_other
    from public.invoices d
   where d.org_id = new.org_id
     and d.invoice_kind = 'prepayment'
     and d.status <> 'void'
     and d.id is distinct from new.id
     and d.quote_id = any (v_family)
     and d.quote_id <> new.quote_id
   order by d.created_at, d.id
   limit 1;
  if found then
    raise exception 'This sale already has a deposit request: %. Use that one. Nothing was made.', v_other
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.guard_one_deposit_per_sale() is
  'ONE SALE, ONE DEPOSIT (0416): BEFORE INSERT OR UPDATE OF quote_id, status, invoice_kind on invoices, for a live deposit request naming an estimate. Acts only when the row becomes one or changes estimate (an insert; an update from void, to another estimate, or from another kind); any other update, a payment among them, passes untouched. Locks the sale''s estimates (quote_family_ids) in id order, then refuses when another live request of the company names another estimate of the sale. The same estimate is 0414''s unique index''s.';
revoke all on function public.guard_one_deposit_per_sale() from public, anon, authenticated;

create or replace trigger invoices_one_deposit_per_sale
  before insert or update of quote_id, status, invoice_kind on public.invoices
  for each row
  when (new.invoice_kind = 'prepayment' and new.quote_id is not null and new.status <> 'void')
  execute function public.guard_one_deposit_per_sale();

-- ── 3. The customer's estimate link says the sale's deposit, and what is left on it ─────────────
create or replace function public.public_quote(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'quote', json_build_object(
      'quote_number', q.quote_number, 'status', q.status, 'title', q.title,
      'description', q.description,
      'notes', q.notes, 'tax_rate', q.tax_rate, 'subtotal', q.subtotal,
      'tax', q.tax, 'total', q.total, 'valid_until', q.valid_until,
      'circuits', q.circuits,
      'doc_type', q.doc_type, 'created_at', q.created_at,
      -- 0414: THE DEPOSIT, AND WHERE IT STANDS: ONE NUMBER FOR THE PAPER, THE BUTTON AND THE CHARGE.
      -- deposit_amount: when the estimate has a live (not void) deposit request, THAT request's ask
      -- (the sum of its own lines), which is what its card door charges; otherwise the figure the
      -- office's save wrote (null on an estimate not saved since 0414: nothing is said for it).
      -- deposit_state: paid (the live request is paid); requested (it exists and is not paid yet: a
      -- live request is owed, on a finished job too); none (no live request and no figure, or 0; or
      -- the office voided the request, and a new one is made only by the office's own form; or the
      -- estimate's job is complete or cancelled); else due. can_take_card is the company's card
      -- door, the same expression public_invoice reads (0301's projection).
      -- 0416: ONE SALE, ONE DEPOSIT. Every read of a request in this block looks at the estimate's
      -- whole sale (public.quote_family_ids: the estimate, what it revises up to the first of the
      -- line, and every revision of any of them), so the revision of an estimate whose deposit was
      -- requested or paid says THAT request and never asks again. deposit_due: what is still owed on
      -- the sale's live request that is not paid (its total less what was paid on it, never below 0;
      -- the oldest first), which is what its card door charges before any fee; null when there is
      -- none. card_fee_percent: the company's card fee, by the expression public_invoice reads
      -- (0301's org object), 0 when it charges none.
      'deposit_amount', coalesce((select sum(it.line_total) from public.invoices d
                                    join public.invoice_items it on it.invoice_id = d.id
                                   where d.quote_id in (select public.quote_family_ids(q.id)) and d.org_id = q.org_id
                                     and d.invoice_kind = 'prepayment' and d.status <> 'void'),
                                 q.deposit_amount),
      'deposit_state', case
        when exists (select 1 from public.invoices d
                      where d.quote_id in (select public.quote_family_ids(q.id)) and d.org_id = q.org_id
                        and d.invoice_kind = 'prepayment' and d.status = 'paid') then 'paid'
        when exists (select 1 from public.invoices d
                      where d.quote_id in (select public.quote_family_ids(q.id)) and d.org_id = q.org_id
                        and d.invoice_kind = 'prepayment' and d.status <> 'void') then 'requested'
        when coalesce(q.deposit_amount, 0) <= 0 then 'none'
        when exists (select 1 from public.invoices d
                      where d.quote_id in (select public.quote_family_ids(q.id)) and d.org_id = q.org_id
                        and d.invoice_kind = 'prepayment' and d.status = 'void') then 'none'
        when exists (select 1 from public.jobs j
                      where j.id = q.job_id and j.org_id = q.org_id
                        and (j.status = 'complete' or j.status = 'cancelled')) then 'none'
        else 'due' end,
      'can_take_card', (select coalesce(o.stripe_charges_enabled, false)
                          from public.organizations o where o.id = q.org_id),
      'deposit_due', (select greatest(d.total - coalesce(d.amount_paid, 0), 0) from public.invoices d
                       where d.quote_id in (select public.quote_family_ids(q.id)) and d.org_id = q.org_id
                         and d.invoice_kind = 'prepayment' and d.status <> 'void' and d.status <> 'paid'
                       order by d.created_at, d.id
                       limit 1),
      'card_fee_percent', (select coalesce((o.settings->>'card_fee_percent')::numeric, 0)
                             from public.organizations o where o.id = q.org_id),
      -- 0408: THE WORD THE PAGE PRINTS BY, as resolved once below (fmt).
      'estimate_format', fmt.word),
    'items', coalesce((select json_agg(json_build_object(
      'description', li.description, 'quantity', li.quantity, 'unit', li.unit,
      'unit_price', li.unit_price, 'line_total', li.line_total,
      -- THE BREAKDOWN THE CUSTOMER MAY SEE (0386/0387/0395/0408), by the format resolved once below
      -- (fmt.word: the estimate's own word, else the company's):
      --   detailed  0395's object, key for key: his hours, the rate, the units, each labor row's
      --             label / hours / rate and each part's name, count and sell.
      --   grouped   the same labor keys, NO part at all (the list ships empty; no name, count or
      --             price is read) and ONE figure for one of the task: the parts' total, null when
      --             there is nothing priced.
      --   tasks     no breakdown.
      -- NEVER the contractor's net, the task id, the kit id, a book code or a person's id, in any
      -- arm. NO LABOR MONEY and no adds-up gate here: known and carried, see this migration's header.
      'detail', case
        when jsonb_typeof(li.detail) = 'object' and fmt.word = 'detailed'
        then jsonb_build_object(
          'hours', li.detail->'hours',
          'rate', li.detail->'rate',
          'units', li.detail->'units',
          'labor', coalesce((select jsonb_agg(jsonb_build_object(
              'label', l->'label', 'hours', l->'hours', 'rate', l->'rate') order by ord)
            from jsonb_array_elements(case when jsonb_typeof(li.detail->'labor') = 'array' then li.detail->'labor' else '[]'::jsonb end) with ordinality as lab(l, ord)), '[]'::jsonb),
          'materials', coalesce((select jsonb_agg(jsonb_build_object(
              'name', m->'name', 'qty', m->'qty', 'sell', m->'sell') order by ord)
            from jsonb_array_elements(case when jsonb_typeof(li.detail->'materials') = 'array' then li.detail->'materials' else '[]'::jsonb end) with ordinality as mats(m, ord)), '[]'::jsonb))
        when jsonb_typeof(li.detail) = 'object' and fmt.word = 'grouped'
        then jsonb_build_object(
          'hours', li.detail->'hours',
          'rate', li.detail->'rate',
          'units', li.detail->'units',
          'labor', coalesce((select jsonb_agg(jsonb_build_object(
              'label', l->'label', 'hours', l->'hours', 'rate', l->'rate') order by ord)
            from jsonb_array_elements(case when jsonb_typeof(li.detail->'labor') = 'array' then li.detail->'labor' else '[]'::jsonb end) with ordinality as lab(l, ord)), '[]'::jsonb),
          'materials', '[]'::jsonb,
          'materials_total', nullif(public.task_parts_total(li.detail), 0))
        else null end) order by li.sort_order)
      from public.quote_line_items li where li.quote_id = q.id), '[]'::json),
    'customer', coalesce(
      (select json_build_object('name', c.name, 'company_name', c.company_name,
        'address', c.address, 'unit', c.unit, 'city', c.city, 'state', c.state, 'zip', c.zip)
        from public.customers c where c.id = q.customer_id and c.org_id = q.org_id),
      (select json_build_object('name', i.name, 'company_name', i.company_name,
        'address', i.address, 'unit', i.unit, 'city', i.city, 'state', i.state, 'zip', i.zip)
        from public.inquiries i where i.id = q.inquiry_id and i.org_id = q.org_id)),
    -- RAW CANDIDATES, most specific first. No precedence here — see pickSite().
    'site_candidates', json_build_array(
      json_build_object('source', 'quote', 'parts', json_build_object(
        'address', q.address, 'unit', q.unit, 'city', q.city, 'state', q.state, 'zip', q.zip)),
      (select json_build_object('source', 'job', 'parts', json_build_object(
        'address', j.address, 'unit', j.unit, 'city', j.city, 'state', j.state, 'zip', j.zip))
        from public.jobs j where j.id = q.job_id and j.org_id = q.org_id),
      (select json_build_object('source', 'lead', 'parts', json_build_object(
        'address', i.address, 'unit', i.unit, 'city', i.city, 'state', i.state, 'zip', i.zip))
        from public.inquiries i where i.id = q.inquiry_id and i.org_id = q.org_id)),
    -- LETTERHEAD ONLY (0059's list) + the doc_style layout sub-key (0239). Never to_jsonb(o):
    -- organizations carries the settings jsonb (markup, labor rate, playbook,
    -- lead_inbound_secret) and the Stripe/subscription columns. If you re-create this
    -- function, copy THIS body.
    'org', (select json_build_object(
      'name', o.name, 'logo_url', o.logo_url,
      'address_line1', o.address_line1, 'address_line2', o.address_line2,
      'city', o.city, 'state', o.state, 'zip', o.zip,
      'phone', o.phone, 'email', o.email, 'license', o.license,
      'brand_color', o.brand_color,
      'doc_template', o.doc_template, 'doc_templates', o.doc_templates,
      'doc_style', o.settings->'doc_style')
      from public.organizations o where o.id = q.org_id)
  )
  from public.quotes q
  -- THE FORMAT, RESOLVED ONCE (0408): the estimate's own word, else the company's Doc Studio choice;
  -- anything that is not one of the three words (nothing set, or an old or unknown value) reads as
  -- tasks. The twin of lib/doc-style estimateFormatFor. Exactly one row, so the estimate above is
  -- neither dropped nor doubled.
  cross join lateral (
    select case when said.word in ('tasks', 'detailed', 'grouped') then said.word else 'tasks' end as word
      from (select coalesce(q.estimate_format, (select o.settings->'doc_style'->>'estimate_format' from public.organizations o where o.id = q.org_id)) as word) said
  ) fmt
  where q.public_token = p_token
    and q.status in ('sent', 'accepted', 'declined', 'expired');
$$;

-- ── 4. The customer's Accept makes a job that bills by the paper's word ─────────────────────────
create or replace function public.accept_public_quote(p_token text)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  q public.quotes;
  inq public.inquiries;
  cust_id uuid;
  new_job uuid;
  inq_phone text;
  inq_email text;
  inq_name text;
  site_address text; site_unit text; site_city text; site_state text; site_zip text;
  cust public.customers;   -- 0369: who, for the job's name
  org_tz text;             -- 0369: the company's today, for "New Job · Sep 27"
  scope_for_job text;      -- 0409: what the job takes from the estimate's description
begin
  select * into q from public.quotes where public_token = p_token;
  if q.id is null then
    return json_build_object('ok', false, 'error', 'Quote not found.');
  end if;

  if q.status = 'accepted' then
    return json_build_object('ok', true);
  end if;

  if q.status <> 'sent' then
    return json_build_object('ok', false, 'error', 'This quote is no longer available to accept.');
  end if;

  -- 0392: the flip is guarded on the status just read — a supersede or another Accept that landed
  -- between the read and this write is not overwritten; the row is read again and answered as it is.
  -- 0413: (c) WHO SAID YES. The customer, on their own link: accepted_how says so, and accepted_by is
  -- written empty ON PURPOSE. An estimate the office marked accepted, walked back to sent and then
  -- accepted on the link still carries the office person's id; left there, it would break the check
  -- quotes_accepted_by_not_on_link and the customer's tap would be refused.
  update public.quotes set status = 'accepted', accepted_at = now(), accepted_how = 'customer_link', accepted_by = null
   where id = q.id and status = 'sent';
  if not found then
    select * into q from public.quotes where id = q.id;
    if q.status = 'accepted' then
      return json_build_object('ok', true);
    end if;
    return json_build_object('ok', false, 'error', 'This quote is no longer available to accept.');
  end if;

  -- THE LEAD IS LOADED WHATEVER HAPPENS NEXT. It carries the site address, and a repeat customer
  -- (q.customer_id already set) skips the contact branch below without ever needing it — which is
  -- how the job lost its address for exactly the customers who had bought before.
  if q.inquiry_id is not null then
    -- 0413: (a) THE LEAD IS READ IN THE ESTIMATE'S OWN COMPANY. This function runs as its owner for
    -- somebody holding a token and nothing else: no row of another company is read on their behalf.
    select * into inq from public.inquiries where id = q.inquiry_id and org_id = q.org_id;
  end if;

  -- Deferred-customer estimate → born a Contact now. Crosscheck the book first (same phone / email /
  -- normalized name → link the existing customer, never duplicate), else auto-fill from the inquiry.
  if q.customer_id is null and inq.id is not null then
    -- 0413: (b) THE SURE MATCH, the SQL twin of sureCustomerMatch (src/lib/crm/duplicates.ts), with
    -- the lead's own customer first, as customerForInquiry (src/lib/actions/win-customer.ts) has it.
    -- Every read is in the estimate's own company, and each step runs only while nothing is found.
    -- 1. A LEAD ALREADY TIED TO A CUSTOMER KEEPS IT: that customer, when it is in this company.
    if inq.customer_id is not null then
      select c.id into cust_id from public.customers c
       where c.id = inq.customer_id and c.org_id = q.org_id;
    end if;

    -- The keys, as normPhone, normEmail and normName make them: the last ten digits (the ASCII digits
    -- alone, spelled [^0-9], never the class that follows the locale), the e-mail lowered and
    -- trimmed, the name lowered with everything but a to z and 0 to 9 taken out.
    inq_phone := right(regexp_replace(coalesce(inq.phone, ''), '[^0-9]', '', 'g'), 10);
    inq_email := btrim(lower(coalesce(inq.email, '')));
    inq_name  := regexp_replace(lower(coalesce(inq.name, '')), '[^a-z0-9]', '', 'g');

    -- 2. A PHONE IS ONE PERSON: seven digits at least; the oldest record first, then by id.
    if cust_id is null and length(inq_phone) >= 7 then
      select c.id into cust_id
      from public.customers c
      where c.org_id = q.org_id
        and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = inq_phone
      order by c.created_at, c.id
      limit 1;
    end if;

    -- 3. AN E-MAIL IS ONE PERSON, the same way.
    if cust_id is null and inq_email <> '' then
      select c.id into cust_id
      from public.customers c
      where c.org_id = q.org_id
        and btrim(lower(coalesce(c.email, ''))) = inq_email
      order by c.created_at, c.id
      limit 1;
    end if;

    -- 4. A NAME ONLY WHEN IT IS SURE: not a placeholder (a fragment's Unknown caller, or digits
    -- alone), the ONE customer in this company with that name, and no phone or e-mail on that record
    -- saying it is somebody else (both sides have one, and they differ). When the HAVING fails the
    -- select returns no row, and a SELECT INTO that finds no row sets cust_id to null: it stays
    -- null, and a NEW customer is made just below. Find Duplicates still shows the pair by name.
    if cust_id is null and inq_name <> '' and inq_name <> 'unknowncaller' and inq_name !~ '^[0-9]+$' then
      select (array_agg(c.id))[1] into cust_id
      from public.customers c
      where c.org_id = q.org_id
        and regexp_replace(lower(coalesce(c.name, '')), '[^a-z0-9]', '', 'g') = inq_name
      having count(*) = 1
         and not bool_or(
               (length(inq_phone) >= 7
                and length(right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)) >= 7
                and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) <> inq_phone)
            or (inq_email <> ''
                and btrim(lower(coalesce(c.email, ''))) <> ''
                and btrim(lower(coalesce(c.email, ''))) <> inq_email));
    end if;

    if cust_id is null then
      insert into public.customers (org_id, name, company_name, type, status, email, phone,
                                    address, unit, city, state, zip, notes, created_by)
      values (q.org_id, inq.name, inq.company_name,
              (coalesce(inq.type, 'residential'))::customer_type, 'active'::customer_status,
              inq.email, inq.phone,
              -- WHERE THE PERSON IS, all-or-nothing — the SQL twin of customerAddressFrom.
              case when inq.contact_address is not null then inq.contact_address else inq.address end,
              case when inq.contact_address is not null then inq.contact_unit  else inq.unit  end,
              case when inq.contact_address is not null then inq.contact_city  else inq.city  end,
              case when inq.contact_address is not null then inq.contact_state else inq.state end,
              case when inq.contact_address is not null then inq.contact_zip   else inq.zip   end,
              case when coalesce(inq.message, '') <> '' then 'From inquiry: ' || inq.message else inq.notes end,
              q.created_by)
      returning id into cust_id;
    end if;

    update public.quotes set customer_id = cust_id where id = q.id;
    update public.inquiries
      set customer_id = cust_id, status = 'won',
          converted_at = coalesce(converted_at, now()), updated_at = now()
      where id = q.inquiry_id;
    q.customer_id := cust_id; -- so the job below links the Contact
  end if;

  -- A REVISION TAKES THE ORIGINAL'S JOB (0391/0392; the SQL twin of createJobFromQuote's pin): born
  -- while the original was only sent (no job yet), a revision accepted through its own link would make
  -- a SECOND job when the original had been accepted in between. The work is one job: the revision is
  -- pinned to it (only while its own job_id is still null, the company's own row) and no job is born.
  if q.job_id is null and q.revises_quote_id is not null then
    select o.job_id into new_job from public.quotes o where o.id = q.revises_quote_id and o.org_id = q.org_id;
    if new_job is not null then
      update public.quotes set job_id = new_job where id = q.id and job_id is null;
      if found then
        q.job_id := new_job;
      else
        -- the office pinned or made a job in between: read it, so no second job is born below
        select job_id into q.job_id from public.quotes where id = q.id;
      end if;
      new_job := null;
    end if;
  end if;

  -- 0409: THE SCOPE THE JOB TAKES (the SQL twin of scopeForJob, src/lib/estimate/job-scope.ts): the
  -- estimate's description with the blank space at its ends removed, and nothing when that leaves
  -- nothing. Blank is a space, a tab, a line feed and a carriage return, and only those: the app's
  -- twin strips exactly these four, so neither JavaScript's trim() nor a bare btrim() will do here.
  scope_for_job := nullif(btrim(q.description, E' \t\n\r'), '');

  if q.job_id is null then
    -- 0396: the customer is read FIRST — the site address below falls through to theirs, as the
    -- office door does, and the name still reads it as before.
    if q.customer_id is not null then
      select * into cust from public.customers where id = q.customer_id and org_id = q.org_id;
    end if;

    -- WHERE THE WORK IS. One whole record wins: the quote if it has a street, else the lead, else
    -- (0396) the customer's address on file — the office door's own order (createJobFromQuote).
    -- Left null when none has one, so pickSite falls through to the customer exactly as before.
    if coalesce(q.address, '') <> '' then
      site_address := q.address; site_unit := q.unit; site_city := q.city; site_state := q.state; site_zip := q.zip;
    elsif coalesce(inq.address, '') <> '' then
      site_address := inq.address; site_unit := inq.unit; site_city := inq.city; site_state := inq.state; site_zip := inq.zip;
    elsif cust.id is not null and coalesce(cust.address, '') <> '' then
      site_address := cust.address; site_unit := cust.unit; site_city := cust.city; site_state := cust.state; site_zip := cust.zip;
    end if;

    -- THE NAME IS THE STREET, NEVER WHERE IT CAME FROM (0369; the owner 2026-09-28, "street number and
    -- name as always"): the street number and name (the site above, else the customer's own, as the
    -- staff path's createJobFromQuote reads it) and " #<unit>" with that street's unit; with no
    -- street, the customer as written · the estimate's own words with any source tag taken off
    -- ("Estimate — Rita Moss" is the tag and the person: no words; the lead door's "New deck — Rita
    -- Moss" is "New deck", and the lead's own spelling, inq.name, counts as the person too); else
    -- "New Job · Sep 27" on the company's today. Was: the title, else 'Job from ' || quote_number.
    select o.settings->>'timezone' into org_tz from public.organizations o where o.id = q.org_id;
    if org_tz is null or not exists (select 1 from pg_timezone_names where name = org_tz) then
      org_tz := 'America/Los_Angeles';
    end if;

    -- 0416: THE JOB BILLS BY THE PAPER'S WORD (it was 0413's (d), the company's usual kind). The
    -- customer accepted the paper they read: a Quote ("This is a fixed price") makes a fixed-price
    -- job, an Estimate a time and material one, the SQL twin of billingKindOfDocType
    -- (src/lib/appointments/won-sheet.ts). quotes.doc_type is text, 'estimate' or 'quote' (0047);
    -- jobs.billing_type is text under the check 'fixed' or 'tm' (0063): the case gives text and one
    -- of the two, so no cast is needed. public.usual_billing_type (0379) stays for its trigger.
    insert into public.jobs (org_id, customer_id, inquiry_id, name, status, billing_type,
                             address, unit, city, state, zip, description, created_by)
    values (q.org_id, q.customer_id, q.inquiry_id,
            public.job_name_from(null, q.title, cust.name, cust.company_name, cust.type::text,
                                 coalesce(nullif(site_address, ''), cust.address),
                                 case when coalesce(site_address, '') <> '' then site_unit else cust.unit end,
                                 inq.name,
                                 (now() at time zone org_tz)::date),
            'to_be_scheduled',
            case when q.doc_type = 'quote' then 'fixed' else 'tm' end,
            site_address, site_unit, site_city, site_state, site_zip,
            -- 0409: born with the estimate's scope as its Description (null when the estimate has none)
            scope_for_job,
            q.created_by)
    returning id into new_job;
    -- 0396: THE LINK IS COMPARE-AND-SET, as the office door's is (createJobFromQuote, cn-v1133). Two
    -- doors in the same second — the office's Accept and this one — each read "no job yet" and each
    -- made a job; this write, unguarded, then pointed the estimate at the second job and orphaned the
    -- first with its tasks. The link lands only while job_id is still null; when it does not, the
    -- other door's job IS the job: it is read back, and the job just made here (nothing on it yet,
    -- the company's own row) is removed. The answer is the same either way: accepted.
    update public.quotes set job_id = new_job where id = q.id and job_id is null;
    if not found then
      select job_id into q.job_id from public.quotes where id = q.id;
      delete from public.jobs where id = new_job and org_id = q.org_id;
    end if;
  end if;

  -- 0409: A JOB THAT WAS ALREADY THERE TAKES THE SCOPE ONLY WHERE ITS OWN DESCRIPTION IS EMPTY (the
  -- SQL twin of jobTakesScope). q.job_id is set here in three cases, and in none of them did this
  -- call make the job: the estimate was already on a job when it was accepted; a revision was pinned
  -- to its original's job above (0392); or the office's door linked its own job first and the one
  -- made here was removed (0396). The job made just above is not one of them: its link leaves
  -- q.job_id null, and it was born with the scope. Words a person typed on a job are never replaced.
  if q.job_id is not null and scope_for_job is not null then
    update public.jobs set description = scope_for_job
     where id = q.job_id and org_id = q.org_id
       and btrim(coalesce(description, ''), E' \t\n\r') = '';
  end if;

  return json_build_object('ok', true);
end $function$;

-- ── 5. Done, Not Billed: a payment request is not a bill for the work ───────────────────────────
create or replace function public.needs_you_done_not_billed(
  p_visit_from timestamptz,
  p_job_from timestamptz,
  p_limit integer default 200
)
returns table (
  src text,
  id uuid,
  job_id uuid,
  title text,
  job_number text,
  job_name text,
  customer_name text,
  at timestamptz,
  open_invoice_id uuid,
  total_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with me as (
    select public.auth_org_id() as org_id, public.is_org_staff() as staff
  ),
  -- 0416: A PAYMENT REQUEST IS NOT A BILL FOR THE WORK. A deposit or materials request (invoice_kind
  -- 'prepayment', 0414) bills no hour and no receipt, and carries its estimate's quote_id, so every
  -- read below that asks "is there a bill for this work" leaves it out: the visit's anchored bill
  -- (open_inv, and p, the paid one), its job's real billing (b), a real bill naming one of its job's
  -- estimates (n), and the same two for a finished job (b, n).
  visits as (
    select 'visit'::text as src,
           a.id,
           a.job_id,
           a.title,
           j.job_number,
           j.name as job_name,
           coalesce(c.name, i.name) as customer_name,
           a.starts_at as at,
           open_inv.id as open_invoice_id
      from me
      join public.appointments a on a.org_id = me.org_id
      left join public.customers c on c.id = a.customer_id and c.org_id = me.org_id
      left join public.inquiries i on i.id = a.inquiry_id and i.org_id = me.org_id
      left join public.jobs j on j.id = a.job_id and j.org_id = me.org_id
      left join lateral (
        select v.id
          from public.invoices v
         where v.appointment_id = a.id
           and v.org_id = me.org_id
           and v.status <> 'void'
           and coalesce(v.invoice_kind, 'standard') <> 'prepayment'
           and coalesce(v.amount_paid, 0) <= 0
         order by v.created_at, v.id
         limit 1
      ) open_inv on true
     where me.staff
       and a.absorbed = false
       and a.type in ('service_call', 'job')
       and a.status = 'completed'
       and a.starts_at >= p_visit_from
       -- settled: a live invoice anchored to the visit that has collected money
       and not exists (
             select 1
               from public.invoices p
              where p.appointment_id = a.id
                and p.org_id = me.org_id
                and p.status <> 'void'
                and coalesce(p.invoice_kind, 'standard') <> 'prepayment'
                and p.amount_paid > 0)
       -- its job carries real billing (a draft is work in progress, not a decision)
       and not (a.job_id is not null and exists (
             select 1
               from public.invoices b
              where b.job_id = a.job_id
                and b.org_id = me.org_id
                and b.status not in ('draft', 'void')
                and coalesce(b.invoice_kind, 'standard') <> 'prepayment'))
       -- 0403: or a real invoice NAMES one of its job's estimates, wherever it was put
       and not (a.job_id is not null and exists (
             select 1
               from public.invoices n
               join public.quotes q on q.id = n.quote_id and q.org_id = me.org_id
              where q.job_id = a.job_id
                and n.org_id = me.org_id
                and n.status not in ('draft', 'void')
                and coalesce(n.invoice_kind, 'standard') <> 'prepayment'))
       -- 0403: or its job carries the retired status invoiced (billed, by the word of its day)
       and coalesce(j.status::text, '') <> 'invoiced'
  ),
  finished_jobs as (
    select 'job'::text as src,
           j.id,
           j.id as job_id,
           null::text as title,
           j.job_number,
           j.name as job_name,
           c.name as customer_name,
           j.updated_at as at,
           null::uuid as open_invoice_id
      from me
      join public.jobs j on j.org_id = me.org_id
      left join public.customers c on c.id = j.customer_id and c.org_id = me.org_id
     where me.staff
       and j.status = 'complete'
       and j.updated_at >= p_job_from
       and not exists (
             select 1
               from public.invoices b
              where b.job_id = j.id
                and b.org_id = me.org_id
                and b.status not in ('draft', 'void')
                and coalesce(b.invoice_kind, 'standard') <> 'prepayment')
       -- 0403: nor one that NAMES one of the job's estimates (a job billed on another job's invoice)
       and not exists (
             select 1
               from public.invoices n
               join public.quotes q on q.id = n.quote_id and q.org_id = me.org_id
              where q.job_id = j.id
                and n.org_id = me.org_id
                and n.status not in ('draft', 'void')
                and coalesce(n.invoice_kind, 'standard') <> 'prepayment')
  ),
  done as (
    select * from visits
    union all
    select * from finished_jobs
  )
  select d.src, d.id, d.job_id, d.title, d.job_number, d.job_name, d.customer_name, d.at, d.open_invoice_id,
         count(*) over () as total_count
    from done d
   order by d.at asc, d.src, d.id
   limit greatest(coalesce(p_limit, 200), 0);
$$;

comment on function public.needs_you_done_not_billed(timestamptz, timestamptz, integer) is
  'Needs You''s Done, Not Billed (0371, 0403, 0416): finished visits (service_call/job, completed, not absorbed) and complete jobs since the two floors that no bill settles, OLDEST first, with the true total. Visits: not paid through an anchored invoice, not on a job with real billing, not on a job one of whose estimates a real invoice names (0403), not on an invoiced job (0403); open_invoice_id is the anchored unpaid one. Jobs: no invoice but drafts and voids, and no real invoice naming one of its estimates (0403). A payment request (invoice_kind prepayment, 0414) is no bill for the work in any of those reads (0416). Staff of the caller''s own company only (security invoker, org filter, is_org_staff).';

revoke all on function public.needs_you_done_not_billed(timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.needs_you_done_not_billed(timestamptz, timestamptz, integer) to authenticated;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  r     record;
  v_src text;
  v_was text;
  v_now text;
  v_one uuid := '00000000-0000-0000-0000-000000000416';
begin
  -- EACH FUNCTION IS THIS FILE'S, TO THE STATEMENT, AND MADE AS IT SAYS.
  for r in
    select * from (values
      ('public.quote_family_ids(uuid)', 'bbefad8de47aae8c9f11d826631d5a9d', false, 'sql', 's'),
      ('public.guard_one_deposit_per_sale()', '15de6d0f81fd1e038fd7b7886e9025c1', true, 'plpgsql', 'v'),
      ('public.public_quote(text)', '6227a13074f5a8c37ca69bf2f125f0ce', true, 'sql', 's'),
      ('public.accept_public_quote(text)', '1f597e394b2c55165ffbfe6fe1a67f65', true, 'plpgsql', 'v'),
      ('public.needs_you_done_not_billed(timestamptz, timestamptz, integer)', '347b72f0e3582846f0ff228e4c4ea4ec', false, 'sql', 's')
    ) as t(fn, now, definer, lang, volatility)
  loop
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure(r.fn);
    if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '') <> r.now then
      raise exception '0416 self-check: % does not read as the body this file wrote. Rolled back.', r.fn;
    end if;
    if (select p.prosecdef from pg_proc p where p.oid = to_regprocedure(r.fn)) is distinct from r.definer
       or (select l.lanname::text from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure(r.fn)) is distinct from r.lang
       or (select p.provolatile::text from pg_proc p where p.oid = to_regprocedure(r.fn)) is distinct from r.volatility
       or not coalesce((select p.proconfig @> array['search_path=public'] from pg_proc p where p.oid = to_regprocedure(r.fn)), false) then
      raise exception '0416 self-check: % is not the % % function (definer: %) with its search path pinned that this file made. Rolled back.', r.fn, r.volatility, r.lang, r.definer;
    end if;
  end loop;

  -- THE FAMILY: a set of uuids; the signed-in role and the server may ask it, a signed-out caller not;
  -- the owner of each definer function that asks it may; and it runs: an estimate nobody has is its own sale.
  if not (select p.proretset and p.prorettype = 'uuid'::regtype from pg_proc p where p.oid = 'public.quote_family_ids(uuid)'::regprocedure) then
    raise exception '0416 self-check: quote_family_ids does not return a set of uuids. Rolled back.';
  end if;
  if has_function_privilege('anon', 'public.quote_family_ids(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.quote_family_ids(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.quote_family_ids(uuid)', 'execute') then
    raise exception '0416 self-check: quote_family_ids is not executable by authenticated and service_role alone (anon must not). Rolled back.';
  end if;
  for r in
    select p.oid::regprocedure::text as fn, p.proowner
      from pg_proc p
     where p.oid in ('public.public_quote(text)'::regprocedure, 'public.guard_one_deposit_per_sale()'::regprocedure)
  loop
    if not has_function_privilege(r.proowner, 'public.quote_family_ids(uuid)', 'execute') then
      raise exception '0416 self-check: the owner of % cannot call quote_family_ids. Rolled back.', r.fn;
    end if;
  end loop;
  if (select array_agg(f.id) from public.quote_family_ids(v_one) as f(id)) is distinct from array[v_one] then
    raise exception '0416 self-check: quote_family_ids does not answer an unknown estimate with itself alone. Rolled back.';
  end if;

  -- THE BOUNDARY: nobody outside the database may call it, and its trigger is bound as this file made it.
  if has_function_privilege('anon', 'public.guard_one_deposit_per_sale()', 'execute')
     or has_function_privilege('authenticated', 'public.guard_one_deposit_per_sale()', 'execute') then
    raise exception '0416 self-check: a caller outside the database can run guard_one_deposit_per_sale. Rolled back.';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.invoices'::regclass and t.tgname = 'invoices_one_deposit_per_sale' and not t.tgisinternal
       and t.tgfoid = 'public.guard_one_deposit_per_sale()'::regprocedure and t.tgenabled <> 'D'
       and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & 8) = 0 and (t.tgtype & 16) = 16
       and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
             where a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])) = array['invoice_kind', 'quote_id', 'status']
       and position('prepayment' in pg_get_triggerdef(t.oid)) > 0
       and position('quote_id IS NOT NULL' in pg_get_triggerdef(t.oid)) > 0
  ) then
    raise exception '0416 self-check: the trigger invoices_one_deposit_per_sale is not bound before insert or update of quote_id, status, invoice_kind for each row, with its WHEN. Rolled back.';
  end if;
  if to_regclass('public.invoices_one_live_deposit_request_per_estimate') is null then
    raise exception '0416 self-check: 0414''s one live deposit request per estimate is gone. Rolled back.';
  end if;

  -- THE THREE RE-MADE FUNCTIONS: owned and granted as they were; the doors still answer.
  v_was := current_setting('cn.m0416_was', true);
  if v_was is null or v_was = '' then
    raise exception '0416 self-check: this file has to run in ONE transaction (the runners wrap it in begin and commit): who owned the three functions before the change did not reach this check. Run it through the migration runner.';
  end if;
  select string_agg(p.oid::regprocedure::text || '=' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, ''), ' | ' order by p.oid::regprocedure::text)
    into v_now
    from pg_proc p
   where p.oid in ('public.public_quote(text)'::regprocedure, 'public.accept_public_quote(text)'::regprocedure,
                   'public.needs_you_done_not_billed(timestamptz, timestamptz, integer)'::regprocedure);
  if v_now is distinct from v_was then
    raise exception '0416 self-check: the owner or the grants of a re-made function changed (before: %; now: %). Rolled back.', v_was, v_now;
  end if;
  if has_function_privilege('anon', 'public.needs_you_done_not_billed(timestamptz, timestamptz, integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.needs_you_done_not_billed(timestamptz, timestamptz, integer)', 'execute') then
    raise exception '0416 self-check: Done, Not Billed is not for the signed-in role alone. Rolled back.';
  end if;
  if public.public_quote('0416 self-check: no estimate has this token') is not null then
    raise exception '0416 self-check: public_quote answered a token no estimate has. Rolled back.';
  end if;
  if (public.accept_public_quote('0416 self-check: no estimate has this token') ->> 'ok') is distinct from 'false' then
    raise exception '0416 self-check: accept_public_quote did not refuse a token no estimate has. Rolled back.';
  end if;

  raise notice '0416: one sale, one deposit: a revision''s link says the deposit its sale already has, a second request in a sale is refused, the link says what is left and the card fee, the customer''s Accept bills by the paper''s word, and Done, Not Billed no longer takes a payment request for billed work.';
end $$;
