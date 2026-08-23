-- 0212 — audit v800 confirmed fixes (DB half). Both bodies below are 0204's / 0193's ACTUAL
-- shipped text with one line changed each; everything else (return shapes, the advisory lock,
-- the draft guard, the cn.importing flag, the zero-close semantics) is preserved verbatim.
--
-- 1) reset_import_source enumerated only two of the THREE costs key families, so "Start it
--    over" could not rebuild itemized receipt lines — while its confirm text promises it will.
-- 2) close_stale_open_entry compared new.org_id, which is NULL at BEFORE-INSERT time: org_id is
--    stamped by stamp_org_time_entries, and Postgres fires BEFORE-row triggers in trigger-NAME
--    order, so 'close_stale_before_punch' runs first. `org_id = NULL` is never true, the UPDATE
--    matched zero rows every time, and the forgotten-punch unblock has never once fired.

-- ── 1. the costs tombstone reset must also forget bli: keys ─────────────────────────────────
create or replace function public.reset_import_source(p_invoice_id uuid, p_source text)
returns jsonb
language plpgsql
as $function$
declare
  v_status   text;
  v_cleared  integer := 0;
  v_forgot   integer := 0;
begin
  if p_source is null or p_source = '' then
    raise exception 'An import source is required.';
  end if;

  select status into v_status from public.invoices where id = p_invoice_id;
  if v_status is null then
    raise exception 'Invoice not found.';
  end if;
  -- Same law as every importer: a sent invoice is the customer's document now.
  if v_status <> 'draft' then
    raise exception 'This invoice has been sent — only a draft can be re-imported.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_invoice_id::text || ':' || p_source));

  -- Speak as the IMPORTER (0175's flag): otherwise the delete trigger reads this as a human
  -- removing lines and tombstones every key we are about to re-import.
  perform set_config('cn.importing', '1', true);

  delete from public.invoice_items
   where invoice_id = p_invoice_id
     and import_source = p_source;
  get diagnostics v_cleared = row_count;

  -- Forget the tombstones for THIS source only. Keys are '<source-ish>:<id>' — labor keys start
  -- 'labor:', quote keys 'quote:', and COSTS mints THREE families: 'po:<id>', 'bill:<id>'
  -- (including 'bill:<id>:remainder') and 'bli:<bill line id>', one per itemized receipt line —
  -- the common case since the receipt reader shipped. 0204 enumerated only bill:/po:, so every
  -- bli: tombstone survived the reset and the rebuilt import silently skipped those lines.
  update public.invoices i
     set dismissed_import_keys = (
           select coalesce(array_agg(k), '{}')
             from unnest(coalesce(i.dismissed_import_keys, '{}')) as k
            where case p_source
                    when 'labor' then k not like 'labor:%'
                    when 'costs' then (k not like 'bill:%' and k not like 'po:%' and k not like 'bli:%')
                    when 'quote' then k not like 'quote:%'
                    else k not like p_source || ':%'
                  end
         )
   where i.id = p_invoice_id;
  get diagnostics v_forgot = row_count;

  return jsonb_build_object('cleared_lines', v_cleared, 'forgot_dismissals', v_forgot);
end;
$function$;

-- ── 2. the forgotten-punch unblock stops reading an unstamped column ────────────────────────
create or replace function public.close_stale_open_entry()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ceiling constant interval := interval '18 hours';
begin
  -- Only a genuine new OPEN punch by this person triggers the sweep.
  if new.status is distinct from 'open' then
    return new;
  end if;

  update public.time_entries
     set status = 'closed',
         -- The one time that is not a guess. Never now(), never clock_in + 18h.
         clock_out = clock_in,
         lunch_minutes = 0,
         auto_closed_reason = 'forgotten — closed at zero hours so the next punch could start; office to correct'
   where profile_id = new.profile_id
     -- org_id is deliberately NOT compared here: it is NULL at BEFORE-INSERT time (0212).
     -- profile_id already scopes this to one person, and a profile belongs to one org.
     and status = 'open'
     and id is distinct from new.id
     and now() - clock_in > v_ceiling;

  return new;
end
$function$;

comment on function public.close_stale_open_entry() is
  'Zero-closes a >18h forgotten punch when the same person punches in again (0193). The org predicate was removed in 0212: new.org_id is NULL at BEFORE-INSERT time, so the guard never fired.';
