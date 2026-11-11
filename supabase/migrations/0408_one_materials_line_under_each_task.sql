-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0408: one Materials line under each task
--
-- Erik, 2026-11-10: "on the estimate we now have a [show] labor and materials on estimate and its
-- either all the materials listed out or none and i think we should have an option to list out all
-- the materials shown as it is now and an option to group the materials into one materials line as
-- im finding that different people require different solutions." Asked where the one line goes, he
-- chose: ONE "Materials" line UNDER EACH TASK, never one for the whole estimate.
--
-- WHY. An estimate built from tasks read one of two ways (0386, 0395): 'tasks', the task and its
-- price with nothing beneath, or 'detailed', each labor row and every part named, counted and
-- priced. Some customers should see the labor and what the materials come to, without the parts
-- list. So there is a third word, 'grouped': the labor exactly as 'detailed' prints it, the parts
-- as ONE figure per task. Nothing about a price or a total changes: the format is only READ.
--
-- WHAT, three things and nothing else:
--
--  1. THE CHECK ACCEPTS THE THIRD WORD. quotes.estimate_format (0395) may hold 'tasks', 'detailed'
--     or 'grouped'. Null still means the company's choice (settings->doc_style->estimate_format, a
--     key inside a jsonb that no check reads). 0395 wrote its check inline, so Postgres named it;
--     this file does not assume the name. It finds the one check on quotes that reads
--     estimate_format alone (pg_constraint.conkey), reads the words in its definition, drops it by
--     the name it has and adds quotes_estimate_format_check with the three words. No row is
--     rewritten: null, 'tasks' and 'detailed' keep their meaning. The ground check refuses if any
--     row holds a word the old check did not allow.
--
--  2. public.task_parts_total(jsonb): THE PARTS OF ONE TASK, ADDED UP. The SQL twin of
--     taskMoney(detail).parts (src/lib/estimate/task-lines.ts): each named part's count times its
--     price, rounded to the cent as partMoney rounds it, then summed. It is here so the customer's
--     page can be handed ONE number with no part behind it. Immutable; it reads its argument and
--     nothing else. Not callable from outside the database (revoked from public, anon and
--     authenticated, as 0369's helpers are): its one caller is public_quote, which runs as its
--     owner.
--
--  3. public.public_quote LEARNS THE THIRD WORD. Its body is 0395's with these changes and no
--     others:
--       a. THE FORMAT IS RESOLVED ONCE per estimate, beside the estimate in the FROM clause: the
--          estimate's own word, else the company's, and anything that is not one of the three
--          words reads as 'tasks'. 0395 resolved it again inside every line. It is still the twin
--          of lib/doc-style estimateFormatFor: the check in (1) keeps the estimate's own word to
--          null or one of the three, so this coalesce and that reader cannot disagree.
--       b. THE QUOTE OBJECT SAYS IT: 'estimate_format', the resolved word. A breakdown now reads
--          two ways, so the page is told which and no longer infers it from a breakdown arriving.
--       c. A LINE'S DETAIL HAS THREE ARMS. 'detailed': 0395's object, not one key more or less.
--          'grouped': the same labor keys (hours, rate, units, each labor row's label / hours /
--          rate, never who did the work), 'materials' as the literal empty list, and
--          'materials_total' = task_parts_total(detail), null when it is 0. 'tasks': no detail.
--     Under 'grouped' no part's name, count or price is read at all, so none can leave: the one
--     Materials line on the paper is not a parts list in the page's data either. The grant is
--     re-stated as 0395 left it. If you re-create this function, copy THIS body.
--
-- KNOWN AND CARRIED (not built here, on purpose). The page prints a breakdown only while it adds up
-- to the line's unit price (detailExplains). A line priced by hand afterwards keeps its stored
-- breakdown, and this function still SHIPS it: under 'grouped' as it does today under 'detailed'.
-- The page hides it; the wire carries it. Closing that here would take the labor's money in SQL,
-- and laborMoney is a float product in the app (hours × rate, rounded): a numeric twin would land
-- a cent away at a half-cent product and withhold a breakdown the page would have printed. So NO
-- LABOR MONEY is computed in SQL and no adds-up gate is added. The parts are different: partMoney
-- is whole-cent arithmetic, which numeric reproduces exactly.
--
-- THE READERS, named the day they are added: quote.estimate_format is read by the customer's page
-- (src/app/q/[token]/page.tsx); detail.materials_total by the one decision about what prints under
-- a task line (src/lib/estimate/task-lines.ts paperBreakdown), which the customer's page and the
-- office's papers both ask; the stored word by lib/doc-style (ESTIMATE_FORMATS, estimateFormatFor).
--
-- ORDER. BEFORE the deploy that offers One Materials Line: until this is applied the old check
-- refuses 'grouped' on save. Applied first it changes nothing a person sees: the old app never
-- writes the third word, still reads a breakdown's arrival as 'detailed', and ignores the new key.
--
-- LOCKS. Swapping the check takes ACCESS EXCLUSIVE on quotes for a moment and validates the new
-- check by reading the table once; no row is written. lock_timeout 3s: a busy table fails fast and
-- changes nothing; run it again. ONE TRANSACTION: the runners wrap the file, and the self-check
-- leans on that (the grants public_quote had before the change are noted in a transaction-local
-- setting and compared at the end). Twice-safe: a second run finds the three-word check and leaves
-- it, replaces both functions with the same text, and passes the same self-check. Run again AFTER a
-- later migration has re-made public_quote, it refuses at the ground check: it never puts its own
-- body back over a newer one.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ── The ground it stands on ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_n     int;
  v_def   text;
  v_words text[];
  v_bad   int;
  v_src   text;
begin
  if to_regclass('public.quotes') is null then
    raise exception '0408: public.quotes is not on this database. Nothing was changed.';
  end if;
  if to_regclass('public.quote_line_items') is null then
    raise exception '0408: public.quote_line_items is not on this database. Nothing was changed.';
  end if;
  if to_regclass('public.organizations') is null then
    raise exception '0408: public.organizations is not on this database. Nothing was changed.';
  end if;
  if (select count(*) from pg_roles where rolname in ('anon', 'authenticated')) <> 2 then
    raise exception '0408: the roles anon and authenticated are not on this database. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'quote_line_items' and column_name = 'detail' and data_type = 'jsonb'
  ) then
    raise exception '0408: quote_line_items.detail (0386, jsonb) is missing. Apply 0386 first. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'quotes' and column_name = 'estimate_format' and data_type = 'text'
  ) then
    raise exception '0408: quotes.estimate_format (0395, text) is missing. Apply 0395 first. Nothing was changed.';
  end if;

  -- THE CHECK, FOUND BY WHAT IT READS, never by a name assumed: the one check on quotes whose only
  -- column is estimate_format (the columns a check reads are pg_constraint.conkey; 0401 reads a
  -- constraint's columns the same way), and the words its definition allows.
  select count(*), min(pg_get_constraintdef(c.oid)) into v_n, v_def
    from pg_constraint c
   where c.conrelid = 'public.quotes'::regclass and c.contype = 'c'
     and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['estimate_format'];
  if v_n <> 1 then
    raise exception '0408: expected exactly one check on quotes that reads estimate_format alone (0395 made one); found %. Nothing was changed.', v_n;
  end if;
  select coalesce(array_agg(w[1] order by w[1]), '{}'::text[]) into v_words
    from regexp_matches(v_def, '''([^'']*)''', 'g') as w;
  if v_words <> array['detailed', 'tasks'] and v_words <> array['detailed', 'grouped', 'tasks'] then
    raise exception '0408: the check on quotes.estimate_format reads "%": not the two words 0395 wrote, nor this file''s three. Nothing was changed.', v_def;
  end if;

  -- NO ROW IS MOVED TO MAKE ROOM. A word the check on the column does not allow (on a first run:
  -- anything but the two old words) is somebody's estimate, and a migration does not guess what
  -- they meant.
  select count(*) into v_bad
    from public.quotes
   where estimate_format is not null and estimate_format <> all (v_words);
  if v_bad > 0 then
    raise exception '0408: % estimate(s) hold a paper format outside the words the column allows (%). Look at them, set each to tasks or detailed (or to null for the company''s choice), then run this again. Nothing was changed.', v_bad, array_to_string(v_words, ', ');
  end if;

  -- THE FUNCTION THIS FILE REPLACES IS THE ONE IT WAS WRITTEN FROM. A function rebuilt from the
  -- migration that made it silently undoes whatever was changed since (0377's lesson), so the live
  -- body is read first: its statements, with comments and spacing taken out, must be 0395's (the
  -- first md5) or, on a second run, exactly this file's own (the second). Anything else is refused
  -- and never overwritten: a body changed by hand, or one a LATER migration made when this file is
  -- run again out of order. tests/migration-0408.test.ts recomputes both md5s from the two files.
  if to_regprocedure('public.public_quote(text)') is null then
    raise exception '0408: public.public_quote(text) is not on this database (0012; last made by 0395). Nothing was changed.';
  end if;
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.public_quote(text)'::regprocedure;
  if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '')
       not in ('ad93e87a89404dcaa57e3898d742e245', '1fb44c873db221169e56bf191659db3d') then
    raise exception '0408: public_quote on this database is not the body 0395 left, nor this file''s own: it was changed outside this repository''s migrations, or by a later migration (then this file must not run again), or 0395 was applied from another text. Read it (select pg_get_functiondef(''public.public_quote(text)''::regprocedure)) and reconcile the two before this runs. Nothing was changed.';
  end if;
  if not has_function_privilege('anon', 'public.public_quote(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.public_quote(text)', 'execute') then
    raise exception '0408: the customer''s link cannot call public_quote on this database (0395 grants it to anon and authenticated). Nothing was changed.';
  end if;

  -- Its grants as they stand, for the self-check to compare once the body is replaced.
  perform set_config(
    'cn.m0408_public_quote_acl',
    'acl:' || coalesce((select p.proacl::text from pg_proc p where p.oid = 'public.public_quote(text)'::regprocedure), ''),
    true);
end $$;

-- ── 1. The check accepts the third word ─────────────────────────────────────────────────────────
do $$
declare
  v_name text;
  v_def  text;
begin
  -- The one the ground check found (exactly one, or this file stopped there).
  select c.conname::text, pg_get_constraintdef(c.oid) into strict v_name, v_def
    from pg_constraint c
   where c.conrelid = 'public.quotes'::regclass and c.contype = 'c'
     and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['estimate_format'];
  -- A second run: the three-word check is already there, under its name. Nothing to swap.
  if v_name = 'quotes_estimate_format_check' and position('''grouped''' in v_def) > 0 then
    return;
  end if;
  execute format('alter table public.quotes drop constraint %I', v_name);
  alter table public.quotes
    add constraint quotes_estimate_format_check check (estimate_format in ('tasks','detailed','grouped'));
end $$;

-- ── 2. The parts of one task, added up ──────────────────────────────────────────────────────────
-- THE SQL TWIN OF taskMoney(detail).parts (src/lib/estimate/task-lines.ts). Two rules, mirrored:
--
--   named      a part counts only when it has a name: `name` is a string with something in it once
--              trimmed (the app's `named`: m.name.trim().length > 0). The characters btrim takes
--              off below are exactly the ones JavaScript's trim() takes off (tab, line feed,
--              vertical tab, form feed, carriage return, space, no-break space, the Unicode spaces,
--              the line and paragraph separators, the byte-order mark), so a name that is only a
--              tab is no name on either side. `name` is the one key a part is known by: every
--              writer stores it (coerceTaskDetail settles it before a row is saved) and it is the
--              only key the public wire has ever read a part by.
--   partMoney  works in whole cents: round(qty × 100) × round(sell × 100) / 100, rounded, / 100.
--              In decimals that is the same number as each figure rounded to two places,
--              multiplied (four places, exact in numeric) and rounded to two: 2.5 × 1.99 = 4.9750,
--              so 4.98, where a float product (4.97499…) says 4.97. numeric round() rounds a half
--              AWAY FROM ZERO and Math.round rounds a half UP; for figures that are never below
--              zero those are the same rounding, and greatest(…, 0) keeps them there (a figure
--              below zero is a hole to the app's reader, coerceTaskDetail, and counts as nothing).
--              A null or missing count or price counts as 0, as `m.qty ?? 0` does; so does one that
--              is not a JSON number (every writer stores numbers).
--
-- Each part is rounded FIRST and the rounded figures are summed, never the raw products summed and
-- rounded once: that is what makes the one figure equal the bullets 'detailed' would have printed,
-- to the cent. The app rounds its float sum once more to cents (round2); a numeric sum of whole
-- cents needs no second rounding. Both figures are stored with at most two decimals (coerceTaskDetail
-- rounds them on every save); a hand-edited third decimal sitting exactly on a half cent is the one
-- place a float and a decimal can part, and the app never writes one.
create or replace function public.task_parts_total(p_detail jsonb)
returns numeric
language sql
immutable
set search_path = public
as $$
  select coalesce(sum(round(
             round(greatest(case when jsonb_typeof(m->'qty')  = 'number' then (m->>'qty')::numeric  else 0 end, 0), 2)
           * round(greatest(case when jsonb_typeof(m->'sell') = 'number' then (m->>'sell')::numeric else 0 end, 0), 2),
           2)), 0)
    from jsonb_array_elements(
           case when jsonb_typeof(p_detail->'materials') = 'array' then p_detail->'materials' else '[]'::jsonb end
         ) as parts(m)
   where jsonb_typeof(m) = 'object'
     and jsonb_typeof(m->'name') = 'string'
     and btrim(m->>'name', E' \t\n\x0B\f\r\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') <> ''
$$;

comment on function public.task_parts_total(jsonb) is
  'The parts of ONE task, added up (0408): the sum over the NAMED parts in detail->materials of round(qty, 2) x round(sell, 2), each rounded to the cent before it is summed; a null, missing, negative or non-numeric figure counts as 0; no parts = 0. The SQL twin of src/lib/estimate/task-lines.ts taskMoney(detail).parts (partMoney, named). Pure. Called only by public_quote, for the one Materials figure a grouped estimate ships.';

-- Pure, but only the database's own function needs it.
revoke all on function public.task_parts_total(jsonb) from public, anon, authenticated;

-- ── 3. public_quote learns the third word ───────────────────────────────────────────────────────
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

grant execute on function public.public_quote(text) to anon, authenticated;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_quote regprocedure := 'public.public_quote(text)'::regprocedure;
  v_total regprocedure := 'public.task_parts_total(jsonb)'::regprocedure;
  v_n     int;
  v_name  text;
  v_def   text;
  v_words text[];
  v_src   text;
  v_was   text;
  v_now   text;
  r       record;
begin
  -- 1. THE CHECK: one, under its name, validated, allowing the three words and no other; the column
  --    still takes null (the company's choice).
  select count(*), min(c.conname::text), min(pg_get_constraintdef(c.oid)) into v_n, v_name, v_def
    from pg_constraint c
   where c.conrelid = 'public.quotes'::regclass and c.contype = 'c'
     and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['estimate_format'];
  if v_n <> 1 or v_name <> 'quotes_estimate_format_check' then
    raise exception '0408: quotes does not carry the one check quotes_estimate_format_check on estimate_format (found %, named %). Nothing was changed.', v_n, coalesce(v_name, 'nothing');
  end if;
  select coalesce(array_agg(w[1] order by w[1]), '{}'::text[]) into v_words
    from regexp_matches(v_def, '''([^'']*)''', 'g') as w;
  if v_words <> array['detailed', 'grouped', 'tasks'] then
    raise exception '0408: the check on quotes.estimate_format reads "%", not tasks, detailed and grouped. Nothing was changed.', v_def;
  end if;
  if not (select c.convalidated from pg_constraint c
           where c.conrelid = 'public.quotes'::regclass and c.conname = 'quotes_estimate_format_check') then
    raise exception '0408: the check on quotes.estimate_format was not validated against the rows. Nothing was changed.';
  end if;
  if (select a.attnotnull from pg_attribute a
       where a.attrelid = 'public.quotes'::regclass and a.attname = 'estimate_format' and not a.attisdropped) then
    raise exception '0408: quotes.estimate_format no longer takes null, which is the company''s choice. Nothing was changed.';
  end if;

  -- 2. THE PARTS OF ONE TASK, ADDED UP AS THE APP ADDS THEM. tests/migration-0408.test.ts runs these
  --    same details through the app's taskMoney and wants the same figures.
  for r in
    select * from (values
      ('2.5 at 1.99 is 4.98, where a float product says 4.97', '{"materials":[{"name":"Strap","qty":2.5,"sell":1.99}]}'::jsonb, 4.98),
      ('each part is rounded first, then summed: 0.91 + 4.98 + 0.50 + 3.99', '{"materials":[{"name":"Wire nut","qty":7,"sell":0.13},{"name":"Strap","qty":2.5,"sell":1.99},{"name":"Tape","qty":1.5,"sell":0.33},{"name":"Anchor","qty":3,"sell":1.33}]}'::jsonb, 10.38),
      ('a part with no name is not counted', '{"materials":[{"name":"","qty":3,"sell":10},{"name":"Anchor","qty":3,"sell":1.33}]}'::jsonb, 3.99),
      ('a name of spaces, a tab or a no-break space is no name', '{"materials":[{"name":"   ","qty":1,"sell":5},{"name":"\t","qty":1,"sell":5},{"name":"\u00a0 ","qty":1,"sell":5}]}'::jsonb, 0),
      ('a name that is not a string is no name', '{"materials":[{"name":7,"qty":1,"sell":5},{"name":null,"qty":1,"sell":5},{"qty":1,"sell":5}]}'::jsonb, 0),
      ('a null count is 0', '{"materials":[{"name":"Tape","qty":null,"sell":9}]}'::jsonb, 0),
      ('a null price is 0', '{"materials":[{"name":"Tape","qty":3,"sell":null}]}'::jsonb, 0),
      ('a missing count and price are 0', '{"materials":[{"name":"Tape"}]}'::jsonb, 0),
      ('a figure below zero counts as nothing', '{"materials":[{"name":"Credit","qty":-2,"sell":5},{"name":"Bolt","qty":2,"sell":-5},{"name":"Anchor","qty":1,"sell":2}]}'::jsonb, 2),
      ('an entry that is not a part is skipped', '{"materials":[null,7,"x",[1],{"name":"Anchor","qty":1,"sell":2}]}'::jsonb, 2),
      ('no parts is 0', '{"materials":[]}'::jsonb, 0),
      ('no list at all is 0', '{"labor":[{"label":null,"hours":2,"rate":145}]}'::jsonb, 0),
      ('a list that is not a list is 0', '{"materials":"none"}'::jsonb, 0),
      ('what the labor comes to is not in it', '{"labor":[{"label":"Helper","hours":4,"rate":65}],"materials":[{"name":"Anchor","qty":3,"sell":1.33}]}'::jsonb, 3.99)
    ) as t(why, detail, want)
  loop
    if public.task_parts_total(r.detail) is distinct from r.want then
      raise exception '0408: task_parts_total answers % where the app''s taskMoney answers % (%). Nothing was changed.',
        public.task_parts_total(r.detail), r.want, r.why;
    end if;
  end loop;
  if public.task_parts_total(null) is distinct from 0 or public.task_parts_total('[]'::jsonb) is distinct from 0 then
    raise exception '0408: task_parts_total does not answer 0 for no breakdown at all. Nothing was changed.';
  end if;
  if (select p.provolatile from pg_proc p where p.oid = v_total) <> 'i' or (select p.prosecdef from pg_proc p where p.oid = v_total) then
    raise exception '0408: task_parts_total is not a plain immutable function. Nothing was changed.';
  end if;

  -- 3. WHO MAY CALL WHAT. The helper: nobody outside the database, and the role public_quote runs as.
  if has_function_privilege('anon', v_total, 'execute') or has_function_privilege('authenticated', v_total, 'execute') then
    raise exception '0408: a caller outside the database can run task_parts_total. Nothing was changed.';
  end if;
  if not has_function_privilege(pg_get_userbyid((select p.proowner from pg_proc p where p.oid = v_quote)), v_total, 'execute') then
    raise exception '0408: public_quote runs as a role that cannot run task_parts_total, so a grouped estimate would fail on the customer''s link. Nothing was changed.';
  end if;
  -- public_quote: still the customer's door, and its grants exactly what they were before this file.
  if not has_function_privilege('anon', v_quote, 'execute') or not has_function_privilege('authenticated', v_quote, 'execute') then
    raise exception '0408: the customer''s link can no longer call public_quote. Nothing was changed.';
  end if;
  v_was := current_setting('cn.m0408_public_quote_acl', true);
  if v_was is null or left(v_was, 4) <> 'acl:' then
    raise exception '0408: this file has to run in ONE transaction (the runners wrap it in begin and commit): the grants public_quote had before the change did not reach this check. Run it through the migration runner.';
  end if;
  select 'acl:' || coalesce(p.proacl::text, '') into v_now from pg_proc p where p.oid = v_quote;
  if v_now is distinct from v_was then
    raise exception '0408: the grants on public_quote changed (before: %; now: %). Nothing was changed.', v_was, v_now;
  end if;

  -- 4. THE FUNCTION: still the definer's stable SQL door with its search path pinned, carrying the
  --    three arms and the word, and building no key the company keeps to itself.
  select p.prosrc into v_src from pg_proc p where p.oid = v_quote;
  if not (select p.prosecdef from pg_proc p where p.oid = v_quote)
     or (select p.provolatile from pg_proc p where p.oid = v_quote) <> 's'
     or not coalesce((select p.proconfig @> array['search_path=public'] from pg_proc p where p.oid = v_quote), false) then
    raise exception '0408: public_quote is no longer the stable security-definer function with its search path pinned. Nothing was changed.';
  end if;
  if position('''estimate_format'', fmt.word' in v_src) = 0 then
    raise exception '0408: public_quote does not say which format it resolved. Nothing was changed.';
  end if;
  if position('fmt.word = ''detailed''' in v_src) = 0 or position('fmt.word = ''grouped''' in v_src) = 0 then
    raise exception '0408: public_quote does not carry both breakdown arms. Nothing was changed.';
  end if;
  if position('''materials'', ''[]''::jsonb' in v_src) = 0
     or position('''materials_total'', nullif(public.task_parts_total(li.detail), 0)' in v_src) = 0 then
    raise exception '0408: the grouped arm does not ship an empty parts list and the one figure. Nothing was changed.';
  end if;
  -- A part's name is read in ONE place: the detailed arm.
  if (length(v_src) - length(replace(v_src, 'm->''name''', ''))) / length('m->''name''') <> 1 then
    raise exception '0408: public_quote reads a part''s name somewhere other than the detailed arm. Nothing was changed.';
  end if;
  if v_src ~ '''(cost|code|words|task_id|kit_id|person_id|rate_from|from_kit|hours_from_kit)''\s*,' then
    raise exception '0408: public_quote builds a key the company keeps to itself. Nothing was changed.';
  end if;
  if position('q.status in (''sent'', ''accepted'', ''declined'', ''expired'')' in v_src) = 0 then
    raise exception '0408: public_quote lost its status gate. Nothing was changed.';
  end if;
  -- The body now stored is this file's own, by the same reading the ground check gave the old one:
  -- so a second run of this file finds what it expects, which is what makes it twice-safe.
  if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '') <> '1fb44c873db221169e56bf191659db3d' then
    raise exception '0408: the public_quote now on this database does not read as the body this file wrote, so a second run of this file would refuse. Nothing was changed.';
  end if;
  -- It runs: an unknown token is answered with nothing, not an error.
  if public.public_quote('0408 self-check: no estimate has this token') is not null then
    raise exception '0408: public_quote answered a token no estimate has. Nothing was changed.';
  end if;

  raise notice '0408: one Materials line under each task — quotes.estimate_format takes tasks, detailed or grouped; public_quote says which it resolved, and under grouped ships the labor and ONE figure for the parts, never a part.';
end $$;
