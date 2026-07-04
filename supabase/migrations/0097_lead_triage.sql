-- ─────────────────────────────────────────────────────────────────────────────
-- 0097 — Lead triage: qualify inbound leads (the Tahoe Deck deck-configurator front
-- door) as they land. A submitted bid becomes an inquiry carrying its readiness bucket
-- (A/B/C), the configured estimate total, whether the job is big enough to force a human
-- site inspection, a priority score, and the raw intake answers. The classification is
-- computed SERVER-SIDE (src/lib/lead-triage.ts) at the /api/inbound/lead endpoint so a
-- client can't game its way to an instant big-ticket price or a false priority.
--
-- Additive only. New columns default so existing manual/public_form inquiries are unaffected.
-- The per-org inbound secret + the site-inspection dollar threshold live in
-- organizations.settings (jsonb: lead_inbound_secret, site_inspection_threshold) — no schema.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.inquiries
  add column if not exists project_type            text,        -- new_deck | full_replacement | resurface | railing | stairs | extension | repair | staining | unsure
  add column if not exists lead_bucket             text,        -- A (ready) | B (measure) | C (consult)
  add column if not exists estimate_total          numeric(12,2),
  add column if not exists site_inspection_required boolean not null default false,
  add column if not exists priority                integer not null default 0,
  add column if not exists intake                  jsonb;       -- raw answers + the configured estimate lines

-- Keep the bucket honest (A/B/C or null for legacy/manual rows).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inquiries_lead_bucket_chk') then
    alter table public.inquiries
      add constraint inquiries_lead_bucket_chk check (lead_bucket is null or lead_bucket in ('A','B','C'));
  end if;
end $$;

-- The Leads board sorts hot-ready-big first, per org.
create index if not exists idx_inquiries_org_priority on public.inquiries (org_id, priority desc);
create index if not exists idx_inquiries_bucket on public.inquiries (org_id, lead_bucket);
