-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0399: the error sink triages itself
--
-- error_events (0101, renamed 0146) is the app's own error log: reportError() files every caught
-- failure through record_app_error, deduped on a key of where+message, and North reads it by hand
-- each session. On 2026-10-28 it held 93 rows, every one at level 'error', under statuses the
-- sink never defined (fixed 18 / triaged 70 / resolved 5), 53 of them Nort's voice-turn traces
-- filed as errors, with no column saying WHOSE company an error happened to, and a writer that
-- threw away what it had learned on every repeat: 0146's body REPLACED the payload, title and
-- culprit with the latest sighting and reset status to 'new' — so a triaged error came back to the
-- top on every occurrence, and the first sighting (the one that says how it began) was gone.
--
-- WHAT CHANGES (cn-v1136, "the error sink that triages itself"):
--
--   1. TWO COLUMNS. org_id (which company, nullable, set null when the company goes) so Bug Watch
--      can say "both companies hit this" from "only this one does"; last_payload, the LATEST
--      sighting, beside payload, which is now the FIRST and is never replaced.
--
--   2. TWO INDEXES. The open list (status = 'new', newest first) and the per-company list.
--
--   3. THE ROWS AS THEY STAND. 'resolved' becomes 'fixed' (the one word the sink uses); Nort's
--      trace rows (culprit client:nort-voice, title 'trace turn…') become level 'trace', which the
--      sweep retires after two weeks; a null level reads as 'error'.
--
--   4. THE WRITER, record_app_error, grows a sixth argument (p_org, default null, so the 5-argument
--      call the app makes until cn-v1136 still lands) and answers jsonb instead of void:
--        {id, inserted, reopened, escalated, event_count, level, status}
--      On a repeat: the count and last_seen move, last_payload takes the new sighting, payload
--      (the first) stays, org_id is kept once known, level is never downgraded (only 'blocker'
--      promotes — and the repeat that promotes an existing 'error' row is said as `escalated`, so
--      the first time a known error is a blocker pages, skeptic #42 S2), and status moves ONE way:
--      a 'fixed' error that returns is a regression and goes back to 'new'; 'new', 'triaged' and
--      'ignored' stay what North said they are. The row read before the upsert is locked FOR
--      UPDATE, so two concurrent sightings cannot both read 'fixed' and both say reopened (S3). A
--      p_org that names no organization lands as null, never a broken foreign key and a lost row
--      (S5). The 5-argument function is dropped first: with a default on p_org, keeping both would
--      make every call ambiguous. A level the app does not know lands as 'error'.
--
--   5. platform_set_error_status(id, status): Bug Watch's Mark Triaged / Fixed / Ignored / Reopen,
--      in platform_set_bug_status's shape (0354 §5): SECURITY DEFINER, the status column only, the
--      four statuses, North's own team only (is_platform_admin, 0176), checked inside.
--
--   6. sweep_error_events(): the nightly broom (service role only). A 'fixed' or 'ignored' row
--      ninety days after its last sighting, and a 'trace' row fourteen days after, are deleted;
--      a 'new' or 'triaged' error is never deleted whatever its age — an open error is open.
--
--   7. ONE READ POLICY, error_events_platform_read: a platform admin may SELECT. No insert, update
--      or delete policy: writes stay the two RPCs' and the service role's. RLS was already on.
--
-- LOCKS: error_events (ADD COLUMN + the foreign key: ACCESS EXCLUSIVE on error_events and SHARE
-- ROW EXCLUSIVE on organizations for a moment; 93 rows, no rewrite; CREATE INDEX: SHARE while it
-- builds, under a second). lock_timeout 3s: a busy table fails fast and changes nothing; run it
-- again. Twice-safe: every column, index, function, policy and data step is guarded or idempotent.
--
-- ORDER: after 0146 (the table's name), 0176 (platform_admins, is_platform_admin) and 0182 (the
-- revoke law this file follows: every SECURITY DEFINER function here carries its own revoke).
-- Apply BEFORE or AFTER the deploy: the old writer calls record_app_error with five named
-- arguments, which PostgREST resolves to this function with p_org defaulted; the new writer sends
-- six. Nothing reads the jsonb answer until cn-v1136, and that reader treats a void answer as
-- "filed, nothing more known".
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.error_events') is null then
    raise exception '0399: error_events (0101/0146) is not on this database. Nothing was changed.';
  end if;
  if to_regclass('public.organizations') is null then
    raise exception '0399: organizations is not on this database. Nothing was changed.';
  end if;
  if to_regclass('public.platform_admins') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0399: platform_admins / is_platform_admin() (0176) are not on this database. Apply 0176 first. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'error_events' and indexname = 'error_events_issue_uidx') then
    raise exception '0399: error_events_issue_uidx (0101/0146) is missing; the writer''s ON CONFLICT needs it. Nothing was changed.';
  end if;
end $$;

-- ── 1. whose company, and the latest sighting ───────────────────────────────────────────────────
alter table public.error_events add column if not exists org_id uuid references public.organizations(id) on delete set null;
alter table public.error_events add column if not exists last_payload jsonb;
comment on column public.error_events.org_id is
  'The company the error happened to, when the writer knew it (0399). Kept once known; set null when the company is deleted. Null = the platform itself, or not known.';
comment on column public.error_events.payload is
  'The FIRST sighting of this error, kept as it was filed (0399). Repeats land in last_payload.';
comment on column public.error_events.last_payload is
  'The LATEST sighting of this error (0399): null until the first repeat.';

-- ── 2. the open list, and the per-company list ──────────────────────────────────────────────────
-- The open list's index carries last_seen alone: its predicate already pins status (skeptic #42, N6).
create index if not exists error_events_new_idx on public.error_events (last_seen desc) where status = 'new';
create index if not exists error_events_org_idx on public.error_events (org_id, last_seen desc) where org_id is not null;

-- ── 3. the rows as they stand ───────────────────────────────────────────────────────────────────
update public.error_events set status = 'fixed' where status = 'resolved';
update public.error_events set level = 'trace' where level = 'error' and culprit = 'client:nort-voice' and title like 'trace turn%';
update public.error_events set level = 'error' where level is null;

-- ── 4. the writer: a repeat is counted, never rewritten; a fixed error that returns is new ───────
-- Dropped first: with p_org defaulted, a 5-argument sibling would make every call ambiguous.
drop function if exists public.record_app_error(text, text, text, text, jsonb);
create or replace function public.record_app_error(
  p_key text, p_title text, p_where text, p_level text, p_payload jsonb, p_org uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_level      text := case when p_level in ('error', 'blocker', 'trace') then p_level else 'error' end;
  v_prev       text;    -- the status before this sighting, so a regression can be said
  v_prev_level text;    -- the level before this sighting, so the first time it is a blocker can be said
  v_id         uuid;
  v_count      integer;
  v_now        text;
  v_status     text;
  v_inserted   boolean;
begin
  if p_key is not null then
    -- FOR UPDATE (skeptic #42, S3): without the lock two concurrent sightings of a 'fixed' row both
    -- read 'fixed', both upsert, and both answer reopened = true — two pages for one return. Locked,
    -- the loser waits for the winner's commit, re-reads the row as 'new', and answers false.
    select e.status, e.level into v_prev, v_prev_level from public.error_events e where e.issue_id = p_key for update;
  end if;
  -- org_id is resolved against organizations (S5): the client door cannot be trusted with a company,
  -- and a uuid that names no organization used to break the foreign key and lose the whole row.
  insert into public.error_events (issue_id, title, culprit, level, payload, org_id, event_count, status)
  values (p_key, left(coalesce(p_title, p_where, 'error'), 500), p_where, v_level, p_payload, (select o.id from public.organizations o where o.id = p_org), 1, 'new')
  on conflict (issue_id) where issue_id is not null
  do update set
    event_count  = public.error_events.event_count + 1,
    last_seen    = now(),
    last_payload = excluded.payload,
    org_id       = coalesce(public.error_events.org_id, excluded.org_id),
    level        = case when excluded.level = 'blocker' then 'blocker' else public.error_events.level end,
    status       = case when public.error_events.status = 'fixed' then 'new' else public.error_events.status end
  returning id, event_count, level, status, (xmax = 0)
       into v_id, v_count, v_now, v_status, v_inserted;
  -- escalated (S2): an existing row that was not a blocker and now is — the first time it pages.
  -- v_prev_level is NOT NULL on purpose: the loser of a concurrent first insert read no row at all
  -- (null) and must not page a second time for the winner's first sighting.
  return jsonb_build_object(
    'id',          v_id,
    'inserted',    v_inserted,
    'reopened',    coalesce(not v_inserted and v_prev = 'fixed' and v_status = 'new', false),
    'escalated',   coalesce(not v_inserted and v_prev_level is not null and v_prev_level <> 'blocker' and v_now = 'blocker', false),
    'event_count', v_count,
    'level',       v_now,
    'status',      v_status
  );
end $$;
comment on function public.record_app_error(text, text, text, text, jsonb, uuid) is
  'The app files one caught error (0102, 0146, 0399). Deduped on p_key: a repeat bumps event_count and last_seen, takes last_payload, keeps payload (the first sighting), keeps org_id once known (a p_org that is no organization lands as null), never lowers level (blocker promotes, said as escalated the first time), reopens a fixed error to new, and locks the row it reads so concurrent sightings answer once. Answers {id, inserted, reopened, escalated, event_count, level, status}. Service role only.';
revoke execute on function public.record_app_error(text, text, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.record_app_error(text, text, text, text, jsonb, uuid) to service_role;

-- ── 5. North's own team marks an error ───────────────────────────────────────────────────────────
create or replace function public.platform_set_error_status(p_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not public.is_platform_admin() then
    raise exception 'Only North''s own team can mark an error.' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('new', 'triaged', 'fixed', 'ignored') then
    raise exception 'That isn''t an error status.' using errcode = '22023';
  end if;
  update public.error_events set status = p_status where id = p_id;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;
comment on function public.platform_set_error_status(uuid, text) is
  'Bug Watch''s Mark Triaged / Fixed / Ignored / Reopen on an error, for North''s own team (0399). Status only; platform admins only (is_platform_admin, 0176), checked inside. Returns true when the error was there.';
revoke execute on function public.platform_set_error_status(uuid, text) from public, anon;
grant execute on function public.platform_set_error_status(uuid, text) to authenticated;

-- ── 6. the broom: closed errors after ninety days, traces after fourteen; open errors never ──────
create or replace function public.sweep_error_events()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed integer;
  v_trace  integer;
begin
  delete from public.error_events where status in ('fixed', 'ignored') and last_seen < now() - interval '90 days';
  get diagnostics v_closed = row_count;
  delete from public.error_events where level = 'trace' and last_seen < now() - interval '14 days';
  get diagnostics v_trace = row_count;
  return jsonb_build_object('closed_deleted', v_closed, 'trace_deleted', v_trace);
end $$;
comment on function public.sweep_error_events() is
  'The error sink''s broom (0399): deletes fixed/ignored rows ninety days after their last sighting and trace rows after fourteen. Never a new or triaged error, whatever its age. Answers {closed_deleted, trace_deleted}. Service role only (the cron).';
revoke execute on function public.sweep_error_events() from public, anon, authenticated;
grant execute on function public.sweep_error_events() to service_role;

-- ── 7. one read, for North's own team; writes stay the RPCs' ────────────────────────────────────
alter table public.error_events enable row level security;
-- The table privilege Supabase's defaults already hand out, said here so the policy cannot be dead
-- on a database built without them. The policy is the boundary; a tenant reads nothing.
grant select on public.error_events to authenticated;
drop policy if exists error_events_platform_read on public.error_events;
create policy error_events_platform_read on public.error_events for select to authenticated using (public.is_platform_admin());

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_fn text;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'error_events' and column_name = 'org_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'error_events' and column_name = 'last_payload') then
    raise exception '0399: org_id or last_payload is missing from error_events.';
  end if;
  if to_regprocedure('public.record_app_error(text, text, text, text, jsonb, uuid)') is null then
    raise exception '0399: the six-argument record_app_error is missing.';
  end if;
  if to_regprocedure('public.record_app_error(text, text, text, text, jsonb)') is not null then
    raise exception '0399: the five-argument record_app_error is still there; every call would be ambiguous.';
  end if;
  foreach v_fn in array array['public.record_app_error(text, text, text, text, jsonb, uuid)', 'public.platform_set_error_status(uuid, text)', 'public.sweep_error_events()'] loop
    if not exists (select 1 from pg_proc p where p.oid = v_fn::regprocedure and p.prosecdef and p.proconfig @> array['search_path=public']) then
      raise exception '0399: % is not security definer with its search_path pinned.', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception '0399: anon can call %.', v_fn;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.record_app_error(text, text, text, text, jsonb, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.sweep_error_events()', 'execute') then
    raise exception '0399: a signed-in person can call the writer or the broom.';
  end if;
  if not has_function_privilege('authenticated', 'public.platform_set_error_status(uuid, text)', 'execute') then
    raise exception '0399: a signed-in person cannot reach platform_set_error_status (it checks the admin inside).';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'error_events' and policyname = 'error_events_platform_read' and cmd = 'SELECT') then
    raise exception '0399: the error_events_platform_read policy is missing.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.error_events'::regclass) then
    raise exception '0399: row level security is off on error_events.';
  end if;
  if not has_table_privilege('authenticated', 'public.error_events', 'select') then
    raise exception '0399: authenticated cannot select error_events, so the platform read policy is dead.';
  end if;
  if exists (select 1 from public.error_events where status = 'resolved') then
    raise exception '0399: a row still says resolved.';
  end if;
  if exists (select 1 from public.error_events where level = 'error' and culprit = 'client:nort-voice' and title like 'trace turn%') then
    raise exception '0399: a Nort trace row is still at level error.';
  end if;
  if exists (select 1 from public.error_events where level is null) then
    raise exception '0399: a row has no level.';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'error_events' and indexname = 'error_events_new_idx')
     or not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'error_events' and indexname = 'error_events_org_idx') then
    raise exception '0399: error_events_new_idx or error_events_org_idx is missing.';
  end if;
  -- The open list's index is last_seen alone under its predicate (N6): an index of another shape
  -- under this name (an earlier draft) would be kept by IF NOT EXISTS and is said here, not hidden.
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'error_events' and indexname = 'error_events_new_idx'
                   and indexdef like '%(last_seen DESC) WHERE (status = ''new''::text)') then
    raise exception '0399: error_events_new_idx is not (last_seen desc) where status = ''new''.';
  end if;
  -- The writer answers escalated and locks the row it reads (S2, S3): the body on the database, not only the file.
  if position('escalated' in pg_get_functiondef('public.record_app_error(text, text, text, text, jsonb, uuid)'::regprocedure)) = 0
     or position('for update' in pg_get_functiondef('public.record_app_error(text, text, text, text, jsonb, uuid)'::regprocedure)) = 0 then
    raise exception '0399: record_app_error does not answer escalated or does not lock the row it reads.';
  end if;
  raise notice '0399: the error sink triages itself — a repeat is counted and kept, a fixed error that returns is new, North''s team marks and reads, the broom sweeps closed and trace rows.';
end $$;
