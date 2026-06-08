-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0023: mileage on time entries
-- Tracks miles driven per time entry (for reimbursement / tax / job costing).
-- The per-mile rate lives in organizations.settings.mileage_rate. Run AFTER 0010.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.time_entries
  add column if not exists miles numeric(8,1) not null default 0;
