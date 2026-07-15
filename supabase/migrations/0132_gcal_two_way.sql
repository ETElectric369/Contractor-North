-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0132: two-way Google Calendar sync
--
-- OWNERSHIP RULE (Erik, 2026-07): CN records (jobs/appointments) are CN-owned —
-- pushed to Google tagged extendedProperties.private.cn="1"; a Google-side edit
-- gets re-pushed over on the next sync. Google events from HIS calendars are
-- Google-owned — mirrored READ-ONLY into external_events for the schedule
-- display, never editable in CN. No bidirectional editing of one record.
--
--   • appointments.google_event_id — appointments push to Google like jobs
--     already do (0038 gave jobs theirs).
--   • external_events — the read-only mirror of the org's selected Google
--     calendars, written ONLY by the sync cron (service role).
--   • calendar_connections gains the pull config: which calendars to mirror,
--     the per-calendar incremental sync tokens, and the last sweep time.
--
-- Run AFTER 0131.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.appointments add column if not exists google_event_id text;

-- ── The Google→CN mirror ────────────────────────────────────────────────────
create table if not exists public.external_events (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid references public.organizations(id) on delete cascade,
  google_calendar_id text not null,
  google_event_id    text not null,
  title              text,
  starts_at          timestamptz,
  ends_at            timestamptz,
  all_day            boolean not null default false,
  updated_at         timestamptz not null default now()
);
-- Upsert key: one row per (org, calendar, event) — incremental syncs update in place.
create unique index if not exists external_events_org_cal_event_uidx
  on public.external_events(org_id, google_calendar_id, google_event_id);
-- The calendar-panel range read.
create index if not exists external_events_org_time_idx
  on public.external_events(org_id, starts_at);

alter table public.external_events enable row level security;

-- Org-member READ (the schedule shows the mirror to everyone in the org);
-- NO insert/update/delete policies — writes are service-role only (the sync
-- cron), same posture as sentry_events. A user client can never fabricate or
-- edit a mirrored event, which is what keeps the mirror trustworthy.
drop policy if exists external_events_read on public.external_events;
create policy external_events_read on public.external_events
  for select using (org_id = public.auth_org_id());

-- ── Pull config on the existing connection row ─────────────────────────────
-- selected_calendars: jsonb array of Google calendar ids to mirror.
-- sync_tokens: jsonb map { "<calendarId>": { "token": "...", "at": "<iso>" } } —
--   per-calendar incremental tokens (410 GONE or a stale baseline forces a
--   fresh full window).
alter table public.calendar_connections
  add column if not exists selected_calendars jsonb not null default '[]'::jsonb,
  add column if not exists sync_tokens jsonb not null default '{}'::jsonb,
  add column if not exists last_synced_at timestamptz;
