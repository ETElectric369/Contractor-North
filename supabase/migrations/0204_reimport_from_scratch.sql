-- 0204 — THE WAY BACK FROM A DELETED IMPORT LINE (Erik, 8/18).
--
-- "i tried to reimport the timecard entries so i could get the order right … but its not working."
-- It was working exactly as written, which is the problem. 0175 gave imports three protections:
--
--   · dismissed_import_keys — a line you DELETED stays deleted, so an auto-import can't
--     resurrect a decision you already made.
--   · edited — a line you CHANGED is yours now; a later import must not overwrite the number
--     you negotiated.
--   · the draft lock — imports never re-inflate a sent invoice.
--
-- Each is right on its own. Together they made a job's labor unreachable: Erik deleted a crew
-- member's line to re-import in a different order, which tombstoned that person's key, and the
-- two surviving lines were both `edited`. So "Import labor" ran, changed nothing, and reported
-- success — the worst possible answer, because nothing on screen said WHY.
--
-- A protection with no way to release it is a trap. This function is the release: an explicit,
-- staff-initiated "start this import over" that forgets the tombstones for ONE source, drops that
-- source's lines (announcing itself as the importer so the delete trigger doesn't tombstone them
-- on the way out), and leaves the caller to run the importer fresh. It touches only the named
-- source: resetting labor never disturbs hand-entered lines, materials, or a draw credit.

create or replace function public.reset_import_source(
  p_invoice_id uuid,
  p_source     text
)
returns jsonb
language plpgsql
security invoker           -- RLS still decides whether this caller may touch this invoice
as $$
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
  -- 'labor:', costs keys are per-bill/PO ('bill:'/'po:'), quote keys 'quote:' — so a source's
  -- tombstones are matched by the keys it actually mints, never by a blanket wipe.
  update public.invoices i
     set dismissed_import_keys = (
           select coalesce(array_agg(k), '{}')
             from unnest(coalesce(i.dismissed_import_keys, '{}')) as k
            where case p_source
                    when 'labor' then k not like 'labor:%'
                    when 'costs' then (k not like 'bill:%' and k not like 'po:%')
                    when 'quote' then k not like 'quote:%'
                    else k not like p_source || ':%'
                  end
         )
   where i.id = p_invoice_id;
  get diagnostics v_forgot = row_count;

  return jsonb_build_object('cleared_lines', v_cleared, 'forgot_dismissals', v_forgot);
end;
$$;

comment on function public.reset_import_source(uuid, text) is
  'Start one import source over on a DRAFT invoice (0204): drop its lines (as the importer, so nothing is tombstoned) and forget that source''s dismissed keys. The escape hatch for 0175''s protections.';
