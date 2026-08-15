-- 0198 — THE RENDERED PDF, KEPT (Erik: "once the pdf is created and nothing has been edited …
-- store it instead of regenerating over and over again").
--
-- Every view of every document used to cold-boot chromium (~5s) and throw the bytes away
-- ("Cache-Control: no-store"). Now /api/pdf fingerprints the print page's HTML — the single
-- layout source — and serves the stored bytes when nothing changed. An edit, a payment, a logo
-- change, even a deploy all change the HTML, so invalidation needs no per-table knowledge and
-- can never serve a stale total. Erik's editing loop keeps regenerating exactly as before,
-- because editing changes the fingerprint.
--
-- SERVICE-ROLE ONLY, both halves. RLS enabled with NO policies on the table, and a private
-- bucket with no storage policies: the bytes carry money + customer PII, and the ONLY doors are
-- /api/pdf (staff-gated) and the share-token door (which streams to the customer the token
-- names, and nobody else). A signed URL would be a second, unrevocable door — we stream instead.

insert into storage.buckets (id, name, public)
values ('doc-pdfs', 'doc-pdfs', false)
on conflict (id) do nothing;

create table if not exists public.doc_pdf_cache (
  doc text not null,
  doc_id uuid not null,
  margin numeric not null,
  -- sha-256 of the print page HTML this copy was rendered from.
  fingerprint text not null,
  path text not null,
  -- The doc's STATUS when this copy was rendered. The customer door refuses a copy whose
  -- stored status no longer matches (draft-era copies, overdue flips, quote acceptances);
  -- the staff door ignores it (its fingerprint check is stronger).
  doc_status text not null default '',
  org_id uuid not null references public.organizations(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (doc, doc_id, margin)
);

alter table public.doc_pdf_cache enable row level security;
-- Deliberately NO policies: anon/authenticated see nothing; only the service role reads or
-- writes, from inside the two routes named above.

comment on table public.doc_pdf_cache is
  'One stored PDF per document+margin (0198). fingerprint = sha256 of the /print HTML; a mismatch means re-render. Service-role only.';
