-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0096: task focus — pin a task into a day's six.
-- focus_date = the day a task is PINNED onto (today = "do this today"; the
-- night debrief writes tomorrow). A DATE, not a boolean, on purpose: pins
-- self-expire at midnight — yesterday's undone pin falls back into the ranked
-- pool instead of squatting a slot forever (the standing TTL law applied to
-- the pin itself; no sweeper cron). Additive + backward compatible (null =
-- never pinned, everything behaves as before).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.tasks
  add column if not exists focus_date date;

comment on column public.tasks.focus_date is
  'Pinned into this day''s six on My Day (null = not pinned). Self-expires: a past focus_date is just history, never a slot.';

-- My Day reads "my pins for today" per org every render — index the exact cut.
create index if not exists tasks_org_focus_idx on public.tasks(org_id, focus_date);
