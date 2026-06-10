-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0036: Organize My triage + overhead expenses
-- Receipts can be a job cost OR company overhead. Bills gain a category so a
-- bill with no job acts as an overhead expense (Fuel / Shop supplies / …).
-- organized_items gains a status: confident uploads auto-file; everything
-- else waits in a "Needs attention" tray. Run AFTER 0035.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.bills add column if not exists category text;

alter table public.organized_items
  add column if not exists status text not null default 'filed',  -- filed | needs_review
  add column if not exists bill_id uuid references public.bills(id) on delete set null;

create index if not exists organized_items_status_idx
  on public.organized_items(org_id, status);
