-- IDEMPOTENCY: the "Import quote / labor / costs" actions blindly appended
-- invoice_items, so clicking one twice double-billed. Tag each imported row with
-- its source so an import can REPLACE its own prior rows (re-running refreshes
-- the lines to the current total instead of duplicating them). NULL = a normal
-- hand-entered line, left untouched by imports.
alter table public.invoice_items add column if not exists import_source text;
