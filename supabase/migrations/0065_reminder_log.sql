-- Dedupe + cadence ledger for the opt-in customer reminders (the daily automations
-- cron). One row per reminder actually sent, so the engine can enforce "at most once
-- per N days" and a hard cap per document — a customer is never spammed daily.
-- Inserts come from the service-role cron (bypasses RLS); staff can read the trail.

create table if not exists public.reminder_log (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  kind       text not null,           -- invoice_due | quote_followup | appointment
  entity_id  uuid not null,           -- the invoice / quote / appointment id
  channel    text,                    -- email | sms
  sent_at    timestamptz not null default now()
);

create index if not exists reminder_log_lookup
  on public.reminder_log(org_id, kind, entity_id, sent_at desc);

alter table public.reminder_log enable row level security;

-- Staff can see what reminders went out for their org. No insert/update/delete
-- policy: the cron writes via the service role, and the trail stays immutable.
drop policy if exists reminder_log_read on public.reminder_log;
create policy reminder_log_read on public.reminder_log
  for select using (org_id = public.auth_org_id() and public.is_org_staff());
