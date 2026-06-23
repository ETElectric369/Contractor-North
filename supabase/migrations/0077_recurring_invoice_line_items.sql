-- Recurring invoices can carry LINE ITEMS (a service agreement billed itemized, like
-- a real invoice) instead of a single amount. Stored as a JSONB array of
-- {description, quantity, unit_price}. `amount` stays the cached subtotal (sum) for
-- listing + back-compat with single-amount templates that have no line_items.
alter table public.recurring_templates
  add column if not exists line_items jsonb;
