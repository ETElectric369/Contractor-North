-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0402: the panel door is measured
--
-- The job's Panel tab is rebuilt around the physical box (the panel-first wave, Erik 2026-10-30:
-- "a physical panel visual … and printable label strips to exact spacing"). The labels that go on a
-- panel door are two strips, one beside each column of breakers, cut with scissors and stuck down:
-- every label box is as tall as the handle it names (one space for a single or a 2-pole line, half a
-- space for a tandem's line) and as wide as the label area beside that column. Those two numbers
-- differ by make — a Siemens or a Square D space is an inch, an Eaton CH space is three quarters —
-- and a person can measure them once with a tape. This migration gives the panel a place to
-- remember what was measured, so every later print is to scale without measuring again.
--
-- WHAT CHANGES:
--
--   public.job_panels gets three nullable numbers, in inches:
--     space_pitch_in        how tall one space is on this door (> 0 and at most 3).
--     label_width_in        how wide the label area is beside the LEFT column (> 0 and at most 6).
--     label_width_in_right  the label area beside the RIGHT column, only when it differs from the
--                           left (same check); null = the same as the left.
--   Null means nobody has measured: the app reads the make's default (lib/panel/geometry
--   brandDefaults — one documented table: 1 in per space, 0.75 in for an Eaton or Cutler-Hammer CH;
--   a label area of 1.125 in for a Siemens, 1 in otherwise). The app never writes a default into
--   these columns: a stored number is always one a person measured.
--
--   The readers, the day they are added (a stored answer nothing reads back is a hole): the label
--   strips page /print/panel-labels/<job> (lib/panel/geometry panelGeometry → lib/panel/strip and
--   lib/panel/fit) reads all three; the Panel tab's loader and savePanel (app/(app)/jobs/
--   panel-actions) read them back and write them through normalizePanelPatch.
--
--   No RLS change: job_panels keeps 0333's three policies (read, insert, update by the org's active
--   members; no delete) and 0333's guard trigger, which stamps who changed a panel and when. Nothing
--   here carries a price, a part number or a supplier (0333's rule, checked again below).
--
-- LOCKS: ALTER TABLE … ADD COLUMN takes job_panels' ACCESS EXCLUSIVE lock for a moment; a nullable
-- column with no default is a catalog change, and each CHECK reads the (small) table once to prove
-- it holds. lock_timeout 3s: a busy table fails fast and changes nothing; run it again. Twice-safe:
-- every column is ADD COLUMN IF NOT EXISTS (its named check rides with it), and the comments are
-- set to the same text again.
--
-- ORDER: after 0333 (job_panels). Apply BEFORE the panel-first deploy: the Panel tab's loader and the
-- label strips page select these columns, and a missing column would fail the read.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.job_panels') is null then
    raise exception '0402: job_panels (0333) is not on this database. Apply 0333 first. Nothing was changed.';
  end if;
  if to_regprocedure('public.job_panel_guard()') is null then
    raise exception '0402: job_panel_guard (0333) is missing; a panel''s changes would go unstamped. Nothing was changed.';
  end if;
end $$;

-- ── the three measurements ──────────────────────────────────────────────────────────────────────
alter table public.job_panels add column if not exists space_pitch_in numeric
  constraint job_panels_space_pitch_in_range check (space_pitch_in is null or (space_pitch_in > 0 and space_pitch_in <= 3));
alter table public.job_panels add column if not exists label_width_in numeric
  constraint job_panels_label_width_in_range check (label_width_in is null or (label_width_in > 0 and label_width_in <= 6));
alter table public.job_panels add column if not exists label_width_in_right numeric
  constraint job_panels_label_width_in_right_range check (label_width_in_right is null or (label_width_in_right > 0 and label_width_in_right <= 6));

comment on column public.job_panels.space_pitch_in is
  'How tall one space is on this panel''s door, in inches, as a person measured it (0402). A single or 2-pole handle is one space; a tandem''s two handles share one. Null = the make''s default (lib/panel/geometry: 1 in, 0.75 in for an Eaton CH). The label strips print every box to it.';
comment on column public.job_panels.label_width_in is
  'How wide the label area is beside the LEFT column of breakers, in inches, as a person measured it once (0402). Null = the make''s default (1.125 in for a Siemens, 1 in otherwise). The left label strip prints exactly this wide.';
comment on column public.job_panels.label_width_in_right is
  'How wide the label area is beside the RIGHT column, in inches, only when it differs from the left (0402). Null = the same as the left. The right label strip prints exactly this wide.';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_col text;
  v_con text;
  v_n   integer;
begin
  foreach v_col in array array['space_pitch_in', 'label_width_in', 'label_width_in_right'] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'job_panels' and column_name = v_col
         and data_type = 'numeric' and is_nullable = 'YES'
    ) then
      raise exception '0402: job_panels.% is missing, or is not a number that may be left empty. Nothing was changed.', v_col;
    end if;
  end loop;
  -- Each measurement carries its own range check, by name.
  foreach v_con in array array['job_panels_space_pitch_in_range', 'job_panels_label_width_in_range', 'job_panels_label_width_in_right_range'] loop
    if not exists (select 1 from pg_constraint where conrelid = 'public.job_panels'::regclass and conname = v_con and contype = 'c') then
      raise exception '0402: the check % is missing from job_panels, so a zero or a nonsense width could be stored. Nothing was changed.', v_con;
    end if;
  end loop;
  -- 0333's boundary is untouched: RLS on, its three policies, its guard trigger, no delete.
  if not (select relrowsecurity from pg_class where oid = 'public.job_panels'::regclass) then
    raise exception '0402: row level security is off on job_panels. Nothing was changed.';
  end if;
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'job_panels' and policyname in ('job_panels_read', 'job_panels_insert', 'job_panels_update');
  if v_n <> 3 then
    raise exception '0402: job_panels does not carry 0333''s read, insert and update policies. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.job_panels'::regclass and tgname = 'job_panel_guard' and not tgisinternal) then
    raise exception '0402: 0333''s guard trigger is not on job_panels. Nothing was changed.';
  end if;
  if has_table_privilege('authenticated', 'public.job_panels', 'delete') then
    raise exception '0402: a member could hard-delete a panel. Nothing was changed.';
  end if;
  -- Still nothing money- or part-shaped on a panel (0333's rule).
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'job_panels'
       and column_name ~ '(price|cost|amount|supplier|vendor|part)'
  ) then
    raise exception '0402: job_panels carries a money or part column. Nothing was changed.';
  end if;
  raise notice '0402: the panel door is measured — a space''s height and each label area''s width live on the panel, null until a person measures, and the label strips print to them.';
end $$;
