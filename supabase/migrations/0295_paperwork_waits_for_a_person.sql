-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0295: paperwork waits for a person
--
-- Erik, 2026-09-24: photos in the Organize tray must NOT file a bill by themselves from a model
-- read. They wait, showing what was read, until a person presses File It. And Justin asked for a
-- box on Bills & Purchasing that takes PDFs, JPEGs and PNGs at once. Both are the same row: a
-- piece of paper that has been READ and not yet FILED. This migration gives that row the facts it
-- needs to be filed by a person, once, and undone.
--
--   doc_type        What the paper IS, as read (a person can correct it). NULL = not read yet.
--                   receipt / bill are the two kinds File It writes as a cost today. The others
--                   are recognised and said out loud ("not filed: this kind of paper goes in a
--                   later update") instead of being filed as something they are not.
--   doc_number      The number printed on it (ticket, invoice). Lands in bills.bill_number on
--                   File It, and is what "the same purchase is already on the books" is matched on.
--   content_sha256  The file's fingerprint, hashed in the browser before upload. The unique index
--                   below is the promise "the same FILE is never filed twice" made by the database
--                   rather than by a check a second tab could race past.
--   source          Which door it came in by: organize (the tray), bills_drop (Drop Paperwork),
--                   job (a receipt read on a job page). For the ops sweep, not for any rule.
--   proposal        What the reader SUGGESTS: the job the paper names, a business-cost bucket,
--                   its paper type, the supplier documents inside a CED PDF. A suggestion only;
--                   nothing reads it to write money.
--   pricing_provisional  The paper's prices are a counter preview (0271). Carried onto the bill
--                   when a person files it, so re-filing from the tray no longer drops it.
--   tied_bill_id / tied_supplier_invoice_id
--                   "Same Purchase: Tie Them". The paper is filed AGAINST something already on the
--                   books and made nothing new. Separate from bill_id ON PURPOSE: every teardown in
--                   organize/actions.ts deletes bill_id, and a tie must never delete a bill it did
--                   not make.
--
-- RLS: unchanged. organized_items keeps 0201's staff-or-own-row policies; the new columns ride
-- them. Files keep landing under <org>/organize/ (0213's staff-only prefix).
--
-- ORDER: after 0294. Apply BEFORE the code that writes these columns deploys (the code tolerates a
-- missing column on read, and on the reader's write it retries without the new columns, but a
-- File It on a paper read before this migration has no number to match on).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.organized_items
  add column if not exists doc_type text,
  add column if not exists doc_number text,
  add column if not exists content_sha256 text,
  add column if not exists source text not null default 'organize',
  add column if not exists proposal jsonb,
  add column if not exists pricing_provisional boolean not null default false,
  add column if not exists tied_bill_id uuid references public.bills(id) on delete set null,
  add column if not exists tied_supplier_invoice_id uuid references public.supplier_invoices(id) on delete set null;

alter table public.organized_items drop constraint if exists organized_items_doc_type_check;
alter table public.organized_items add constraint organized_items_doc_type_check
  check (doc_type is null or doc_type in (
    'receipt', 'bill', 'not_a_cost', 'supplier_documents',
    'statement', 'credit_memo', 'purchase_order', 'other'
  ));

alter table public.organized_items drop constraint if exists organized_items_source_check;
alter table public.organized_items add constraint organized_items_source_check
  check (source in ('organize', 'bills_drop', 'job'));

alter table public.organized_items drop constraint if exists organized_items_sha_check;
alter table public.organized_items add constraint organized_items_sha_check
  check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');

-- THE SAME FILE, ONCE PER COMPANY. Partial, so every row from before this (no fingerprint) and
-- every typed note (no file) is untouched.
create unique index if not exists organized_items_one_file_per_org
  on public.organized_items (org_id, content_sha256)
  where content_sha256 is not null;

-- "Is this number already on the books?" is asked on every File It.
create index if not exists organized_items_doc_number_idx
  on public.organized_items (org_id, doc_number)
  where doc_number is not null;
create index if not exists bills_bill_number_idx
  on public.bills (org_id, bill_number)
  where bill_number is not null;

comment on column public.organized_items.proposal is
  'What the reader suggests (paper type, job named on the paper, bucket, CED documents inside). A suggestion only: File It is pressed by a person and writes from the row, never from this (0295).';
comment on column public.organized_items.tied_bill_id is
  'Same Purchase: Tie Them. The paper is filed against a bill already on the books. Never torn down by a re-file or delete, because this row did not make that bill (0295).';
