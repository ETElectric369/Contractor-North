-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0086: Estimate-first.
-- The default priced document is now an ESTIMATE (time & materials). You switch
-- a specific one to a fixed-price QUOTE per document (doc_type drives the label
-- everywhere — list, detail, printed PDF, email). Pairs with the app defaulting
-- new jobs to T&M billing.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.quotes alter column doc_type set default 'estimate';

-- Existing rows keep their current doc_type on purpose, so a deliberately-chosen
-- fixed-price Quote is never silently relabeled. To relabel everything that was
-- only auto-defaulted to 'quote' (before this change) as estimates, run ONCE,
-- deliberately:
--    update public.quotes set doc_type = 'estimate' where doc_type = 'quote';
