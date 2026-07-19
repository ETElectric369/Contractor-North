-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0137: the customer-facing document word
-- (Estimate | Quote), per document.
--
-- Investigation result: the planned quotes.doc_label column ALREADY exists as
-- quotes.doc_type — 0047 added it (text not null, check in ('estimate','quote')),
-- 0086 flipped the default to 'estimate' — and every customer-facing surface
-- (print/PDF title, the public /q page heading + accept copy, email subject/body,
-- SMS) already words itself from it. A second doc_label column would be a mirror
-- of the same word: two sources of truth, guaranteed drift.
--
-- So this migration adds NO schema — it formalizes the contract instead:
-- doc_type IS the customer-facing document label, and display strings derive
-- through the one pure helper docLabel() (src/lib/doc-label.ts). Internal app
-- nav/labels stay "Estimates"; this word is document-facing only.
-- ═══════════════════════════════════════════════════════════════════════════

comment on column public.quotes.doc_type is
  'The customer-facing document word: ''estimate'' (T&M — the default) or ''quote'' (fixed price). Drives the print/PDF title, the public /q page heading + accept-button copy, and email/SMS subject + body lines. Internal app nav stays "Estimates". Derive every display string via docLabel() in src/lib/doc-label.ts — never inline the ternary.';
