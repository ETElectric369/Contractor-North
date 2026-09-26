-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0342: a line says what it is (labor, materials, other)
--
-- Erik, 2026-09-25, on INV-079 (J-055): "Other instead of materials in invoice". Three receptacle
-- and switch lines added from his price list ("TM870LA — S5A 125V 1P SWITCH", "3232TRI — 15A 125V
-- DPLX RCPT", "1597TRW — 15A 125V GFCI RCPT") printed under Other on the customer's Cost Breakdown
-- and portal. The root: a line with no importer behind it (import_source null) was classified only
-- by its WORDS and UNIT (handLineKind in src/lib/invoice-math.ts, lineGroup in
-- src/lib/portal/line-kind.ts), so a price-book line, whose words are a code and a catalog name,
-- could never be anything but Other.
--
-- 1. invoice_items.line_kind: text, null, one of labor / materials / other / credit. NULL means
--    "infer it as today" (import_source, then the words and unit). A stored kind is read FIRST by
--    every reader. The app sets it where it KNOWS: a line added from the price book (the picker, a
--    linked kit line, Nort's add line, the estimate's price-book lines) is labor when the book
--    prices it in hours, and materials when the book item names a SUPPLIER (a part bought from
--    someone). A book item with neither says nothing: TAHOE DECK's and Vivian Builders' books are
--    installed work and job-cost codes ("D1 — New Construction — Deck Build", "1605 — Electrical -
--    Rough In & Finish (Labor)", "035 — Permits & Fees"), none with a supplier, so being in the
--    book is not being materials. The office can set any line's kind with the Kind chip. The app
--    suggests, a person decides.
--
-- 2. The customer's documents carry it (the projection-parity law: every field the shared document
--    components classify on). invoice_document_projection (read by public_invoice, the /i link, and
--    by portal_job_view's per-bill doc) and portal_job_view's `lines` block each gain 'line_kind'.
--    public_invoice is a one-line wrapper over invoice_document_projection and is not rebuilt.
--    Both are rewritten FROM THEIR LIVE DEFINITIONS by replacing exactly ONE fragment each (the
--    0315 / 0326 / 0335 technique), refusing unless that fragment appears exactly once:
--      invoice_document_projection: 'import_source', it.import_source) order by it.sort_order)
--      portal_job_view:             'import_source', it.import_source,
--    LIVE BODIES THIS STARTS FROM: pg_get_functiondef of both in production, 2026-09-25 (after
--    0335: portal_job_view carries 0301, 0315's customer_line_words, 0326's shared papers and
--    0335's panels; invoice_document_projection carries 0301 + 0315's customer_line_words). The
--    fragments above were copied from those bodies. Grants unchanged (service role only).
--
-- 3. BACKFILL, CLASSIFICATION ONLY. A line with import_source null and line_kind null that names a
--    price_list_items code IN THE SAME ORG (trimmed, case ignored, exact equality) and whose book
--    item names a supplier gets 'materials' (the same rule as the app's kindFromPriceBook /
--    priceBookCodeKeys). A line names a code by its lead (the text before " — ", "TM870LA — S5A
--    125V 1P SWITCH") or, copied from an estimate, in brackets (the estimate's line-map writes
--    "<desc> [CODE]": INV-056's "... (FLEXBOX 16 cu in) [P116OW]"; Erik, 2026-09-25: "Also price
--    list items I added from stock"). The keys are tried in one order and the FIRST that is a code
--    in the book decides: the lead (rank 0), each bracketed token whole (rank n, in order), then the
--    last word of a bracketed token of several words ("[RACO 936]" -> "936", rank 1000 + n).
--    A line billed in hours, or whose book item is priced in hours, is left
--    alone: it already reads Labor, and a stored 'materials' would make it read wrong. No words,
--    amount, unit, order, claim, edited flag or total changes (mark_invoice_item_edited looks only
--    at description / quantity / unit_price / unit; the claim trigger only at source_ids /
--    invoice_id). The count per org is RAISEd as a NOTICE.
--
-- SELF-CHECK: every invoice document and every portal job page that opens today is read before and
-- after. With 'line_kind' taken out, each must read byte for byte the same; every document's lines
-- must carry the new key. INV-079 in ET Electric must file as Labor $531.25 / Materials $25.50.
--
-- ORDER: after 0335 (applied). Deploy-safe either way: the app writes line_kind only when the
-- column is there (it retries without it) and reads it only when it is present.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. the ground this stands on ───────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.invoice_document_projection(uuid)') is null
     or to_regprocedure('public.portal_job_view(text, uuid)') is null then
    raise exception '0342: invoice_document_projection / portal_job_view (0301) are not on this database. Nothing was changed.';
  end if;
  if position('job_panels' in pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure)) = 0 then
    raise exception '0342: portal_job_view is older than 0335 (no panels). Apply 0335 first. Nothing was changed.';
  end if;
end $$;

-- ── self-check helper: a document with every 'line_kind' key taken out ────────────────────────
-- Arrays are compared as sets of elements (sorted by their text): two lines that share a
-- sort_order, or two payments that share a paid_at, come back from json_agg in either order from
-- one read to the next, and this rewrite changes no ORDER BY, so order is not what it checks.
create or replace function pg_temp._0342_strip(j jsonb) returns jsonb
language plpgsql immutable as $$
begin
  if j is null then
    return null;
  elsif jsonb_typeof(j) = 'object' then
    return coalesce((select jsonb_object_agg(k, pg_temp._0342_strip(v)) from jsonb_each(j) e(k, v) where k <> 'line_kind'), '{}'::jsonb);
  elsif jsonb_typeof(j) = 'array' then
    return coalesce((select jsonb_agg(s order by s::text) from (select pg_temp._0342_strip(v) as s from jsonb_array_elements(j) a(v)) x), '[]'::jsonb);
  end if;
  return j;
end $$;

-- Every invoice document and portal job page as it reads TODAY.
drop table if exists _0342_docs;
drop table if exists _0342_pages;
create temp table _0342_docs as
select i.id, public.invoice_document_projection(i.id)::jsonb as j from public.invoices i;
create temp table _0342_pages as
select a.token, jb.id as job_id, public.portal_job_view(a.token, jb.id)::jsonb as j
  from public.customer_portal_access a
  join public.jobs jb on jb.customer_id = a.customer_id and jb.org_id = a.org_id
 where a.enabled;

-- ── 1. the column ──────────────────────────────────────────────────────────────────────────────
alter table public.invoice_items add column if not exists line_kind text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_items_line_kind_known'
                   and conrelid = 'public.invoice_items'::regclass) then
    alter table public.invoice_items add constraint invoice_items_line_kind_known
      check (line_kind is null or line_kind in ('labor', 'materials', 'other', 'credit'));
  end if;
end $$;
comment on column public.invoice_items.line_kind is
  'What this line is on the customer''s documents: labor / materials / other / credit. NULL = infer it (import_source, then the words and unit: handLineKind / lineGroup). Set by the doors that know (a price-book line is materials, or labor when the book prices it in hours) and by the office''s Kind chip. Classification only: never changes the line''s words, amount or order (0342).';

-- ── 2. the customer's documents carry it ───────────────────────────────────────────────────────
do $$
declare
  v_def text;
  v_n int;
  v_old text := $old$'import_source', it.import_source) order by it.sort_order)$old$;
  v_new text := $new$'import_source', it.import_source, 'line_kind', it.line_kind) order by it.sort_order)$new$;
begin
  v_def := pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure);
  if position('it.line_kind' in v_def) = 0 then
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0342: invoice_document_projection''s line fragment appears % time(s), not once, so someone changed it since 0315. Nothing was changed.', v_n;
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

do $$
declare
  v_def text;
  v_n int;
  v_old text := $old$'import_source', it.import_source,$old$;
  v_new text := $new$'import_source', it.import_source, 'line_kind', it.line_kind,$new$;
begin
  v_def := pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure);
  if position('it.line_kind' in v_def) = 0 then
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0342: portal_job_view''s line fragment appears % time(s), not once, so someone changed it since 0335. Nothing was changed.', v_n;
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

-- ── 3. backfill: a price-book line is materials (classification only) ────────────────────────
do $$
declare
  r record;
  v_total int := 0;
begin
  drop table if exists _0342_filed;
  create temp table _0342_filed on commit drop as
  with book as (
    select org_id, lower(btrim(code)) as code_key,
           bool_or(lower(btrim(coalesce(unit, ''))) ~ '^(hr|hrs|hour|hours|man-?hours?)$') as book_hours,
           bool_or(nullif(btrim(supplier), '') is not null) as book_supplied
      from public.price_list_items
     where nullif(btrim(code), '') is not null
     group by org_id, lower(btrim(code))
  )
  , cand as (
    -- Every code key a line names, ranked as priceBookCodeKeys orders them.
    select it.id, it.org_id, c.key, c.rank
      from public.invoice_items it
      cross join lateral (
        select lower(btrim(split_part(it.description, ' — ', 1))) as key, 0::bigint as rank
         where position(' — ' in coalesce(it.description, '')) > 0
        union all
        select lower(btrim(m.t[1])), m.n
          from regexp_matches(coalesce(it.description, ''), '\[([^\]]+)\]', 'g') with ordinality as m(t, n)
        union all
        select lower((regexp_match(btrim(m.t[1]), '(\S+)$'))[1]), 1000 + m.n
          from regexp_matches(coalesce(it.description, ''), '\[([^\]]+)\]', 'g') with ordinality as m(t, n)
         where btrim(m.t[1]) ~ '\s'
      ) c
     where it.import_source is null
       and it.line_kind is null
       and c.key <> ''
  ), hit as (
    -- The first key that is a code in the line's own org's book decides.
    select distinct on (c.id) c.id, c.org_id, b.book_hours, b.book_supplied
      from cand c
      join book b on b.org_id = c.org_id and b.code_key = c.key
     order by c.id, c.rank
  )
  select it.id, it.org_id
    from hit h
    join public.invoice_items it on it.id = h.id and it.org_id = h.org_id
   where it.import_source is null
     and it.line_kind is null
     and not h.book_hours
     and h.book_supplied
     and lower(btrim(coalesce(it.unit, ''))) !~ '^(hr|hrs|hour|hours|man-?hours?)$';

  update public.invoice_items it
     set line_kind = 'materials'
    from _0342_filed f
   where f.id = it.id and it.org_id = f.org_id and it.line_kind is null;

  for r in
    select f.org_id, coalesce(o.name, '(no name)') as name, count(*) as n
      from _0342_filed f left join public.organizations o on o.id = f.org_id
     group by f.org_id, o.name order by count(*) desc
  loop
    raise notice '0342: % (%) — % price-book line(s) filed under Materials', r.name, r.org_id, r.n;
    v_total := v_total + r.n;
  end loop;
  raise notice '0342: % line(s) in all', v_total;
end $$;

-- ── self-check ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_bad int;
  v_labor numeric;
  v_mat numeric;
  v_other numeric;
begin
  if position('it.line_kind' in pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure)) = 0
     or position('it.line_kind' in pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure)) = 0 then
    raise exception '0342: a customer document does not carry line_kind. Nothing was changed.';
  end if;
  if position('job_panels' in pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure)) = 0
     or position('customer_line_words' in pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure)) = 0 then
    raise exception '0342: a rewrite lost an earlier block (0315 / 0335). Nothing was changed.';
  end if;

  -- Every invoice document reads exactly as before, the new key aside, and every line carries it.
  select count(*) into v_bad
    from _0342_docs b
   where pg_temp._0342_strip(b.j) is distinct from pg_temp._0342_strip(public.invoice_document_projection(b.id)::jsonb);
  if v_bad > 0 then
    raise exception '0342: % invoice document(s) would read differently. Nothing was changed.', v_bad;
  end if;
  if exists (
    select 1 from _0342_docs b
     cross join lateral jsonb_array_elements(coalesce(public.invoice_document_projection(b.id)::jsonb -> 'items', '[]'::jsonb)) it
     where not (it ? 'line_kind')
  ) then
    raise exception '0342: an invoice document line is missing line_kind. Nothing was changed.';
  end if;

  -- Every portal job page reads exactly as before, the new key aside.
  select count(*) into v_bad
    from _0342_pages b
   where pg_temp._0342_strip(b.j) is distinct from pg_temp._0342_strip(public.portal_job_view(b.token, b.job_id)::jsonb);
  if v_bad > 0 then
    raise exception '0342: % customer job page(s) would read differently. Nothing was changed.', v_bad;
  end if;

  -- The doors keep the grants they had.
  if has_function_privilege('anon', 'public.portal_job_view(text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.portal_job_view(text, uuid)', 'execute')
     or has_function_privilege('anon', 'public.invoice_document_projection(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.invoice_document_projection(uuid)', 'execute') then
    raise exception '0342: a customer document door became callable without the service role. Nothing was changed.';
  end if;

  -- Erik's INV-079 (ET Electric), when it is on this database: Labor $531.25 / Materials $25.50.
  select coalesce(sum(it.line_total) filter (where it.import_source = 'labor' or it.line_kind = 'labor'), 0),
         coalesce(sum(it.line_total) filter (where it.line_kind = 'materials' or (it.line_kind is null and it.import_source = 'costs')), 0),
         coalesce(sum(it.line_total) filter (where coalesce(it.line_kind, '') not in ('labor', 'materials')
                                               and coalesce(it.import_source, '') not in ('labor', 'costs')), 0)
    into v_labor, v_mat, v_other
    from public.invoice_items it
    join public.invoices i on i.id = it.invoice_id and i.org_id = it.org_id
   where i.org_id = '60195593-2e18-4230-bc8e-7a32d36d038d' and i.invoice_number = 'INV-079';
  if found and (v_labor + v_mat + v_other) <> 0 then
    raise notice '0342: INV-079 files as Labor % / Materials % / Other %', v_labor, v_mat, v_other;
  end if;
end $$;

drop table _0342_docs;
drop table _0342_pages;
