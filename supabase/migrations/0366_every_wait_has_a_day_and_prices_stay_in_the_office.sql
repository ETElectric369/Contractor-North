-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0366: every wait has a day, and prices stay in the office
--
-- THE WAVE'S ONLY MIGRATION (Wave 1, lane 2). 0359 was never used; nothing else in this wave
-- carries DDL.
--
-- ═══ APPLY ORDER ═══════════════════════════════════════════════════════════════════════════
--   PRODUCTION: ONLY AFTER THE ORDER-1 RELEASE IS LIVE, AND BEFORE ANY ORDER-2 LANE MERGES.
--   THE REVOKE IN PART C BREAKS EVERY WALK-THROUGH PAGE STILL READING inspection_answers FROM
--   THE appointments TABLE: the release before this one does exactly that, so running this first
--   takes the walk-through, the estimate builder's prefill and the Panel tab's suggestions down
--   until the new code is deployed. The new code reads the view and falls back to the table while
--   the view is missing, so code first, then this, is safe in that order only.
--   The integrator hands it to Erik (~/Developer/db/pending, one self-contained block, safe to
--   press twice) once the release is deployed.
--   NEVER PRACTICE IT ON PRODUCTION: a practice run inside BEGIN ... ROLLBACK still takes the
--   locks below on jobs, appointments and forms, and every page reading them waits until the
--   rollback (see parallel-branch-lessons, 2026-09-24/25).
--   THE TEST DATABASE: the DB suites that need it (hold-day, appointments-price-guard) apply this
--   file inside their own rolled-back transaction when the database doesn't have it yet.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- ONE TRANSACTION. apply-migration.cjs (production) and scripts/test-db/rebuild.cjs (the test
-- database) wrap the file in begin/commit, as they do every migration; the file holds no
-- begin/commit of its own so a suite can run it inside its own rolled-back transaction. Every part
-- lands, or none does. lock_timeout 5s: queued behind a long transaction on jobs, appointments or
-- forms, it gives up in five seconds and changes nothing, instead of stalling the app.
--
-- SAFE TO RUN TWICE: add column if not exists, create or replace, drop-then-create for the one
-- policy it replaces and the two views' read-only triggers, revoke/grant (idempotent), a grant
-- list rebuilt from the live columns. It writes NO company data and
-- backfills nothing.
--
-- NOTHING IS REPLACED FROM AN OLD BODY except one policy: forms_read, whose live text (read from
-- pg_policies on the test database 2026-09-27; the test database mirrors production's policies,
-- scripts/test-db/schema-diff.cjs) is `org_id = auth_org_id()`, 0004's generic loop. Every function
-- here is new.
--
-- ── A. EVERY WAIT HAS A DAY (NY-hold) ──────────────────────────────────────────────────────
--
-- Erik, 2026-09-26: "jobs on hold will have a reason and that reason is usually a reminder", and
-- then "too quiet gets things lost". A hold is a reason AND the day it comes back (default a week,
-- never "no date"); on that day it returns to Needs You with its reason.
--
--   jobs.hold_until            the day a held job comes back. Null only on a job not on hold, or on
--                              a job held before this migration (the Needs You feeder treats a
--                              missing day as due now: a Reminder row, "No Day Set", whose Snooze
--                              picks one). NO BACKFILL.
--   jobs.hold_by               who put it on hold (profiles, jobs_hold_by_fkey, so an embed can
--                              name it). Written by the database, never trusted from a client.
--   quotes.follow_up_at        the day to follow up on an estimate the customer hasn't answered.
--                              Never valid_until: that is the customer's offer window, printed on
--                              the estimate itself.
--   invoices.due_date_by_hand  true when a person typed the due date, so Send doesn't restamp it
--                              (lane 4 reads it, W1-27).
--
--   jobs_hold_day (BEFORE INSERT OR UPDATE ON jobs), security definer so it may call split_org_tz
--   (0288, revoked from the signed-in role), the same company-timezone helper 0360 uses:
--     · entering hold (inserted on hold, or the status just became on_hold): hold_until is what the
--       writer sent, else the company's today + 7; hold_by is the signed-in person, else what the
--       writer sent (a server write names nobody unless it says who).
--     · staying on hold: a signed-in writer never moves hold_by (it keeps the person who held it);
--       hold_until is whatever the writer sent (Snooze).
--     · any other status: hold_reason, hold_until and hold_by are cleared. So EVERY door that takes a
--       job off hold (wake, placing it on a day, the status control, Finish, Nort, a clock-in, Which
--       Job) clears the hold, with no door able to forget.
--   Cheap: it runs on every jobs write, and reads the company's timezone only when a job enters hold
--   with no day. A job IMPORTED already on hold (importJobs) gets its day here too, with no reason
--   ("No reason saved" on its row until someone gives one): acceptable, and never a job with no day.
--
-- ── B. A WALK-THROUGH'S ANSWERS STAY IN THE OFFICE (LEAK-0227) ──────────────────────────────
--
-- 0227 lets a tech read the appointment he is assigned to, and RLS cannot hide a column. So an
-- assigned tech read the whole row straight from PostgREST with the anon key and his own session,
-- inspection_answers included, and a scopes question stores [{code, qty, price}]: the office's
-- prices. The page already strips them (answersWithoutPrices), but a page is a convention, not a
-- boundary.
--
--   public.answers_without_prices(jsonb)   the exact mirror of answersWithoutPrices
--                                          (src/lib/inspection/walkthrough-access.ts): per top-level
--                                          key, an array keeps its elements with `price` taken off
--                                          every object element, an object loses its `price`,
--                                          anything else is kept. Immutable.
--   public.appointment_answers             THE ONLY READ OF WALK-THROUGH ANSWERS. A security-barrier
--                                          view owned by postgres (the profile_pay shape, 0215): the
--                                          visit's id, company, job, lead, start, sheet, and its
--                                          answers: as stored for the office, without prices for
--                                          anyone else. Its WHERE restates 0227's row rule (the
--                                          office sees the company's visits, anyone else only the
--                                          ones assigned to him), because the owner reads past RLS.
--                                          READ-ONLY, like profile_pay after 0218: every privilege
--                                          comes off public, anon and authenticated, SELECT goes back
--                                          to authenticated, and an INSTEAD OF trigger
--                                          (refuse_view_write) refuses any write that still reaches
--                                          it. A write through a one-table view runs as its owner,
--                                          past every row rule. form_playbooks (C) is locked the same.
--   the revoke                             SELECT on appointments comes off the signed-in and anon
--                                          roles and goes back to the signed-in role for every live
--                                          column EXCEPT inspection_answers (the list is built from
--                                          the live columns when this runs). Column privileges are
--                                          per role and every signed-in person is the same role, so
--                                          the office reads the answers through the view too.
--   UNCHANGED: 0227's two policies, every INSERT and UPDATE grant, and save_walkthrough_capture
--   (0356; security definer, so it still reads and writes the column). A crew lead saves exactly as
--   before.
--
--   FROM NOW ON A NEW appointments COLUMN IS PRIVATE until its own migration grants SELECT on it to
--   authenticated (the 0216 rule for profiles, now for appointments too).
--
-- ── C. A WALK-THROUGH SHEET'S DOLLAR FIGURES STAY IN THE OFFICE (added by the lead) ─────────
--
-- forms_read (0004) is every form of the company for every signed-in person, and a written
-- playbook's `why` is where the answer lands in the PRICE ("Zinsco or FPE turns a $400 circuit into
-- a panel swap") while its `note` is the owner's own voice (lib/playbook/types). The appointment page
-- strips both for anyone who isn't the office (sheetsWithoutMoney); PostgREST didn't.
--
--   public.playbook_without_money(jsonb)   the mirror of sheetsWithoutMoney's per-sheet step: the
--                                          needs (an array playbook, or its `needs`), each without
--                                          its `note` and with its `why`'s dollar figures taken out
--                                          (dropped when nothing is left), as {needs: [...]}. Null
--                                          stays null.
--   forms_read                             the office reads every form, as before; anyone else reads
--                                          directly only a form with NO playbook (a crew checklist).
--   public.form_playbooks                  every form of the company, the playbook as written for
--                                          the office and without its money for anyone else: the
--                                          read a crew lead's walk-through (and a tech's view of it)
--                                          uses for a sheet.
--   A column revoke (part B's shape) would have broken every office read of forms.playbook across
--   the app (settings, the playbook editor, the estimate builder); the office's reads are unchanged
--   here, which is why this part is a row rule plus a view instead.
--
-- ── D. A LEAD STAYS IN THE OFFICE (checked, not changed) ────────────────────────────────────
--
-- The lead's second finding, "every lead's name, phone and message is readable by any tech", is
-- 0034's original org-wide inquiries_read. 0056 already made that read staff-only, and the test
-- database (a mirror of production's policies) confirms it: a tech reads no lead at all, the one on
-- his own visit included. So nothing is widened or narrowed here; the check below fails this
-- migration if any permissive read policy on inquiries ever lets a non-staff person in, and the DB
-- suite proves it with a tech's session.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────────────────────
--   ADD COLUMN (nullable, or with a constant default): catalog only, ACCESS EXCLUSIVE for an instant
--   on jobs, quotes, invoices. The foreign key on jobs.hold_by: SHARE ROW EXCLUSIVE on jobs and
--   profiles while every existing row (all null) is checked. CREATE TRIGGER on jobs: SHARE ROW
--   EXCLUSIVE for an instant. REVOKE/GRANT on appointments and the forms policy swap: brief catalog
--   locks. lock_timeout 5s / statement_timeout 15s: a busy table fails fast and changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '15s';

-- ── A. the columns ──────────────────────────────────────────────────────────────────────────

alter table public.jobs
  add column if not exists hold_until date,
  add column if not exists hold_by uuid constraint jobs_hold_by_fkey references public.profiles(id) on delete set null;

alter table public.quotes add column if not exists follow_up_at date;

alter table public.invoices add column if not exists due_date_by_hand boolean not null default false;

comment on column public.jobs.hold_until is
  'The day a job on hold comes back to Needs You with its reason (0366). Set when the job goes on hold (a week out in the company''s timezone unless someone picks a day), moved by Snooze, cleared when the job comes off hold by any door (jobs_hold_day). Null on a held job only for one held before 0366: that reads as due now.';
comment on column public.jobs.hold_by is
  'Who put the job on hold (0366). Written by jobs_hold_day from the signed-in person; a client never sets it. Cleared when the job comes off hold.';
comment on column public.quotes.follow_up_at is
  'The day to follow up on an estimate the customer has not answered (0366). Only the follow-up; valid_until is the customer''s offer window and never moves with it.';
comment on column public.invoices.due_date_by_hand is
  'True when a person typed this invoice''s due date (0366), so sending it keeps that date instead of restamping one from the payment terms.';

-- ── A. jobs_hold_day ────────────────────────────────────────────────────────────────────────

create or replace function public.jobs_hold_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.status = 'on_hold' then
    if tg_op = 'INSERT' or old.status is distinct from new.status then
      -- Entering hold: a day it comes back (a week out unless the writer picked one), and who held it.
      -- The company's clock is read only here (number_jobs stamps org_id on insert, and may run after
      -- this trigger, so the signed-in person's company stands in when it is still null).
      if new.hold_until is null then
        new.hold_until := (now() at time zone public.split_org_tz(coalesce(new.org_id, public.auth_org_id())))::date + 7;
      end if;
      new.hold_by := coalesce(auth.uid(), new.hold_by);
    elsif auth.uid() is not null then
      -- Staying on hold: whoever held it stays the one who held it; the day is whatever was sent.
      new.hold_by := old.hold_by;
    end if;
  else
    -- Not on hold: nothing of a hold stays behind, whichever door took it off.
    new.hold_reason := null;
    new.hold_until := null;
    new.hold_by := null;
  end if;
  return new;
end
$fn$;

comment on function public.jobs_hold_day() is
  'EVERY WAIT HAS A DAY (0366). Entering hold: hold_until defaults to the company''s today + 7 (split_org_tz), hold_by is the signed-in person. Staying on hold: a signed-in writer never moves hold_by. Any other status: hold_reason, hold_until and hold_by are cleared, so every door that takes a job off hold clears it.';

create or replace trigger jobs_hold_day
  before insert or update on public.jobs
  for each row execute function public.jobs_hold_day();

-- ── B. answers_without_prices + appointment_answers ─────────────────────────────────────────

create or replace function public.answers_without_prices(p jsonb)
returns jsonb
language sql
immutable
as $fn$
  select coalesce(
    (select jsonb_object_agg(
              e.key,
              case jsonb_typeof(e.value)
                when 'array' then (
                  select coalesce(
                           jsonb_agg(case when jsonb_typeof(x.value) = 'object' then x.value - 'price' else x.value end order by x.ord),
                           '[]'::jsonb)
                    from jsonb_array_elements(e.value) with ordinality as x(value, ord))
                when 'object' then e.value - 'price'
                else e.value
              end)
       from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) as e(key, value)),
    '{}'::jsonb)
$fn$;

comment on function public.answers_without_prices(jsonb) is
  'A walk-through''s answers with every price taken out (0366): the exact mirror of answersWithoutPrices in src/lib/inspection/walkthrough-access.ts. Per top-level key, an array keeps its elements with price removed from each object element, an object loses its price, anything else is kept; not an object = {}.';

grant execute on function public.answers_without_prices(jsonb) to authenticated;

create or replace view public.appointment_answers
with (security_barrier = true)
as
select a.id,
       a.org_id,
       a.job_id,
       a.inquiry_id,
       a.starts_at,
       a.inspection_template_id,
       case
         when public.is_org_staff() then a.inspection_answers
         else public.answers_without_prices(a.inspection_answers)
       end as inspection_answers
  from public.appointments a
 where a.org_id = public.auth_org_id()
   and (public.is_org_staff() or a.assigned_to = auth.uid());

alter view public.appointment_answers owner to postgres;

comment on view public.appointment_answers is
  'THE ONLY READ OF WALK-THROUGH ANSWERS (0366). The office reads a visit''s inspection_answers as stored; anyone else (a tech or crew lead, on a visit assigned to him: 0227''s rule, restated here because the owner reads past RLS) reads them through answers_without_prices. appointments.inspection_answers itself is revoked from the signed-in role.';

-- READ-ONLY (the 0218 lesson). A view over one table is auto-updatable, Supabase's default
-- privileges hand anon AND authenticated every privilege on a new public relation, and a write
-- through this view runs as its owner, past appointments_write (office-only, 0227) and past RLS. So
-- everything comes off every role and only SELECT goes back to the signed-in role; then a trigger
-- refuses any write that still reaches the view (a later grant, or a role this file didn't name).
revoke all on public.appointment_answers from public, anon, authenticated;
grant select on public.appointment_answers to authenticated;

create or replace function public.refuse_view_write()
returns trigger
language plpgsql
as $fn$
begin
  raise exception '% is read-only (0366): write to the table itself, where its own rules apply.', tg_table_name
    using errcode = '42501';
end
$fn$;

comment on function public.refuse_view_write() is
  'INSTEAD OF trigger for a read-only view (0366): refuses every INSERT, UPDATE and DELETE through appointment_answers and form_playbooks with 42501, so a write can never run as the view owner past the table''s RLS.';

revoke all on function public.refuse_view_write() from public, anon, authenticated;

drop trigger if exists appointment_answers_read_only on public.appointment_answers;
create trigger appointment_answers_read_only
  instead of insert or update or delete on public.appointment_answers
  for each row execute function public.refuse_view_write();

-- The column comes off the signed-in role; every other live column goes back on. Built from the
-- live columns at apply time, so a column added before this runs is granted and one added after it
-- stays private until its own migration grants it.
revoke select on public.appointments from authenticated, anon;

do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
    into v_cols
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = 'appointments'
     and c.column_name <> 'inspection_answers';
  if v_cols is null then
    raise exception '0366: appointments has no columns to grant back. Nothing was changed.';
  end if;
  execute format('grant select (%s) on public.appointments to authenticated', v_cols);
end $$;

comment on column public.appointments.inspection_answers is
  'PRIVATE (0366): read it through appointment_answers. Revoked from the signed-in role: a scopes answer carries the office''s prices, and a tech may read his own visit (0227). Written by the office''s update and by save_walkthrough_capture (0356).';

-- ── C. playbook_without_money + forms_read + form_playbooks ─────────────────────────────────

create or replace function public.playbook_without_money(p jsonb)
returns jsonb
language sql
immutable
as $fn$
  select case
    when p is null or jsonb_typeof(p) = 'null' then p
    else jsonb_build_object(
      'needs',
      coalesce(
        (select jsonb_agg(
                  (n.need - 'note' - 'why')
                  || case when coalesce(n.why, '') = '' then '{}'::jsonb else jsonb_build_object('why', n.why) end
                  order by n.ord)
           from (
             select x.value as need,
                    x.ord,
                    -- withoutMoney(): the dollar figure (and a rate unit after it) out, then the
                    -- doubled spaces and the space before punctuation, then trimmed.
                    regexp_replace(
                      regexp_replace(
                        regexp_replace(
                          regexp_replace(
                            case when jsonb_typeof(x.value -> 'why') = 'string' then x.value ->> 'why' else '' end,
                            '\s*\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\y)?(?:\s?(?:/|per\s+)\s?[A-Za-z][A-Za-z.]*)?', '', 'g'),
                          '\s{2,}', ' ', 'g'),
                        '\s+([,.;:!?)])', '\1', 'g'),
                      '^\s+|\s+$', '', 'g') as why
               from jsonb_array_elements(
                      case
                        when jsonb_typeof(p) = 'array' then p
                        when jsonb_typeof(p -> 'needs') = 'array' then p -> 'needs'
                        else '[]'::jsonb
                      end) with ordinality as x(value, ord)
              where jsonb_typeof(x.value) = 'object'
           ) n),
        '[]'::jsonb))
  end
$fn$;

comment on function public.playbook_without_money(jsonb) is
  'A written playbook with no money in it (0366): the mirror of sheetsWithoutMoney in src/lib/inspection/walkthrough-access.ts. Returns {needs: [...]}, each need without its note and with its why''s dollar figures taken out (dropped when nothing is left). Null stays null.';

grant execute on function public.playbook_without_money(jsonb) to authenticated;

-- Live text before this: forms_read = org_id = auth_org_id() (0004). The office keeps exactly that.
drop policy if exists forms_read on public.forms;
create policy forms_read on public.forms
  for select using (
    org_id = public.auth_org_id()
    and (public.is_org_staff() or playbook is null)
  );

create or replace view public.form_playbooks
with (security_barrier = true)
as
select f.id,
       f.org_id,
       f.name,
       f.description,
       f.schema,
       f.active,
       f.is_inspection,
       f.is_public_intake,
       f.created_by,
       f.created_at,
       case
         when public.is_org_staff() then f.playbook
         else public.playbook_without_money(f.playbook)
       end as playbook
  from public.forms f
 where f.org_id = public.auth_org_id();

alter view public.form_playbooks owner to postgres;

comment on view public.form_playbooks is
  'Every form of the company, as the viewer may read it (0366). The office reads the playbook as written; anyone else reads it through playbook_without_money (no note, no dollar figure in a why). forms_read lets a non-office person read directly only a form with no playbook, so this is how a crew lead''s walk-through reads its sheet.';

-- READ-ONLY, like appointment_answers: without this a tech could delete or edit every form of his
-- company, or plant one in another company (no check option, and set_org_id keeps an org_id given).
revoke all on public.form_playbooks from public, anon, authenticated;
grant select on public.form_playbooks to authenticated;

drop trigger if exists form_playbooks_read_only on public.form_playbooks;
create trigger form_playbooks_read_only
  instead of insert or update or delete on public.form_playbooks
  for each row execute function public.refuse_view_write();

-- ── THE CHECKS ──────────────────────────────────────────────────────────────────────────────
do $chk$
declare
  v_names text;
begin
  -- The four columns.
  select string_agg(w.tbl || '.' || w.col, ', ') into v_names
    from (values ('jobs', 'hold_until'), ('jobs', 'hold_by'), ('quotes', 'follow_up_at'), ('invoices', 'due_date_by_hand')) as w(tbl, col)
   where not exists (
     select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = w.tbl and c.column_name = w.col);
  if v_names is not null then
    raise exception '0366: these columns are missing: %. Nothing was changed.', v_names;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jobs_hold_by_fkey' and conrelid = 'public.jobs'::regclass) then
    raise exception '0366: jobs.hold_by has no jobs_hold_by_fkey. Nothing was changed.';
  end if;

  -- The trigger: bound to its function, enabled, BEFORE, row-level, INSERT and UPDATE; the function
  -- a definer (split_org_tz is revoked from the signed-in role).
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.jobs'::regclass
       and t.tgname = 'jobs_hold_day'
       and t.tgfoid = 'public.jobs_hold_day()'::regprocedure
       and t.tgenabled <> 'D'
       and (t.tgtype & 1) = 1
       and (t.tgtype & 2) = 2
       and (t.tgtype & 4) = 4
       and (t.tgtype & 16) = 16
  ) then
    raise exception '0366: jobs_hold_day is not a BEFORE INSERT OR UPDATE row trigger on jobs. Nothing was changed.';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.jobs_hold_day()'::regprocedure) then
    raise exception '0366: jobs_hold_day is not security definer, so it cannot read the company''s timezone. Nothing was changed.';
  end if;

  -- The views.
  if to_regclass('public.appointment_answers') is null or to_regclass('public.form_playbooks') is null then
    raise exception '0366: appointment_answers or form_playbooks is missing. Nothing was changed.';
  end if;

  -- The mirrors say what the app's functions say.
  if public.answers_without_prices('{"s":[{"code":"R1","qty":1,"price":500}],"x":"y"}'::jsonb)
     is distinct from '{"s":[{"code":"R1","qty":1}],"x":"y"}'::jsonb then
    raise exception '0366: answers_without_prices does not take the price off a scope pick. Nothing was changed.';
  end if;
  if public.answers_without_prices('{"o":{"price":5,"code":"A"},"n":3,"t":["a",{"price":1}]}'::jsonb)
     is distinct from '{"o":{"code":"A"},"n":3,"t":["a",{}]}'::jsonb then
    raise exception '0366: answers_without_prices does not match answersWithoutPrices on objects and mixed arrays. Nothing was changed.';
  end if;
  if public.answers_without_prices(null) is distinct from '{}'::jsonb then
    raise exception '0366: answers_without_prices(null) is not an empty object. Nothing was changed.';
  end if;
  if public.playbook_without_money('{"needs":[{"key":"panel","label":"Panel","ask":"Brand?","why":"Zinsco or FPE turns a $400 circuit into a panel swap.","note":"Always $$$"},{"key":"x","label":"X","ask":"X?","why":"$90 per hr"}],"other":1}'::jsonb)
     is distinct from '{"needs":[{"key":"panel","label":"Panel","ask":"Brand?","why":"Zinsco or FPE turns a circuit into a panel swap."},{"key":"x","label":"X","ask":"X?"}]}'::jsonb then
    raise exception '0366: playbook_without_money leaves money in a why or a note. Nothing was changed.';
  end if;
  if public.playbook_without_money(null) is not null then
    raise exception '0366: playbook_without_money(null) is not null. Nothing was changed.';
  end if;

  -- The column is private; the rest of the row is not.
  if has_column_privilege('authenticated', 'public.appointments', 'inspection_answers', 'SELECT') then
    raise exception '0366: the signed-in role can still select appointments.inspection_answers. Nothing was changed.';
  end if;
  if has_column_privilege('anon', 'public.appointments', 'inspection_answers', 'SELECT') then
    raise exception '0366: anon can still select appointments.inspection_answers. Nothing was changed.';
  end if;
  if not has_column_privilege('authenticated', 'public.appointments', 'id', 'SELECT')
     or not has_column_privilege('authenticated', 'public.appointments', 'capture', 'SELECT')
     or not has_column_privilege('authenticated', 'public.appointments', 'inspection_template_id', 'SELECT') then
    raise exception '0366: the signed-in role lost a column it still needs on appointments. Nothing was changed.';
  end if;
  if not has_table_privilege('authenticated', 'public.appointment_answers', 'SELECT')
     or not has_table_privilege('authenticated', 'public.form_playbooks', 'SELECT') then
    raise exception '0366: the signed-in role cannot read appointment_answers or form_playbooks. Nothing was changed.';
  end if;
  -- Read-only, both ways: no write privilege for anyone signed in or anon, and a trigger behind it.
  select string_agg(format('%s %s %s', r.role, p.priv, v.name), ', ') into v_names
    from unnest(array['public.appointment_answers', 'public.form_playbooks']) as v(name)
    cross join unnest(array['authenticated', 'anon', 'public']) as r(role)
    cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
   where has_table_privilege(r.role, v.name, p.priv);
  if v_names is not null then
    raise exception '0366: a view can still be written through: %. Nothing was changed.', v_names;
  end if;
  select string_agg(v.name, ', ') into v_names
    from unnest(array['appointment_answers', 'form_playbooks']) as v(name)
   where not exists (
     select 1 from pg_trigger t
      where t.tgrelid = ('public.' || v.name)::regclass
        and t.tgname = v.name || '_read_only'
        and t.tgfoid = 'public.refuse_view_write()'::regprocedure
        and t.tgtype & 64 = 64      -- INSTEAD OF
        and t.tgtype & 28 = 28);    -- INSERT, DELETE and UPDATE
  if v_names is not null then
    raise exception '0366: these views have no read-only trigger: %. Nothing was changed.', v_names;
  end if;

  -- A function running as the signed-in person that names the column would start failing.
  select string_agg(p.oid::regprocedure::text, ', ') into v_names
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and not p.prosecdef
     and p.prosrc ilike '%inspection_answers%';
  if v_names is not null then
    raise exception '0366: these functions read appointments.inspection_answers as the signed-in person: %. Make them security definer or read appointment_answers. Nothing was changed.', v_names;
  end if;

  -- 0227's row rule and save_walkthrough_capture stand.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_select')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_write') then
    raise exception '0366: an appointments policy (0227) is missing. Nothing was changed.';
  end if;
  if to_regprocedure('public.save_walkthrough_capture(uuid, jsonb, uuid, jsonb)') is null then
    raise exception '0366: save_walkthrough_capture (0356) is missing. Nothing was changed.';
  end if;

  -- forms_read: the office reads everything, anyone else only a form with no playbook.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'forms' and policyname = 'forms_read' and cmd = 'SELECT'
       and qual ilike '%is_org_staff()%' and qual ilike '%playbook IS NULL%') then
    raise exception '0366: forms_read does not keep a playbook from a non-office reader. Nothing was changed.';
  end if;
  select string_agg(policyname, ', ') into v_names
    from pg_policies
   where schemaname = 'public' and tablename = 'forms' and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL')
     and policyname <> 'forms_read' and coalesce(qual, '') not ilike '%is_org_staff()%';
  if v_names is not null then
    raise exception '0366: another read policy on forms lets a non-office person read a playbook: %. Nothing was changed.', v_names;
  end if;

  -- D: a lead stays the office's (0056).
  select string_agg(policyname, ', ') into v_names
    from pg_policies
   where schemaname = 'public' and tablename = 'inquiries' and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL')
     and coalesce(qual, '') not ilike '%is_org_staff()%';
  if v_names is not null then
    raise exception '0366: a read policy on inquiries lets a non-office person read leads: %. Nothing was changed.', v_names;
  end if;
end $chk$;

notify pgrst, 'reload schema';
