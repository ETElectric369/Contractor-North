-- PARITY: quotes.doc_type defaults to 'quote' on production. Migration 0086_estimate_default.sql
-- sets it to 'estimate', but 0086 was never applied to production. Production is the truth the
-- tests must mirror, so the test database takes production's default here. Erik decides later which
-- default is right; the app always sends doc_type, so today only a row written without it differs.
-- If that decision lands as a migration, delete this file and rebuild with --reset.

alter table public.quotes alter column doc_type set default 'quote';
